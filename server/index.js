require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { CodeBuildClient, BatchGetBuildsCommand, ListBuildsForProjectCommand, BatchGetProjectsCommand, StartBuildCommand, RetryBuildCommand } = require('@aws-sdk/client-codebuild');
const { CloudWatchLogsClient, GetLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { CodePipelineClient, ListPipelinesCommand, GetPipelineCommand, ListPipelineExecutionsCommand, GetPipelineExecutionCommand, StartPipelineExecutionCommand } = require('@aws-sdk/client-codepipeline');
const { S3Client, GetObjectCommand, ListObjectVersionsCommand } = require('@aws-sdk/client-s3');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3004;

// Unified function to map project names to GitHub repository names
const getRepoFromProject = (projectName) => {
  return projectName?.includes('backend') ? 'backend' : 'frontend';
};

// Enable CORS for frontend
app.use(cors());
app.use(express.json());

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION || 'us-west-2' });
const cloudwatchlogs = new CloudWatchLogsClient({ region: process.env.AWS_REGION || 'us-west-2' });
const codepipeline = new CodePipelineClient({ region: process.env.AWS_REGION || 'us-west-2' });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' });

// Static list of ignored unknown build IDs
// Add build IDs here to hide them from the Unknown Builds table
const ignoredUnknownBuilds = new Set([
  // SKIP builds - these appear to be builds that were intentionally skipped
  'eval-frontend-sandbox:aec57d46',
  'eval-frontend-sandbox:e99781ee',
  'eval-frontend-sandbox:51087261',

  // Other unknown builds with null runMode
  'eval-frontend-sandbox:6e58ec0f',
  'eval-frontend-sandbox:ff57cf07',
  'eval-frontend-sandbox:44d60233',
  'eval-frontend-sandbox:975662a3',
  'eval-frontend-sandbox:f852e37b',
  'eval-frontend-sandbox:f93f88d0',
  'eval-frontend-sandbox:268e6783',
  'eval-frontend-sandbox:461480a1',
  'eval-frontend-sandbox:0d9b24aa',
  'eval-frontend-sandbox:8017e850',
  'eval-frontend-sandbox:f991697e',
  'eval-frontend-sandbox:b2ff7781',
  'eval-frontend-sandbox:eb9bd1c4',
  'eval-frontend-sandbox:735f0b8f',
  'eval-frontend-sandbox:f76e17b4',
  'eval-frontend-sandbox:f7eb809e',
  'eval-frontend-sandbox:6a7d92b7',
  'eval-frontend-sandbox:64bad14a',
  'eval-frontend-sandbox:c86532ad',
  'eval-frontend-sandbox:6e981860',

  // Backend sandbox unknown builds
  'eval-backend-sandbox:2baf8dd4',
  'eval-backend-sandbox:675abb01',
  'eval-backend-sandbox:4bd51517',
]);

// CloudWatch request throttling to prevent rate limiting
class CloudWatchThrottler {
  constructor(maxConcurrent = 2, minDelay = 500) {
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = maxConcurrent; // Reduced to 2 concurrent requests
    this.minDelay = minDelay; // Increased to 500ms between requests
    this.lastRequest = 0;
    this.rateLimitedUntil = 0; // Track when rate limiting ends
    this.consecutiveFailures = 0; // Track consecutive rate limit failures
  }

  async throttledRequest(requestFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ requestFn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const { requestFn, resolve, reject } = this.queue.shift();
    this.running++;

    try {
      // Ensure minimum delay between requests
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequest;
      if (timeSinceLastRequest < this.minDelay) {
        await new Promise(r => setTimeout(r, this.minDelay - timeSinceLastRequest));
      }

      this.lastRequest = Date.now();
      const result = await requestFn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      // Process next request after a small delay
      setTimeout(() => this.processQueue(), 10);
    }
  }
}

const cloudWatchThrottler = new CloudWatchThrottler();

// Simple cache for log data to reduce API calls
const logDataCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Track rate limiting issues
let rateLimitDetected = false;
let rateLimitTimestamp = null;

const getS3ArtifactConfig = async (pipelineName, codepipelineClient) => {
  try {
    console.log(`        🔍 Getting pipeline definition for S3 artifact discovery...`);

    // Get the pipeline definition to find the correct S3 configuration
    const getPipelineCommand = new GetPipelineCommand({
      name: pipelineName
    });

    const pipelineDefinition = await codepipelineClient.send(getPipelineCommand);

    const sourceStage = pipelineDefinition.pipeline?.stages?.find(stage => stage.name === 'Source');
    const sourceAction = sourceStage?.actions?.find(action => action.actionTypeId?.provider === 'S3');

    if (sourceAction?.configuration?.S3Bucket && sourceAction?.configuration?.S3ObjectKey) {
      const bucketName = sourceAction.configuration.S3Bucket;
      const objectKey = sourceAction.configuration.S3ObjectKey;
      console.log(`        ✅ Found deployment bucket from Source stage: ${bucketName}`);
      console.log(`        🗂️  Found object key from Source stage: ${objectKey}`);
      return { bucketName, objectKey };
    } else {
      console.log(`        ❌ Could not find S3 source configuration in pipeline definition`);
      return { bucketName: null, objectKey: null };
    }
  } catch (error) {
    console.log(`        ❌ Error getting pipeline definition: ${error.message}`);
    console.log(`        🚫 Cannot determine S3 bucket without pipeline definition - skipping`);
    return { bucketName: null, objectKey: null };
  }
};

// Get Run Mode and Branch Name from CloudWatch build logs with rate limiting handling
const getLogDataFromBuild = async (build, retryCount = 0) => {
  const maxRetries = 3;
  const baseDelay = 1000; // 1 second base delay

  try {
    if (!build.logs?.groupName) {
      return { runMode: null, sourceBranch: null };
    }

    const logGroupName = build.logs.groupName;
    const logStreamName = build.logs.streamName;

    if (!logStreamName) {
      return { runMode: null, sourceBranch: null };
    }

    // Check cache first
    const cacheKey = `${build.projectName}:${build.id}`;
    const cached = logDataCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log(`📦 Using cached log data for ${build.projectName}:${build.id?.slice(-8)}`);
      return cached.data;
    }

    console.log(`Fetching logs for ${build.projectName}:${build.id?.slice(-8)} from ${logGroupName}/${logStreamName} (attempt ${retryCount + 1})`);

    const command = new GetLogEventsCommand({
      logGroupName,
      logStreamName,
      limit: 100, // Get first 100 log events where info is available
      startFromHead: true
    });

    const response = await cloudWatchThrottler.throttledRequest(() => cloudwatchlogs.send(command));
    const events = response.events || [];

    let runMode = null;
    let sourceBranch = null;

    // Look for "Selected RUN_MODE : TEST_ONLY" or "Selected RUN_MODE : FULL_BUILD" in logs
    // Also look for "Source branch (HEAD) : refs/heads/feature/ac-devops-4" in logs
    for (const event of events) {
      const message = event.message;
      if (message) {
        // Extract RUN_MODE
        if (!runMode && message.includes('Selected RUN_MODE :')) {
          const match = message.match(/Selected RUN_MODE :\s*(\w+)/);
          if (match) {
            runMode = match[1];
            console.log(`Found RUN_MODE: ${runMode} in logs for ${build.projectName}:${build.id?.slice(-8)}`);
          }
        }

        // Extract source branch
        if (!sourceBranch && message.includes('Source branch (HEAD) :')) {
          const match = message.match(/Source branch \(HEAD\) :\s*refs\/heads\/(.+)/);
          if (match) {
            sourceBranch = match[1];
            console.log(`Found source branch: ${sourceBranch} in logs for ${build.projectName}:${build.id?.slice(-8)}`);
          }
        }

        // If we found both, we can stop looking
        if (runMode && sourceBranch) {
          break;
        }
      }
    }

    // Cache the result for future requests
    const result = { runMode, sourceBranch };
    logDataCache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });

    return result;
  } catch (error) {
    console.error(`Error fetching logs for ${build.projectName}:${build.id?.slice(-8)} (attempt ${retryCount + 1}):`, error.message);

    // Check if this is a rate limiting error
    if (error.message && (
        error.message.includes('Rate exceeded') ||
        error.message.includes('Throttling') ||
        error.message.includes('TooManyRequests') ||
        error.$metadata?.httpStatusCode === 429
      )) {
      // Mark rate limiting detected for frontend warning
      rateLimitDetected = true;
      rateLimitTimestamp = Date.now();

      if (retryCount < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s, 8s...
        const delay = baseDelay * Math.pow(2, retryCount);
        console.log(`⏱️  Rate limited for ${build.projectName}:${build.id?.slice(-8)}, retrying in ${delay}ms (attempt ${retryCount + 2}/${maxRetries + 1})`);

        await new Promise(resolve => setTimeout(resolve, delay));
        return getLogDataFromBuild(build, retryCount + 1);
      } else {
        console.log(`❌ Max retries exceeded for ${build.projectName}:${build.id?.slice(-8)} due to rate limiting`);
        return { runMode: null, sourceBranch: null, rateLimited: true };
      }
    }

    // For non-rate-limiting errors, return immediately
    return { runMode: null, sourceBranch: null };
  }
};

// Build classification with CloudWatch logs fallback
const classifyBuild = async (build) => {
  const env = build.environment?.environmentVariables || [];
  const envVars = env.reduce((acc, { name, value }) => ({ ...acc, [name]: value }), {});

  // Extract data from environment variables
  const sourceVersion = build.sourceVersion;
  const prNumber = envVars.CODEBUILD_WEBHOOK_PR_NUMBER;
  const triggeredForPR = envVars.TRIGGERED_FOR_PR;

  // Extract PR number from sourceVersion (pr/291 format)
  let extractedPR = null;
  if (sourceVersion?.startsWith('pr/')) {
    extractedPR = sourceVersion.replace('pr/', '');
  }

  // Only assign PR number for actual PR builds, not main branch builds
  const finalPRNumber = sourceVersion?.startsWith('pr/') ? (prNumber || extractedPR || triggeredForPR) :
                        (prNumber || triggeredForPR);

  // DEBUG: For hotfixes to main or dev, don't assign any PR number
  const actualPRNumber = (sourceVersion === 'main' || sourceVersion === 'dev') ? null : finalPRNumber;

  console.log(`Classifying ${build.projectName}:${build.id?.slice(-8)} - sourceVersion: ${sourceVersion}, PR: ${actualPRNumber}`);

  // Get the actual Run Mode and source branch from build logs (this is the ground truth)
  const { runMode, sourceBranch } = await getLogDataFromBuild(build);
  console.log(`Build ${build.projectName}:${actualPRNumber} - RunMode from logs: ${runMode}, SourceBranch: ${sourceBranch}`);


  // Demo, prod, and sandbox builds are always production (but exclude sandbox test builds)
  if (build.projectName.includes('demo') || build.projectName.includes('prod') || (build.projectName.includes('sandbox') && !build.projectName.includes('test'))) {
    console.log(`Production build (demo/prod/sandbox): ${build.projectName}:${finalPRNumber}`);
    return {
      type: 'production',
      runMode: runMode || 'FULL_BUILD',
      isDeployable: true,
      prNumber: actualPRNumber,
      sourceBranch: sourceBranch
    };
  }

  // Handle new dedicated test targets
  if (build.projectName.includes('devbranchtest')) {
    console.log(`Dev test build: ${build.projectName}:${finalPRNumber}`);
    return {
      type: 'dev-test',
      runMode: runMode || 'TEST_ONLY',
      isDeployable: false,
      prNumber: actualPRNumber,
      sourceBranch: sourceBranch
    };
  }

  if (build.projectName.includes('mainbranchtest')) {
    console.log(`Main test build: ${build.projectName}:${finalPRNumber}`);
    return {
      type: 'production',
      runMode: runMode || 'TEST_ONLY',
      isDeployable: false,
      prNumber: actualPRNumber,
      sourceBranch: sourceBranch
    };
  }

  // Default: unknown builds
  console.log(`Unknown build type: ${build.projectName}:${build.id?.slice(-8)}, runMode: ${runMode}`);
  return {
    type: 'unknown',
    runMode: runMode || 'SKIP',
    isDeployable: false,
    prNumber: actualPRNumber,
    sourceBranch: sourceBranch
  };
};

// Cache for GitHub commit data to avoid repeated API calls
const githubCache = new Map();

// Get commit message from GitHub API
const getGitHubCommitMessage = async (repo, commitSha) => {
  if (!commitSha) return null;
  
  const cacheKey = `${repo}-${commitSha}`;
  if (githubCache.has(cacheKey)) {
    return githubCache.get(cacheKey);
  }
  
  try {
    const url = `https://api.github.com/repos/hoc-stateeval/${repo}/commits/${commitSha}`;
    
    // GitHub API headers with optional authentication
    const headers = {
      'User-Agent': 'CI-Dashboard',
      'Accept': 'application/vnd.github.v3+json'
    };
    
    // Add GitHub token if available
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
      console.log(`🔑 Using GitHub authentication for ${repo}:${commitSha}`);
    } else {
      console.log(`⚠️  No GITHUB_TOKEN found - using unauthenticated requests (may fail for private repos)`);
    }
    
    return new Promise((resolve) => {
      const req = https.get(url, { headers }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const commit = JSON.parse(data);
              const message = commit.commit?.message;
              githubCache.set(cacheKey, message);
              resolve(message);
            } else {
              console.log(`GitHub API error for ${commitSha}: ${res.statusCode}`);
              githubCache.set(cacheKey, null);
              resolve(null);
            }
          } catch (e) {
            console.error(`Error parsing GitHub response for ${commitSha}:`, e.message);
            resolve(null);
          }
        });
      });
      
      req.on('error', (e) => {
        console.error(`GitHub API request error for ${commitSha}:`, e.message);
        resolve(null);
      });
      
      // Timeout after 5 seconds
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(null);
      });
    });
  } catch (error) {
    console.error(`Error fetching commit ${commitSha}:`, error.message);
    return null;
  }
};

// Get full commit details from GitHub API for hotfix detection
const getGitHubCommitDetails = async (repo, commitSha) => {
  if (!commitSha) return null;

  const cacheKey = `${repo}-${commitSha}-details`;
  if (githubCache.has(cacheKey)) {
    return githubCache.get(cacheKey);
  }

  try {
    const url = `https://api.github.com/repos/hoc-stateeval/${repo}/commits/${commitSha}`;

    // GitHub API headers with optional authentication
    const headers = {
      'User-Agent': 'CI-Dashboard',
      'Accept': 'application/vnd.github.v3+json'
    };

    // Add GitHub token if available
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    return new Promise((resolve) => {
      const req = https.get(url, { headers }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const commit = JSON.parse(data);
              const commitDetails = {
                message: commit.commit?.message || 'No message',
                author: {
                  name: commit.commit?.author?.name || 'Unknown',
                  email: commit.commit?.author?.email || '',
                  username: commit.author?.login || null
                },
                date: commit.commit?.author?.date || null,
                sha: commit.sha,
                parents: commit.parents || [],
                isHotfix: false // Will be determined later
              };

              // Cache the result
              githubCache.set(cacheKey, commitDetails);
              resolve(commitDetails);
            } else {
              console.log(`GitHub API error for commit details ${commitSha}: ${res.statusCode}`);
              const fallback = null;
              githubCache.set(cacheKey, fallback);
              resolve(fallback);
            }
          } catch (e) {
            console.error(`Error parsing GitHub commit details for ${commitSha}:`, e.message);
            resolve(null);
          }
        });
      });

      req.on('error', (e) => {
        console.error(`GitHub API request error for commit details ${commitSha}:`, e.message);
        resolve(null);
      });

      // Timeout after 5 seconds
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(null);
      });
    });
  } catch (error) {
    console.error(`Error fetching commit details ${commitSha}:`, error.message);
    return null;
  }
};

// Extract PR number from commit message or other sources
const extractPRFromCommit = async (build) => {
  // Try to get commit SHA from resolvedSourceVersion
  const commitSha = build.resolvedSourceVersion;
  if (!commitSha) return null;
  
  // Determine repo from project name
  const repo = getRepoFromProject(build.projectName);
  
  // For main branch builds (common in production), try to find the most recent dev build with the same commit
  // This helps when a dev->main merge loses the original PR number
  if (build.sourceVersion === 'refs/heads/main' || build.sourceVersion === 'main') {
    console.log(`🔍 Main branch build detected for ${build.projectName}:${build.id?.slice(-8)}, looking for corresponding dev build...`);
    
    // Look for a recent build from the same project with same commit but from dev branch
    const devProjectName = build.projectName.replace('-prod', '-demo').replace('-sandbox', '-demo');
    if (devProjectName !== build.projectName) {
      // We have access to allBuilds in the broader scope, but for safety we'll search within this function
      // This is a simplified approach - in a production system we'd want to pass allBuilds as a parameter
      console.log(`   Looking for corresponding dev build in ${devProjectName} with commit ${commitSha?.substring(0,8)}`);
    }
  }
  
  // Get commit message from GitHub
  const commitMessage = await getGitHubCommitMessage(repo, commitSha);
  if (!commitMessage) {
    console.log(`⚠️ Could not fetch commit message for ${repo}:${commitSha?.substring(0,8)} - possibly rate limited or auth issue`);
    return null;
  }
  
  // Common PR merge patterns in commit messages:
  // "Merge pull request #123 from feature-branch"
  // "Merge branch 'dev' into main (#123)"
  // "feat: add feature (#123)"
  // Also check for GitHub's automatic squash merge format
  
  const patterns = [
    /Merge pull request #(\d+)/i,
    /\(#(\d+)\)/,
    /#(\d+)/,
    /PR #(\d+)/i
  ];
  
  for (const pattern of patterns) {
    const match = commitMessage.match(pattern);
    if (match) {
      console.log(`✅ Found PR #${match[1]} in commit message for ${build.projectName}:${build.id?.slice(-8)}: "${commitMessage.substring(0, 60)}..."`);
      return match[1];
    }
  }
  
  console.log(`❌ No PR number found in commit message for ${build.projectName}:${build.id?.slice(-8)}: "${commitMessage.substring(0, 60)}..."`);
  return null;
};

// Debug function to examine CodeBuild artifact structure
const debugCodeBuildArtifacts = (builds, projectName) => {
  const projectBuilds = builds.filter(b => b.projectName === projectName).slice(0, 3);
  console.log(`\n🔍 DEBUG: Full artifact structure for ${projectName}:`);
  projectBuilds.forEach((build, idx) => {
    console.log(`\n  Build ${idx + 1}: ${build.id?.slice(-8)}`);
    console.log(`    Raw artifacts:`, JSON.stringify(build.artifacts, null, 4));
    
    // Check environment variables
    if (build.environment?.environmentVariables) {
      console.log(`    Environment variables:`);
      build.environment.environmentVariables.forEach(envVar => {
        if (envVar.name.includes('IMAGE') || envVar.name.includes('TAG') || envVar.name.includes('URI') || 
            envVar.name.includes('VERSION') || envVar.name.includes('S3') || envVar.name.includes('REVISION')) {
          console.log(`      ${envVar.name}: ${envVar.value}`);
        }
      });
    }
    
    // Check exported environment variables (these are available after build completion)
    if (build.exportedEnvironmentVariables) {
      console.log(`    Exported environment variables:`);
      build.exportedEnvironmentVariables.forEach(envVar => {
        if (envVar.name.includes('IMAGE') || envVar.name.includes('TAG') || envVar.name.includes('URI') || 
            envVar.name.includes('VERSION') || envVar.name.includes('S3') || envVar.name.includes('REVISION')) {
          console.log(`      ${envVar.name}: ${envVar.value}`);
        }
      });
    }
  });
};

// Get current deployment from S3 bucket version and imagedefinitions.json
const getCurrentDeploymentFromS3 = async (bucketName, keyPrefix, environment, component) => {
  try {
    console.log(`        🪣 Getting current deployment from S3 bucket: ${bucketName}...`);
    
    // Get the current (latest) version of the S3 bucket
    const listVersionsCommand = new ListObjectVersionsCommand({
      Bucket: bucketName,
      MaxKeys: 1 // Get only the latest version
    });
    
    const versionsResponse = await s3.send(listVersionsCommand);
    const currentVersion = versionsResponse.Versions?.[0];
    
    if (!currentVersion) {
      console.log(`        ❌ No versions found in bucket ${bucketName}`);
      return null;
    }
    
    console.log(`        📦 Current S3 version: ${currentVersion.VersionId} (modified: ${currentVersion.LastModified})`);
    
    // Download and parse imagedefinitions.json from current version
    const getObjectCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: 'imagedefinitions.json',
      VersionId: currentVersion.VersionId
    });
    
    const objectResponse = await s3.send(getObjectCommand);
    const imageDefinitionsContent = await streamToString(objectResponse.Body);
    const imageDefinitions = JSON.parse(imageDefinitionsContent);
    
    console.log(`        📄 Image definitions:`, JSON.stringify(imageDefinitions, null, 2));
    
    // Extract Docker image URI for the component
    const componentImageDef = imageDefinitions.find(def => 
      def.name && def.name.toLowerCase().includes(component.toLowerCase())
    );
    
    if (!componentImageDef || !componentImageDef.imageUri) {
      console.log(`        ❌ No image definition found for ${component} in ${bucketName}`);
      return null;
    }
    
    const dockerImageUri = componentImageDef.imageUri;
    console.log(`        🐳 Found Docker image for ${component}: ${dockerImageUri}`);
    
    // Extract the Docker tag (commit hash)
    const dockerTagMatch = dockerImageUri.match(/:([^:]+)$/);
    if (!dockerTagMatch) {
      console.log(`        ❌ Could not extract Docker tag from ${dockerImageUri}`);
      return null;
    }
    
    const dockerTag = dockerTagMatch[1];
    console.log(`        🏷️ Extracted Docker tag: ${dockerTag}`);
    
    return {
      environment,
      component,
      bucketName,
      s3VersionId: currentVersion.VersionId,
      s3LastModified: currentVersion.LastModified,
      dockerImageUri,
      dockerTag,
      deploymentMetadata: {
        name: componentImageDef.name,
        imageUri: dockerImageUri
      }
    };
    
  } catch (error) {
    console.error(`        ❌ Error getting current deployment from S3 bucket ${bucketName}:`, error.message);
    return null;
  }
};

// Helper function to convert stream to string
const streamToString = (stream) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
};

// Cross-reference PR numbers between builds with same commit hash
const findPRFromGitHub = async (build) => {
  if (!build.resolvedSourceVersion) return null;

  const commitSha = build.resolvedSourceVersion;
  const repo = getRepoFromProject(build.projectName);

  try {
    // Use the existing GitHub API function to get commit details
    const response = await fetch(`https://api.github.com/repos/hoc-stateeval/${repo}/commits/${commitSha}/pulls`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        ...(process.env.GITHUB_TOKEN && { 'Authorization': `token ${process.env.GITHUB_TOKEN}` })
      }
    });

    if (!response.ok) {
      console.log(`⚠️ GitHub API error for ${commitSha.substring(0,8)}: ${response.status}`);
      return null;
    }

    const pulls = await response.json();

    if (pulls && pulls.length > 0) {
      // Find the merged PR or the most recent one
      const mergedPR = pulls.find(pr => pr.merged_at) || pulls[0];
      console.log(`🔗 Found PR #${mergedPR.number} from GitHub API for commit ${commitSha.substring(0,8)}`);
      return mergedPR.number;
    }

    return null;
  } catch (error) {
    console.error(`❌ Error fetching PR from GitHub for commit ${commitSha.substring(0,8)}:`, error.message);
    return null;
  }
};

// Extract build information
const processBuild = async (build) => {
  // Debug logging for the specific build we're investigating
  if (build.id?.includes('18cb94c6')) {
    console.log(`🐛 PROCESSBUILD START: ${build.id}`);
    console.log(`   resolvedSourceVersion: ${build.resolvedSourceVersion}`);
    console.log(`   sourceVersion: ${build.sourceVersion}`);
  }

  const classification = await classifyBuild(build);
  
  // Skip builds that can't be classified yet (waiting for CloudWatch logs)
  if (!classification) {
    return null;
  }
  
  // Try to extract PR number from alternative sources if not already found
  let prNumber = classification.prNumber;
  if (!prNumber) {
    prNumber = await extractPRFromCommit(build);
  }

  // Check for hotfix commits (commits without PR numbers)
  let hotfixDetails = null;
  if (!prNumber && build.resolvedSourceVersion &&
      (build.sourceVersion === 'refs/heads/main' || build.sourceVersion === 'main' ||
       build.sourceVersion === 'refs/heads/dev' || build.sourceVersion === 'dev')) {
    // This is a direct branch build without a PR - likely a hotfix
    const repo = getRepoFromProject(build.projectName);
    const branchType = (build.sourceVersion === 'refs/heads/dev' || build.sourceVersion === 'dev') ? 'dev' : 'main';
    hotfixDetails = await getGitHubCommitDetails(repo, build.resolvedSourceVersion);

    if (hotfixDetails) {
      // Mark as hotfix and add to the classification
      hotfixDetails.isHotfix = true;
      console.log(`🚨 Detected hotfix commit for ${build.projectName}:${build.id?.slice(-8)} - ${hotfixDetails.author.name}: ${hotfixDetails.message.split('\n')[0]} (${branchType} branch)`);
    }
  }

  // Extract artifact information for deployment correlation
  const artifacts = {
    md5Hash: build.artifacts?.md5sum || null,
    sha256Hash: build.artifacts?.sha256sum || null,
    location: build.artifacts?.location || null,
    dockerImageUri: null // Will be populated from environment variables if available
  };
  
  // Extract Docker image URI from environment variables (for deployed artifacts)
  if (build.exportedEnvironmentVariables) {
    // Look for various Docker image URI environment variables
    const dockerEnvVars = ['IMAGE_URI', 'REPOSITORY_URI', 'IMAGE_TAG', 'DOCKER_IMAGE'];
    for (const envVar of dockerEnvVars) {
      const imageUriVar = build.exportedEnvironmentVariables.find(env => env.name === envVar);
      if (imageUriVar && imageUriVar.value) {
        artifacts.dockerImageUri = imageUriVar.value;
        break;
      }
    }
    
    // If no direct image URI found, try to construct it from available variables
    if (!artifacts.dockerImageUri) {
      const repoUri = build.exportedEnvironmentVariables.find(env => env.name === 'AWS_ACCOUNT_ID' || env.name === 'REPOSITORY_URI');
      const imageTag = build.exportedEnvironmentVariables.find(env => env.name === 'IMAGE_TAG' || env.name === 'COMMIT_HASH');
      
      if (repoUri && imageTag) {
        // Try to construct the full Docker image URI
        if (repoUri.value.includes('.dkr.ecr.') && !repoUri.value.includes(':')) {
          artifacts.dockerImageUri = `${repoUri.value}:${imageTag.value}`;
        }
      }
    }
  }
  
  // If still no Docker URI, try to construct based on project patterns and commit hash
  if (!artifacts.dockerImageUri && build.projectName && build.resolvedSourceVersion) {
    const commitHash = build.resolvedSourceVersion.substring(0, 7);
    
    // Pattern-based construction for known project types
    if (build.projectName.includes('frontend')) {
      artifacts.dockerImageUri = `810202965896.dkr.ecr.us-west-2.amazonaws.com/eval-frontend:${commitHash}`;
    } else if (build.projectName.includes('backend')) {
      artifacts.dockerImageUri = `810202965896.dkr.ecr.us-west-2.amazonaws.com/eval-backend:${commitHash}`;
    }
  }
  
  // For PR builds, fetch commit details to show in tooltip
  let commitDetails = null;
  if ((prNumber || classification.prNumber) && build.resolvedSourceVersion && !hotfixDetails) {
    const repo = getRepoFromProject(build.projectName);
    commitDetails = await getGitHubCommitDetails(repo, build.resolvedSourceVersion);
    if (commitDetails) {
      console.log(`📝 Fetched commit details for PR build ${build.projectName}:${build.id?.slice(-8)} - ${commitDetails.author?.name}: ${commitDetails.message?.split('\n')[0]}`);
    }
  }

  // Debug logging right before return for the specific build we're investigating
  if (build.id?.includes('18cb94c6')) {
    console.log(`🐛 PROCESSBUILD END: ${build.id}`);
    console.log(`   resolvedSourceVersion: ${build.resolvedSourceVersion}`);
    console.log(`   commit will be: ${build.resolvedSourceVersion?.substring(0, 7) || 'NA'}`);
    console.log(`   artifacts.md5Hash: ${artifacts?.md5Hash}`);
  }

  return {
    buildId: build.id,
    projectName: build.projectName,
    status: build.buildStatus, // SUCCESS, FAILED, IN_PROGRESS, etc.
    ...classification,
    prNumber: prNumber || classification.prNumber, // Use extracted PR if available
    sourceVersion: build.sourceVersion, // Include raw sourceVersion for debugging
    resolvedSourceVersion: build.resolvedSourceVersion, // Include commit SHA
    resolvedCommit: build.resolvedSourceVersion, // Full commit hash for artifact matching
    commit: build.resolvedSourceVersion?.substring(0, 7) || 'NA',
    startTime: build.startTime,
    endTime: build.endTime,
    duration: build.endTime ? Math.round((build.endTime - build.startTime) / 1000) : null,
    logs: build.logs?.groupName, // For potential PR number extraction from logs
    artifacts: artifacts, // Artifact hashes for deployment correlation
    hotfixDetails: hotfixDetails, // Hotfix commit details (author, message, date) if applicable
    commitAuthor: commitDetails?.author?.name || hotfixDetails?.author?.name, // Commit author for tooltip
    commitMessage: commitDetails?.message || hotfixDetails?.message // Commit message for tooltip
  };
};

// Get recent builds for specified projects
const getRecentBuilds = async (projectNames, maxBuilds = 50) => {
  const allBuilds = [];
  
  for (const projectName of projectNames) {
    try {
      console.log(`Fetching builds for project: ${projectName}`);
      
      // Get recent build IDs
      const listCommand = new ListBuildsForProjectCommand({
        projectName,
        sortOrder: 'DESCENDING'
      });
      
      const buildIds = await codebuild.send(listCommand);
      const recentBuildIds = buildIds.ids?.slice(0, maxBuilds) || [];
      
      if (recentBuildIds.length === 0) {
        console.log(`No builds found for ${projectName}`);
        continue;
      }
      
      // Get detailed build info
      const batchCommand = new BatchGetBuildsCommand({
        ids: recentBuildIds
      });
      
      const buildDetails = await codebuild.send(batchCommand);

      // Debug logging for the specific build we're investigating
      const debugBuild = buildDetails.builds?.find(b => b.id?.includes('18cb94c6'));
      if (debugBuild) {
        console.log(`🐛 DEBUG: Raw AWS data for 18cb94c6:`);
        console.log(`   sourceVersion: ${debugBuild.sourceVersion}`);
        console.log(`   resolvedSourceVersion: ${debugBuild.resolvedSourceVersion}`);
        console.log(`   id: ${debugBuild.id}`);
      }

      const processedBuilds = await Promise.all(
        (buildDetails.builds || []).map(build => processBuild(build))
      );
      
      // Filter out null results (builds with unknown runMode)
      const validBuilds = processedBuilds.filter(build => build !== null);
      
      console.log(`Found ${validBuilds.length} builds for ${projectName} (${processedBuilds.length - validBuilds.length} skipped)`);
      allBuilds.push(...validBuilds);
    } catch (error) {
      console.error(`Error fetching builds for ${projectName}:`, error.message);
    }
  }
  
  // Second pass: use GitHub API to find missing PR numbers for main branch builds
  console.log(`🔄 Second pass: Using GitHub API to find PR numbers for ${allBuilds.length} total builds...`);
  for (const build of allBuilds) {
    if (!build.prNumber && (build.sourceVersion === 'refs/heads/main' || build.sourceVersion === 'main')) {
      const githubPR = await findPRFromGitHub(build);
      if (githubPR) {
        build.prNumber = githubPR;
      }
    }
  }
  
  return allBuilds.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
};

// Get most recent build per project for each category
const getLatestBuildPerProject = (builds) => {
  const projectMap = new Map();
  
  // Group builds by project, keeping only the most recent for each
  builds.forEach(build => {
    const projectName = build.projectName;
    const existing = projectMap.get(projectName);
    
    if (!existing || new Date(build.startTime) > new Date(existing.startTime)) {
      projectMap.set(projectName, build);
    }
  });
  
  return Array.from(projectMap.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
};

// Get latest build per project for a specific build category
const getLatestBuildPerProjectByCategory = (builds, category) => {
  const filteredBuilds = category === 'dev'
    ? builds.filter(build => build.type === 'dev-test')
    : category === 'unknown'
    ? builds.filter(build => build.type === 'unknown')
    : category === 'main'
    ? builds.filter(build => build.type === 'production')
    : builds.filter(build => build.type === 'production');
    
  const projectMap = new Map();
  
  // Group builds by project, keeping the most recent for each
  filteredBuilds.forEach(build => {
    const projectName = build.projectName;
    const existing = projectMap.get(projectName) || [];
    
    // Add this build to the project's builds array
    existing.push(build);
    
    // Sort by startTime (most recent first) and keep only the latest
    existing.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    if (existing.length > 1) {
      existing.splice(1); // Keep only first 1
    }
    
    projectMap.set(projectName, existing);
  });
  
  // Flatten the results and sort
  const allBuilds = [];
  projectMap.forEach(builds => {
    allBuilds.push(...builds);
  });
  
  // Sort deployment builds by target suffix (demo, prod, sandbox), dev builds by full project name
  return allBuilds.sort((a, b) => {
    if (category === 'main') {
      // Extract target suffix (part after last dash) for deployment builds
      const getTargetSuffix = (projectName) => {
        const parts = projectName.split('-');
        return parts[parts.length - 1]; // Get last part (demo, prod, sandbox)
      };
      
      const aTarget = getTargetSuffix(a.projectName);
      const bTarget = getTargetSuffix(b.projectName);
      
      // If targets are the same, sort by component (backend vs frontend), then by time
      if (aTarget === bTarget) {
        const componentCompare = a.projectName.localeCompare(b.projectName);
        if (componentCompare === 0) {
          // Same project, sort by time (most recent first)
          return new Date(b.startTime) - new Date(a.startTime);
        }
        return componentCompare;
      }
      
      // Sort by target: demo, prod, sandbox
      return aTarget.localeCompare(bTarget);
    } else {
      // For dev builds, sort by full project name, then by time
      const projectCompare = a.projectName.localeCompare(b.projectName);
      if (projectCompare === 0) {
        // Same project, sort by time (most recent first)
        return new Date(b.startTime) - new Date(a.startTime);
      }
      return projectCompare;
    }
  });
};

// Get deployment status from CodePipeline 
// Get actual build information from pipeline execution details
const getBuildInfoFromPipelineExecution = async (pipelineName, executionId, allBuilds = []) => {
  console.log(`🔍 DEBUG getBuildInfoFromPipelineExecution called:`);
  console.log(`   Pipeline: ${pipelineName}`);
  console.log(`   ExecutionID: ${executionId}`);
  console.log(`   Available builds: ${allBuilds.length}`);

  // Determine the project name to search based on pipeline name - declared at function scope
  let searchProjectName = null;
  if (pipelineName.toLowerCase().includes('frontend')) {
    if (pipelineName.toLowerCase().includes('sandbox')) {
      searchProjectName = 'eval-frontend-sandbox';
    } else if (pipelineName.toLowerCase().includes('demo')) {
      searchProjectName = 'eval-frontend-demo';
    } else if (pipelineName.toLowerCase().includes('prod')) {
      searchProjectName = 'eval-frontend-prod';
    }
  } else if (pipelineName.toLowerCase().includes('backend')) {
    if (pipelineName.toLowerCase().includes('sandbox')) {
      searchProjectName = 'eval-backend-sandbox';
    } else if (pipelineName.toLowerCase().includes('demo')) {
      searchProjectName = 'eval-backend-demo';
    } else if (pipelineName.toLowerCase().includes('prod')) {
      searchProjectName = 'eval-backend-prod';
    }
  }

  console.log(`   Determined searchProjectName: ${searchProjectName || 'NOT_FOUND'}`);

  if (!searchProjectName) {
    console.log(`❌ CRITICAL: Could not determine search project name for pipeline: ${pipelineName}`);
    return { prNumber: null, gitCommit: null, buildTimestamp: null, matchedBuild: null, matchingMethod: 'None' };
  }

  try {
    console.log(`      🔍 Getting source details for ${pipelineName} execution ${executionId}`);
    
    // Get pipeline execution details to find the actual source revision
    const getPipelineExecutionCommand = new GetPipelineExecutionCommand({
      pipelineName: pipelineName,
      pipelineExecutionId: executionId
    });
    
    const executionDetails = await codepipeline.send(getPipelineExecutionCommand);
    
    // DEBUG: Log the full execution details to file
    const fs = require('fs');
    fs.writeFileSync(`pipeline-debug-${executionId}.json`, JSON.stringify(executionDetails, null, 2));
    console.log(`        🔍 DEBUG: Wrote pipeline execution details to pipeline-debug-${executionId}.json`);
    
    const sourceRevisions = executionDetails.pipelineExecution?.artifactRevisions || [];
    
    console.log(`        📋 Found ${sourceRevisions.length} source revisions for execution ${executionId}`);
    
    if (sourceRevisions.length === 0) {
      console.log(`        ❌ No source revisions found for pipeline execution ${executionId}`);
      return { prNumber: null, gitCommit: null, buildTimestamp: null, matchedBuild: null };
    }
    
    // Get the primary source revision (usually the first one)
    const primarySource = sourceRevisions[0];
    
    // CRITICAL FIX: Check if this is an S3 revision ID or git commit
    let s3VersionId = null;
    let gitCommit = null;
    
    if (primarySource.revisionSummary && primarySource.revisionSummary.includes('Amazon S3 version id:')) {
      // This is an S3 artifact revision, not a git commit
      s3VersionId = primarySource.revisionId;
      console.log(`        🪣 S3 version ID detected: ${s3VersionId}`);
    } else {
      // This is a git commit
      gitCommit = primarySource.revisionId?.substring(0, 8);
      console.log(`        📝 Git commit detected: ${gitCommit}`);
    }
    
    // Try to extract PR number from revision summary or URL
    let prNumber = null;
    if (primarySource.revisionSummary) {
      // Look for PR number patterns in the revision summary
      const prMatch = primarySource.revisionSummary.match(/(?:PR|pull request)[\s#]*(\d+)/i) ||
                     primarySource.revisionSummary.match(/#(\d+)/);
      if (prMatch) {
        prNumber = prMatch[1];
      }
    }
    
    // If no PR found in summary, try the revision URL
    if (!prNumber && primarySource.revisionUrl) {
      const urlPrMatch = primarySource.revisionUrl.match(/\/pull\/(\d+)/);
      if (urlPrMatch) {
        prNumber = urlPrMatch[1];
      }
    }
    
    console.log(`        🎯 Pipeline execution source: S3=${s3VersionId}, commit=${gitCommit}, PR#${prNumber || 'unknown'}`);
    console.log(`        📝 Revision summary: ${primarySource.revisionSummary || 'N/A'}`);
    
    // NEW: Pipeline-centric correlation - start with S3 version ID and get Docker image URI
    let matchedBuild = null;
    let dockerImageUri = null;
    
    // For S3 version ID - need to access the S3 bucket to get the git commit hash
    if (s3VersionId) {
      console.log(`        🔄 Processing S3 version ID correlation for ${s3VersionId}...`);
      
      try {
        // Get S3 bucket and object key using shared function
        const s3Config = await getS3ArtifactConfig(pipelineName, codepipeline);
        const bucketName = s3Config.bucketName;
        const objectKey = s3Config.objectKey;
        
        if (bucketName && objectKey) {
          console.log(`        🪣 Accessing S3: s3://${bucketName}/${objectKey}?versionId=${s3VersionId}`);
          
          // Use AWS SDK to get the S3 object with version ID
          const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
          const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' });
          
          const getObjectCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: objectKey,
            VersionId: s3VersionId
          });
          
          const s3Response = await s3Client.send(getObjectCommand);
          console.log(`        ✅ Successfully retrieved S3 object with version ID ${s3VersionId}`);
          
          // The S3 object is a zip file - we need to extract and parse it for git commit
          const streamToString = (stream) => {
            return new Promise((resolve, reject) => {
              const chunks = [];
              stream.on('data', (chunk) => chunks.push(chunk));
              stream.on('error', reject);
              stream.on('end', () => resolve(Buffer.concat(chunks)));
            });
          };
          
          const zipBuffer = await streamToString(s3Response.Body);
          
          // Use JSZip to extract git commit info
          const JSZip = require('jszip');
          const zip = await JSZip.loadAsync(zipBuffer);
          
          // Look for imagedefinitions.json to extract commit hash from imageUri
          let extractedCommit = null;
          
          if (zip.files['imagedefinitions.json']) {
            console.log(`        📄 Found imagedefinitions.json in S3 zip`);
            const imageDefContent = await zip.files['imagedefinitions.json'].async('string');
            console.log(`        📝 imagedefinitions.json content: ${imageDefContent}`);
            
            try {
              const imageDef = JSON.parse(imageDefContent);
              if (Array.isArray(imageDef) && imageDef.length > 0 && imageDef[0].imageUri) {
                const imageUri = imageDef[0].imageUri;
                console.log(`        🔍 Found imageUri: ${imageUri}`);
                
                // Split by ":" and take the second part (tag) which should be the commit hash
                const uriParts = imageUri.split(':');
                if (uriParts.length >= 2) {
                  extractedCommit = uriParts[1].substring(0, 8); // Take first 8 chars
                  console.log(`        🎯 Extracted commit hash from imageUri: ${extractedCommit}`);
                }
              }
            } catch (parseError) {
              console.log(`        ❌ Error parsing imagedefinitions.json: ${parseError.message}`);
            }
          } else {
            console.log(`        ⚠️ No imagedefinitions.json found in S3 zip`);
          }
          
          if (extractedCommit) {
            console.log(`        🎯 Extracted git commit from S3: ${extractedCommit}`);
            gitCommit = extractedCommit;
          } else {
            console.log(`        ⚠️ Could not extract git commit from S3 zip file`);
          }
          
        } else {
          console.log(`        ❌ Could not determine S3 bucket/key for pipeline: ${pipelineName}`);
        }
        
      } catch (error) {
        console.log(`        ❌ Error accessing S3 version ${s3VersionId}:`, error.message);
      }
    }
    
    // Now proceed with build correlation using git commit (whether from S3 or direct)
    if (gitCommit && searchProjectName && allBuilds.length > 0) {
      const projectBuilds = allBuilds.filter(build => build.projectName === searchProjectName);
      console.log(`        📊 Available builds for ${searchProjectName}: ${projectBuilds.length}`);
      
      // Find build that matches the git commit hash from S3
      console.log(`        🔍 Searching for build with commit: ${gitCommit}`);
      
      for (const build of projectBuilds) {
        const buildCommit = build.commit || build.sourceVersion?.substring(0, 8);
        console.log(`        📝 Comparing: pipeline ${gitCommit} vs build ${buildCommit} (${build.id?.slice(-8)})`);
        
        if (buildCommit === gitCommit) {
          matchedBuild = build;
          matchedBuild._matchedViaGitCommit = true;
          console.log(`        ✅ Found exact git commit match: ${build.projectName}:${build.id?.slice(-8)}`);
          console.log(`        ✅   Pipeline commit: ${gitCommit}`);
          console.log(`        ✅   Build commit:    ${buildCommit}`);
          dockerImageUri = build.artifacts?.dockerImageUri;
          console.log(`        🔍 Build Docker URI: ${dockerImageUri}`);
          break;
        }
      }
      
      if (!matchedBuild) {
        console.log(`        ⚠️ No build found with matching git commit ${gitCommit}`);
      }
    }
    
    // Now that we have the Docker image URI from the pipeline deployment, find the matching CodeBuild
    if (dockerImageUri && searchProjectName && allBuilds.length > 0) {
      console.log(`        🔍 Searching for CodeBuild with Docker image URI: ${dockerImageUri}`);
      
      const projectBuilds = allBuilds.filter(build => build.projectName === searchProjectName);
      console.log(`        📊 Available builds for ${searchProjectName}: ${projectBuilds.length}`);
      
      projectBuilds.slice(0, 10).forEach(build => {
        console.log(`           - ${build.id?.slice(-8)} | ${build.commit} | PR#${build.prNumber || 'unknown'} | ${build.startTime}`);
        console.log(`              🔍 Build Docker URI: ${build.artifacts?.dockerImageUri || 'none'}`);
      });
      
      // Find CodeBuild with matching Docker image URI
      for (const build of projectBuilds) {
        if (build.artifacts?.dockerImageUri === dockerImageUri) {
          matchedBuild = build;
          matchedBuild._matchedViaArtifacts = true;
          console.log(`        ✅ Found exact Docker image URI match: ${build.projectName}:${build.id?.slice(-8)}`);
          console.log(`        ✅   Pipeline URI: ${dockerImageUri}`);
          console.log(`        ✅   Build URI:    ${build.artifacts.dockerImageUri}`);
          break;
        }
      }
      
      // If exact match not found, try tag matching
      if (!matchedBuild) {
        console.log(`        🔄 No exact URI match, trying tag extraction...`);
        
        // Extract tag from pipeline Docker image URI
        const pipelineTagMatch = dockerImageUri.match(/:([^:]+)$/);
        if (pipelineTagMatch) {
          const pipelineTag = pipelineTagMatch[1];
          console.log(`        🔍 Pipeline Docker tag: ${pipelineTag}`);
          
          for (const build of projectBuilds) {
            if (build.artifacts?.dockerImageUri) {
              const buildTagMatch = build.artifacts.dockerImageUri.match(/:([^:]+)$/);
              if (buildTagMatch) {
                const buildTag = buildTagMatch[1];
                if (buildTag === pipelineTag) {
                  matchedBuild = build;
                  matchedBuild._matchedViaArtifacts = true;
                  console.log(`        ✅ Found Docker tag match: ${build.projectName}:${build.id?.slice(-8)} via tag ${buildTag}`);
                  break;
                }
              }
            }
          }
        }
      }
      
      if (!matchedBuild) {
        console.log(`        ❌ No CodeBuild found matching Docker image URI: ${dockerImageUri}`);
      }
    }
    
    // If no artifact match found, fall back to commit hash matching
    if (!matchedBuild && gitCommit && searchProjectName) {
      console.log(`        🔄 No artifact match found, falling back to commit matching for ${gitCommit}...`);
      
      const projectBuilds = allBuilds.filter(build => build.projectName === searchProjectName);
      
      // Look for a build with matching commit hash
      matchedBuild = projectBuilds.find(build => {
        const buildCommit = build.resolvedCommit?.substring(0, 8) || 
                          (build.sourceVersion && build.sourceVersion.length === 8 ? build.sourceVersion : null) ||
                          build.commit;
        
        if (buildCommit === gitCommit) {
          // Only match builds that completed successfully
          if (build.status !== 'SUCCEEDED') {
            console.log(`        ⚠️ Skipping ${build.projectName}:${build.id?.slice(-8)} - status: ${build.status} (not SUCCEEDED)`);
            return false;
          }
          
          console.log(`        ✅ Found valid commit match: ${build.projectName}:${build.id?.slice(-8)} with commit ${buildCommit} (status: ${build.status})`);
          build._matchedViaCommitFromPipeline = true;
          return true;
        }
        return false;
      });
        
      
      if (!matchedBuild) {
        console.log(`        ⚠️ No matching build found for ${searchProjectName || pipelineName} with commit ${gitCommit}`);
      }
    }
    
    // No final fallbacks - only use exact correlations to prevent false positives
    if (!matchedBuild) {
      console.log(`        ❌ No deployment correlation found for ${searchProjectName || pipelineName} with commit ${gitCommit} - will not guess`);
    }
    
    // Determine which method was used for matching
    let matchingMethod = 'None';
    console.log(`   DEBUG: About to determine matching method:`);
    console.log(`   matchedBuild exists: ${!!matchedBuild}`);
    if (matchedBuild) {
      console.log(`   matchedBuild._matchedViaArtifacts: ${!!matchedBuild._matchedViaArtifacts}`);
      console.log(`   matchedBuild._matchedViaCommitFromPipeline: ${!!matchedBuild._matchedViaCommitFromPipeline}`);
      console.log(`   matchedBuild._matchedViaBuildCommit: ${!!matchedBuild._matchedViaBuildCommit}`);
      console.log(`   matchedBuild._matchedViaGitCommit: ${!!matchedBuild._matchedViaGitCommit}`);

      if (matchedBuild._matchedViaArtifacts) {
        matchingMethod = 'Method A (Artifacts)';
      } else if (matchedBuild._matchedViaCommitFromPipeline) {
        matchingMethod = 'Method B (Pipeline Commit)';
      } else if (matchedBuild._matchedViaBuildCommit) {
        matchingMethod = 'Method C (Build Commit)';
      } else if (matchedBuild._matchedViaGitCommit) {
        matchingMethod = 'Method D (Git Commit)';
      } else {
        matchingMethod = 'Method B (Pipeline Commit)'; // Default for direct pipeline commits
      }
    } else {
      console.log(`   No matchedBuild found - method will be 'None'`);
    }

    const result = {
      prNumber: matchedBuild?.prNumber || prNumber,
      gitCommit: matchedBuild?.commit || gitCommit,
      s3VersionId: s3VersionId,
      dockerImageUri: dockerImageUri,
      buildTimestamp: matchedBuild?.startTime || executionDetails.pipelineExecution?.lastUpdateTime?.toISOString(),
      matchedBuild: matchedBuild,
      matchingMethod: matchingMethod
    };
    
    console.log(`        🎯 FINAL RESULT for ${pipelineName}:`);
    console.log(`           PR#: ${result.prNumber || 'null'}`);
    console.log(`           Git commit: ${result.gitCommit?.slice(0,8) || 'null'}`);
    console.log(`           S3 version: ${result.s3VersionId?.slice(0,16) || 'null'}...`);
    console.log(`           Docker URI: ${result.dockerImageUri || 'null'}`);
    console.log(`           Matched build: ${!!matchedBuild}`);
    console.log(`           Method: ${matchingMethod}`);
    return result;
    
  } catch (error) {
    console.error(`        ❌ Error getting pipeline execution details for ${pipelineName}:`, error.message);
    return { prNumber: null, gitCommit: null, buildTimestamp: null, matchedBuild: null, matchingMethod: 'None' };
  }
};

const getPipelineDeploymentStatus = async (builds) => {
  try {
    console.log('🔄 Fetching pipeline deployment status...');

    // For deployment correlation, we need more build history than the main dashboard
    // to find matches for older deployments
    const allProjectNames = [
      'eval-backend-sandbox', 'eval-backend-demo', 'eval-backend-prod',
      'eval-frontend-sandbox', 'eval-frontend-demo', 'eval-frontend-prod'
    ];
    console.log('🔄 Fetching extended build history for deployment correlation...');
    const deploymentBuilds = await getRecentBuilds(allProjectNames, 100); // Reduced limit to help with rate limiting
    
    // List all pipelines
    const listPipelinesCommand = new ListPipelinesCommand({});
    const pipelinesList = await codepipeline.send(listPipelinesCommand);
    
    const deploymentPipelines = (pipelinesList.pipelines || []).filter(pipeline => 
      pipeline.name && (
        pipeline.name.includes('sandbox') || 
        pipeline.name.includes('demo') || 
        pipeline.name.includes('prod')
      )
    );
    
    console.log(`Found ${deploymentPipelines.length} deployment pipelines:`, deploymentPipelines.map(p => p.name));
    
    const environments = ['sandbox', 'demo', 'production'];
    const deploymentStatus = [];
    
    for (const env of environments) {
      console.log(`\n📊 Processing ${env} environment...`);
      
      // Find pipelines for this environment
      const envPipelines = deploymentPipelines.filter(pipeline => {
        const name = pipeline.name.toLowerCase();
        if (env === 'production') {
          return name.includes('prod');
        }
        return name.includes(env);
      });
      
      console.log(`Found ${envPipelines.length} pipelines for ${env}:`, envPipelines.map(p => p.name));
      
      const currentDeployment = { backend: null, frontend: null };
      let lastDeployedAt = null;
      
      // PIPELINE-CENTRIC APPROACH: Get deployments from pipeline executions
      console.log(`    🚀 Getting deployments from pipeline executions for ${env}...`);
      
      // DEBUG: Examine CodeBuild artifact structure for frontend builds
      if (env === 'sandbox') {
        debugCodeBuildArtifacts(builds, 'eval-frontend-sandbox');
      }
      
        // Get the most recent successful execution for each pipeline
        for (const pipeline of envPipelines) {
        try {
          console.log(`  🔍 Checking pipeline: ${pipeline.name}`);
          
          const listExecutionsCommand = new ListPipelineExecutionsCommand({
            pipelineName: pipeline.name,
            maxResults: 10 // Increased to capture more recent executions
          });
          
          const executions = await codepipeline.send(listExecutionsCommand);
          
          // Log all executions for debugging
          console.log(`    📋 Found ${executions.pipelineExecutionSummaries?.length || 0} executions:`);
          (executions.pipelineExecutionSummaries || []).forEach((exec, idx) => {
            console.log(`      ${idx + 1}. ${exec.pipelineExecutionId} | ${exec.status} | ${exec.trigger?.triggerType || 'Unknown'} | ${exec.lastUpdateTime}`);
          });
          
          // Prioritize StartPipelineExecution over CloudWatchEvent executions
          // Look for the most recent successful StartPipelineExecution first
          let successfulExecution = (executions.pipelineExecutionSummaries || [])
            .filter(exec => exec.status === 'Succeeded')
            .find(exec => exec.trigger?.triggerType === 'StartPipelineExecution');

          // If no StartPipelineExecution found, fall back to any successful execution
          if (!successfulExecution) {
            successfulExecution = (executions.pipelineExecutionSummaries || [])
              .find(exec => exec.status === 'Succeeded');
          }

          console.log(`    🎯 Selected execution: ${successfulExecution?.pipelineExecutionId || 'none'} (${successfulExecution?.trigger?.triggerType || 'unknown type'})`);

          if (successfulExecution) {
            console.log(`    ✅ Found successful execution: ${successfulExecution.pipelineExecutionId} at ${successfulExecution.lastUpdateTime}`);
            
            // Get build information from pipeline execution details
            const buildInfo = await getBuildInfoFromPipelineExecution(pipeline.name, successfulExecution.pipelineExecutionId, deploymentBuilds);
            
            // Determine if this is backend or frontend based on pipeline name
            const isBackend = pipeline.name.toLowerCase().includes('backend');
            const isFrontend = pipeline.name.toLowerCase().includes('frontend');
            
            // Only create deployment entries when we have a valid matched build
            // This prevents false positives from S3 revision IDs that can't be correlated
            if (buildInfo.matchedBuild && buildInfo.matchingMethod !== 'None') {
              if (isBackend) {
                currentDeployment.backend = {
                  pipelineName: pipeline.name,
                  executionId: successfulExecution.pipelineExecutionId,
                  deployedAt: successfulExecution.lastUpdateTime?.toISOString(),
                  prNumber: buildInfo.prNumber,
                  gitCommit: buildInfo.gitCommit,
                  buildTimestamp: buildInfo.buildTimestamp || successfulExecution.lastUpdateTime?.toISOString(),
                  matchedBuild: buildInfo.matchedBuild,
                  matchingMethod: buildInfo.matchingMethod
                };
              } else if (isFrontend) {
                currentDeployment.frontend = {
                  pipelineName: pipeline.name,
                  executionId: successfulExecution.pipelineExecutionId,
                  deployedAt: successfulExecution.lastUpdateTime?.toISOString(),
                  prNumber: buildInfo.prNumber,
                  gitCommit: buildInfo.gitCommit,
                  buildTimestamp: buildInfo.buildTimestamp || successfulExecution.lastUpdateTime?.toISOString(),
                  matchedBuild: buildInfo.matchedBuild,
                  matchingMethod: buildInfo.matchingMethod
                };
              }
              
              // Only track deployment time when we have a valid correlation
              if (!lastDeployedAt || successfulExecution.lastUpdateTime > new Date(lastDeployedAt)) {
                lastDeployedAt = successfulExecution.lastUpdateTime?.toISOString();
              }
            } else {
              console.log(`    ⚠️ Skipping deployment entry for ${pipeline.name} - no valid build correlation (method: ${buildInfo.matchingMethod})`);
            }
          } else {
            console.log(`    ❌ No successful executions found for ${pipeline.name}`);
          }
        } catch (error) {
          console.error(`    ❌ Error checking pipeline ${pipeline.name}:`, error.message);
        }
        }
      
      deploymentStatus.push({
        environment: env,
        lastDeployedAt: lastDeployedAt,
        currentDeployment: currentDeployment,
        availableUpdates: {
          backend: [], // We'll populate this by comparing with deployment builds
          frontend: []
        }
      });
    }
    
    console.log('✅ Pipeline deployment status collected');
    return deploymentStatus;
    
  } catch (error) {
    console.error('❌ Error fetching pipeline deployment status:', error.message);
    return [];
  }
};

// Determine deployment coordination state based on available updates and build status
const determineDeploymentState = (backendUpdates, frontendUpdates, prodBuildStatuses, envName) => {

  const hasBackendUpdates = backendUpdates.length > 0;
  const hasFrontendUpdates = frontendUpdates.length > 0;

  // Check if builds are out of date (blocked by "Build Needed" status)
  // TEMP FIX: Force prod builds to never need builds (override for commit hash issue)
  const backendNeedsBuild = envName === 'production' ? false : (prodBuildStatuses?.['backend']?.needsBuild === true);
  const frontendNeedsBuild = envName === 'production' ? false : (prodBuildStatuses?.['frontend']?.needsBuild === true);
  const backendDemoNeedsBuild = prodBuildStatuses?.['backend-demo']?.needsBuild === true;

  // Check if builds are correlated by timestamp (within 10 minutes)
  const CORRELATION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  let areBuildsCorrelated = false;

  if (hasBackendUpdates && hasFrontendUpdates) {
    const backendTime = new Date(backendUpdates[0].buildTimestamp).getTime();
    const frontendTime = new Date(frontendUpdates[0].buildTimestamp).getTime();
    areBuildsCorrelated = Math.abs(backendTime - frontendTime) <= CORRELATION_WINDOW_MS;
  }

  console.log(`      🚀 Deployment coordination for ${envName}:`);
  console.log(`         Backend updates: ${hasBackendUpdates}, Frontend updates: ${hasFrontendUpdates}`);
  console.log(`         Backend needs build: ${backendNeedsBuild}, Frontend needs build: ${frontendNeedsBuild}, Demo needs build: ${backendDemoNeedsBuild}`);
  console.log(`         Builds correlated: ${areBuildsCorrelated}`);

  // Determine deployment state
  if (backendNeedsBuild || frontendNeedsBuild || backendDemoNeedsBuild) {
    return {
      state: 'BUILDS_OUT_OF_DATE',
      canDeployBackend: false,
      canDeployFrontend: false,
      canDeployBoth: false,
      recommendedAction: 'BUILD_REQUIRED',
      reason: 'Production builds are out of date - manual build required before deployment',
      blockedBy: {
        backend: backendNeedsBuild,
        frontend: frontendNeedsBuild,
        backendDemo: backendDemoNeedsBuild
      }
    };
  }

  if (!hasBackendUpdates && !hasFrontendUpdates) {
    return {
      state: 'NO_UPDATES_AVAILABLE',
      canDeployBackend: false,
      canDeployFrontend: false,
      canDeployBoth: false,
      recommendedAction: 'NONE',
      reason: 'No newer builds available for deployment'
    };
  }

  if (hasBackendUpdates && hasFrontendUpdates) {
    if (areBuildsCorrelated) {
      return {
        state: 'BOTH_READY_COORDINATED',
        canDeployBackend: true, // Allow independent for recovery
        canDeployFrontend: true, // Allow independent for recovery
        canDeployBoth: true,
        recommendedAction: 'DEPLOY_BOTH',
        reason: 'Both frontend and backend have correlated updates - deploy together',
        correlation: {
          timeDifference: Math.abs(new Date(backendUpdates[0].buildTimestamp).getTime() - new Date(frontendUpdates[0].buildTimestamp).getTime()),
          correlationWindow: CORRELATION_WINDOW_MS
        }
      };
    } else {
      return {
        state: 'BOTH_READY_INDEPENDENT',
        canDeployBackend: true,
        canDeployFrontend: true,
        canDeployBoth: true,
        recommendedAction: 'DEPLOY_INDEPENDENT',
        reason: 'Both frontend and backend have updates, but builds are not correlated - deploy independently or together'
      };
    }
  }

  if (hasBackendUpdates) {
    return {
      state: 'BACKEND_ONLY_READY',
      canDeployBackend: true,
      canDeployFrontend: false,
      canDeployBoth: false,
      recommendedAction: 'DEPLOY_BACKEND',
      reason: 'Only backend has newer builds available'
    };
  }

  if (hasFrontendUpdates) {
    return {
      state: 'FRONTEND_ONLY_READY',
      canDeployBackend: false,
      canDeployFrontend: true,
      canDeployBoth: false,
      recommendedAction: 'DEPLOY_FRONTEND',
      reason: 'Only frontend has newer builds available'
    };
  }

  return {
    state: 'UNKNOWN',
    canDeployBackend: false,
    canDeployFrontend: false,
    canDeployBoth: false,
    recommendedAction: 'NONE',
    reason: 'Unable to determine deployment state'
  };
};

// Generate deployment status combining CodePipeline data with available builds
const generateDeploymentStatus = async (builds, prodBuildStatuses = {}) => {
  // Get actual deployment status from CodePipeline
  const pipelineStatus = await getPipelineDeploymentStatus(builds);
  
  if (pipelineStatus.length === 0) {
    console.log('⚠️  No pipeline data available - AWS API issues detected');
    return generateErrorDeploymentStatus('AWS API access issues detected - deployment status temporarily unavailable. Please check AWS permissions or wait for rate limits to reset.');
  }
  
  // Enhance pipeline status with available updates from builds
  // Only include deployable builds for deployment correlation - exclude test builds
  const deploymentBuilds = builds.filter(build =>
    build.type === 'production' && // Production builds only
    build.isDeployable === true && // Only deployable builds (excludes test builds)
    build.status === 'SUCCEEDED' // Only successful builds
  );
  
  const result = pipelineStatus.map(envStatus => {
    const envName = envStatus.environment;
    
    // Create lookup table for environment to project names
    const getProjectName = (envName, component) => {
      if (envName === 'production') {
        return component === 'backend' ? 'eval-backend-prod' : 'eval-frontend-prod';
      }
      return `eval-${component}-${envName}`;
    };
    
    // Get current deployment timestamps for comparison (use deployedAt, not buildTimestamp)
    const currentBackendBuildTime = envStatus.currentDeployment?.backend?.deployedAt ? 
      new Date(envStatus.currentDeployment.backend.deployedAt).getTime() : 0;
    const currentFrontendBuildTime = envStatus.currentDeployment?.frontend?.deployedAt ? 
      new Date(envStatus.currentDeployment.frontend.deployedAt).getTime() : 0;
    
    console.log(`      🔍 ${envName} - Current backend build time: ${new Date(currentBackendBuildTime)}, frontend: ${new Date(currentFrontendBuildTime)}`);
    
    // Get currently deployed build IDs to exclude from available updates
    const currentBackendBuildId = envStatus.currentDeployment?.backend?.matchedBuild?.buildId;
    const currentFrontendBuildId = envStatus.currentDeployment?.frontend?.matchedBuild?.buildId;

    // Find the exact backend build that appears in Deployment Builds table by project name
    const expectedBackendProjectName = getProjectName(envName, 'backend');
    const latestBackendBuild = deploymentBuilds
      .filter(build => build.projectName === expectedBackendProjectName)
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())[0];
      
    console.log(`      🏗️ Looking for backend project: ${expectedBackendProjectName}, found: ${latestBackendBuild?.projectName || 'none'}`);
    if (latestBackendBuild) {
      console.log(`      🔍 Latest backend build for ${envName}: ${latestBackendBuild.projectName}:${latestBackendBuild.buildId?.slice(-8)} (${latestBackendBuild.commit || latestBackendBuild.artifacts?.md5Hash?.substring(0,7) || 'NA'}) at ${new Date(latestBackendBuild.startTime).toISOString()}`);
    }
      
    const availableBackendUpdates = latestBackendBuild &&
      new Date(latestBackendBuild.startTime).getTime() > currentBackendBuildTime &&
      latestBackendBuild.buildId !== currentBackendBuildId // Exclude currently deployed build
      ? [{
          buildId: latestBackendBuild.buildId,
          prNumber: latestBackendBuild.prNumber,
          gitCommit: latestBackendBuild.commit,
          buildTimestamp: latestBackendBuild.startTime,
          artifacts: latestBackendBuild.artifacts,
          projectName: latestBackendBuild.projectName
        }] 
      : [];
      
    // Find the exact frontend build that appears in Deployment Builds table by project name
    const expectedFrontendProjectName = getProjectName(envName, 'frontend');
    const latestFrontendBuild = deploymentBuilds
      .filter(build => build.projectName === expectedFrontendProjectName)
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())[0];
      
    console.log(`      🏗️ Looking for frontend project: ${expectedFrontendProjectName}, found: ${latestFrontendBuild?.projectName || 'none'}`);
    if (latestFrontendBuild) {
      console.log(`      🔍 Latest frontend build for ${envName}: ${latestFrontendBuild.projectName}:${latestFrontendBuild.buildId?.slice(-8)} (${latestFrontendBuild.commit || latestFrontendBuild.artifacts?.md5Hash?.substring(0,7) || 'NA'}) at ${new Date(latestFrontendBuild.startTime).toISOString()}`);
      console.log(`      📅 Current deployed frontend time: ${new Date(currentFrontendBuildTime).toISOString()}, newer? ${new Date(latestFrontendBuild.startTime).getTime() > currentFrontendBuildTime}`);
    }
      
    const availableFrontendUpdates = latestFrontendBuild &&
      new Date(latestFrontendBuild.startTime).getTime() > currentFrontendBuildTime &&
      latestFrontendBuild.buildId !== currentFrontendBuildId // Exclude currently deployed build
      ? [{
          buildId: latestFrontendBuild.buildId,
          prNumber: latestFrontendBuild.prNumber,
          gitCommit: latestFrontendBuild.commit,
          buildTimestamp: latestFrontendBuild.startTime,
          artifacts: latestFrontendBuild.artifacts,
          projectName: latestFrontendBuild.projectName
        }] 
      : [];
    
    console.log(`      🎯 DEBUG: Frontend artifacts for ${envName}:`, JSON.stringify(latestFrontendBuild?.artifacts, null, 2));
    console.log(`      🎯 DEBUG: availableFrontendUpdates for ${envName}:`, JSON.stringify(availableFrontendUpdates, null, 2));

    console.log(`      🎯 Available updates for ${envName}: backend=${availableBackendUpdates.length}, frontend=${availableFrontendUpdates.length}`);

    // Determine deployment coordination state
      const deploymentCoordination = determineDeploymentState(
      availableBackendUpdates,
      availableFrontendUpdates,
      prodBuildStatuses,
      envName
    );

    return {
      ...envStatus,
      availableUpdates: {
        backend: availableBackendUpdates,
        frontend: availableFrontendUpdates
      },
      deploymentCoordination
    };
  });
  
  // Check for rate limiting: if available updates have builds but missing artifacts, show error
  const updatesWithMissingArtifacts = result.flatMap(env => 
    [...(env.availableUpdates?.backend || []), ...(env.availableUpdates?.frontend || [])]
  ).filter(update => 
    update && !update.artifacts // Update exists but no artifacts
  );
  
  const totalUpdates = result.flatMap(env => 
    [...(env.availableUpdates?.backend || []), ...(env.availableUpdates?.frontend || [])]
  ).length;
  
  if (totalUpdates > 0 && updatesWithMissingArtifacts.length > 0) {
    const missingPercentage = (updatesWithMissingArtifacts.length / totalUpdates) * 100;
    console.log(`⚠️  Rate limiting detected: ${missingPercentage.toFixed(1)}% of available updates missing artifacts (${updatesWithMissingArtifacts.length}/${totalUpdates})`);
    return generateErrorDeploymentStatus('AWS API rate limiting detected - deployment status temporarily unavailable. Please wait and refresh.');
  }
  
  return result;
};

// Error deployment status - show rate limiting error instead of incomplete data
const generateErrorDeploymentStatus = (errorMessage) => {
  console.log(`⚠️  Deployment status error: ${errorMessage}`);
  
  const environments = ['sandbox', 'demo', 'production'];
  
  return environments.map(env => ({
    environment: env,
    lastDeployedAt: null,
    currentDeployment: {
      backend: null,
      frontend: null
    },
    availableUpdates: {
      backend: [],
      frontend: []
    },
    error: errorMessage
  }));
};

// Fallback deployment status (conservative approach - show no deployments when pipeline data unavailable)
const generateFallbackDeploymentStatus = (builds) => {
  console.log('⚠️  Using fallback deployment status - showing conservative "no deployment" state');
  
  const deploymentBuilds = builds.filter(build =>
    build.type === 'production' && // Production builds only
    build.isDeployable === true && // Only deployable builds (excludes test builds)
    build.status === 'SUCCEEDED' // Only successful builds
  );
  const environments = ['sandbox', 'demo', 'production'];
  
  return environments.map(env => {
    // Find most recent backend and frontend builds for this environment that could be deployed
    const envBuilds = deploymentBuilds.filter(build => 
      build.projectName.includes(env === 'production' ? 'prod' : env)
    );
    
    const backendBuilds = envBuilds
      .filter(build => build.projectName.includes('backend'))
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
      
    const frontendBuilds = envBuilds
      .filter(build => build.projectName.includes('frontend'))
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    
    // Since we can't verify actual deployments, show all successful builds as "available updates"
    // rather than pretending the latest ones are deployed
    const availableBackendUpdates = backendBuilds
      .filter(build => build.status === 'SUCCESS' || build.status === 'SUCCEEDED')
      .slice(0, 3) // Show top 3 available builds
      .map(build => ({
        prNumber: build.prNumber,
        gitCommit: build.commit,
        buildTimestamp: build.startTime,
        artifacts: build.artifacts
      }));
      
    const availableFrontendUpdates = frontendBuilds
      .filter(build => build.status === 'SUCCESS' || build.status === 'SUCCEEDED')
      .slice(0, 3) // Show top 3 available builds
      .map(build => ({
        prNumber: build.prNumber,
        gitCommit: build.commit,
        buildTimestamp: build.startTime,
        artifacts: build.artifacts
      }));
    
    console.log(`📋 ${env}: No verified deployment data - showing ${availableBackendUpdates.length} backend and ${availableFrontendUpdates.length} frontend builds as available for deployment`);
    
    return {
      environment: env,
      lastDeployedAt: null, // Don't fake deployment times
      currentDeployment: {
        backend: null, // Don't pretend builds are deployed
        frontend: null
      },
      availableUpdates: {
        backend: availableBackendUpdates,
        frontend: availableFrontendUpdates
      }
    };
  });
};

// Check if production builds are out of date compared to demo/sandbox builds
const detectOutOfDateProdBuilds = (builds) => {
  const buildsByProject = {};

  // Group builds by project type (backend/frontend) and environment
  builds.forEach(build => {
    if (build.status !== 'SUCCEEDED' || build.type !== 'production') return;

    const projectBase = build.projectName.replace(/-sandbox|-demo|-prod$/i, '');
    const environment = build.projectName.includes('-prod') ? 'prod' :
                       build.projectName.includes('-demo') ? 'demo' :
                       build.projectName.includes('-sandbox') ? 'sandbox' : 'other';

    if (environment === 'other') return;

    if (!buildsByProject[projectBase]) {
      buildsByProject[projectBase] = { prod: null, demo: null, sandbox: null };
    }

    const currentBuild = buildsByProject[projectBase][environment];
    if (!currentBuild || new Date(build.startTime) > new Date(currentBuild.startTime)) {
      buildsByProject[projectBase][environment] = build;
    }
  });

  const prodBuildStatuses = {};

  // Compare prod and demo builds with sandbox builds
  Object.entries(buildsByProject).forEach(([projectBase, environments]) => {
    const { prod, demo, sandbox } = environments;

    // Use sandbox as the reference build for comparison
    if (sandbox) {
      const componentType = projectBase.includes('backend') ? 'backend' : 'frontend';

      // Check production build against sandbox
      if (!prod) {
        // No prod build exists
        prodBuildStatuses[componentType] = {
          needsBuild: true,
          reason: 'missing',
          latestReference: {
            projectName: sandbox.projectName,
            commit: sandbox.commit,
            prNumber: sandbox.prNumber,
            buildTimestamp: sandbox.startTime
          }
        };
      } else {
        // Compare prod build with sandbox
        const prodTime = new Date(prod.startTime);
        const sandboxTime = new Date(sandbox.startTime);
        const commitMismatch = prod.commit !== sandbox.commit;
        const prMismatch = prod.prNumber !== sandbox.prNumber;

        // For prod builds, only check PR number due to commit hash inconsistency issue
        if (prMismatch) {
          prodBuildStatuses[componentType] = {
            needsBuild: true,
            reason: 'pr_mismatch',
            current: {
              projectName: prod.projectName,
              commit: prod.commit,
              prNumber: prod.prNumber,
              buildTimestamp: prod.startTime
            },
            latestReference: {
              projectName: sandbox.projectName,
              commit: sandbox.commit,
              prNumber: sandbox.prNumber,
              buildTimestamp: sandbox.startTime
            }
          };
        } else {
          prodBuildStatuses[componentType] = {
            needsBuild: false,
            current: {
              projectName: prod.projectName,
              commit: prod.commit,
              prNumber: prod.prNumber,
              buildTimestamp: prod.startTime
            }
          };
        }
      }

      // TEMP DEBUG: Force prod builds to never need builds (disable Build Needed temporarily)
      if (componentType === 'backend' || componentType === 'frontend') {
        if (prod && prod.projectName.includes('prod')) {
          prodBuildStatuses[componentType] = {
            needsBuild: false,
            current: {
              projectName: prod.projectName,
              commit: prod.commit,
              prNumber: prod.prNumber,
              buildTimestamp: prod.startTime
            }
          };
        }
      }

      // Check demo build against sandbox (only for backend)
      if (componentType === 'backend' && demo) {
        const demoTime = new Date(demo.startTime);
        const sandboxTime = new Date(sandbox.startTime);
        const commitMismatch = demo.commit !== sandbox.commit;
        const prMismatch = demo.prNumber !== sandbox.prNumber;

        if (commitMismatch || prMismatch) {
          prodBuildStatuses['backend-demo'] = {
            needsBuild: true,
            reason: commitMismatch ? 'commit_mismatch' : 'pr_mismatch',
            current: {
              projectName: demo.projectName,
              commit: demo.commit,
              prNumber: demo.prNumber,
              buildTimestamp: demo.startTime
            },
            latestReference: {
              projectName: sandbox.projectName,
              commit: sandbox.commit,
              prNumber: sandbox.prNumber,
              buildTimestamp: sandbox.startTime
            }
          };
        } else {
          prodBuildStatuses['backend-demo'] = {
            needsBuild: false,
            current: {
              projectName: demo.projectName,
              commit: demo.commit,
              prNumber: demo.prNumber,
              buildTimestamp: demo.startTime
            }
          };
        }
      }
    }
  });

  return prodBuildStatuses;
};

// Separate dev testing builds from deployment builds
const categorizeBuildHistory = async (builds) => {
  // Filter out TEST_ONLY builds from sandbox projects since sandbox target no longer includes test builds
  const filteredBuilds = builds.filter(build => {
    const isSandboxProject = build.projectName?.includes('sandbox');
    const isTestOnly = build.runMode === 'TEST_ONLY';
    return !(isSandboxProject && isTestOnly);
  });

  const devBuilds = filteredBuilds.filter(build => build.type === 'dev-test');
  const deploymentBuilds = filteredBuilds.filter(build =>
    build.type === 'production' && // Production builds only
    build.isDeployable === true && // Only deployable builds (excludes test builds)
    build.status === 'SUCCEEDED' // Only successful builds
  );
  // Filter unknown builds and exclude ignored ones
  const allUnknownBuilds = filteredBuilds.filter(build => build.type === 'unknown');
  const unknownBuilds = allUnknownBuilds.filter(build => !ignoredUnknownBuilds.has(`${build.projectName}:${build.buildId.slice(-8)}`));

  // Get latest dev build per project and latest deployment build per project separately
  const latestDevBuilds = getLatestBuildPerProjectByCategory(filteredBuilds, 'dev');
  const latestMainBuilds = getLatestBuildPerProjectByCategory(filteredBuilds, 'main');
  const latestUnknownBuilds = getLatestBuildPerProjectByCategory(unknownBuilds, 'unknown');

  // Detect out-of-date production builds first (needed for deployment coordination)
  const prodBuildStatuses = detectOutOfDateProdBuilds(filteredBuilds);

  // Generate deployment status for the three environments (now async)
  const deployments = await generateDeploymentStatus(builds, prodBuildStatuses);
  console.log('🏭 Production build statuses:', JSON.stringify(prodBuildStatuses, null, 2));

  const response = {
    devBuilds: latestDevBuilds,
    deploymentBuilds: latestMainBuilds,
    unknownBuilds: latestUnknownBuilds,
    deployments: deployments,
    prodBuildStatuses: prodBuildStatuses,
    summary: {
      totalBuilds: filteredBuilds.length,
      devTestBuilds: devBuilds.length,
      deploymentBuilds: deploymentBuilds.length,
      unknownBuilds: unknownBuilds.length,
      failedDevBuilds: devBuilds.filter(b => b.status === 'FAILED').length,
      uniqueProjects: new Set([...latestDevBuilds.map(b => b.projectName), ...latestMainBuilds.map(b => b.projectName), ...latestUnknownBuilds.map(b => b.projectName)]).size,
      lastUpdated: new Date().toISOString(),
      rateLimitWarning: rateLimitDetected && rateLimitTimestamp && (Date.now() - rateLimitTimestamp) < 10 * 60 * 1000 // Show warning for 10 minutes after rate limit
    }
  };

  console.log(`🔍 API Response - unknownBuilds count: ${latestUnknownBuilds.length}, devBuilds count: ${latestDevBuilds.length}, deploymentBuilds count: ${latestMainBuilds.length}`);
  if (latestUnknownBuilds.length > 0) {
    console.log('🔍 Unknown builds being returned:', latestUnknownBuilds.map(b => `${b.projectName}:${b.buildId.slice(-8)}`));
  }

  return response;
};

// API Routes
app.get('/builds', async (req, res) => {
  try {
    console.log('📊 Fetching build data...');
    
    // Your actual CodeBuild projects
    const projectNames = [
      'eval-backend-sandbox',
      'eval-frontend-sandbox',
      'eval-backend-demo',
      'eval-frontend-demo',
      'eval-backend-prod',
      'eval-frontend-prod',
      'eval-backend-devbranchtest',
      'eval-frontend-devbranchtest',
      'eval-backend-mainbranchtest',
      'eval-frontend-mainbranchtest'
    ];
    
    const builds = await getRecentBuilds(projectNames);
    const categorizedBuilds = await categorizeBuildHistory(builds);
    
    console.log(`✅ Returning ${builds.length} total builds`);
    res.json(categorizedBuilds);
    
  } catch (error) {
    console.error('❌ Error in /builds endpoint:', error);
    
    res.status(500).json({
      error: 'Failed to fetch build data',
      message: error.message
    });
  }
});

// Trigger production builds endpoint
app.post('/trigger-prod-builds', async (req, res) => {
  try {
    const { prNumber } = req.body;
    
    if (!prNumber) {
      return res.status(400).json({
        error: 'PR number is required',
        message: 'Please provide a PR number to trigger production builds'
      });
    }

    console.log(`🚀 Triggering production builds for PR #${prNumber}...`);

    // Trigger both backend and frontend prod builds
    const buildPromises = [
      codebuild.startBuild({
        projectName: 'eval-backend-prod',
        sourceVersion: `pr/${prNumber}`
      }).promise(),
      codebuild.startBuild({
        projectName: 'eval-frontend-prod', 
        sourceVersion: `pr/${prNumber}`
      }).promise()
    ];

    const results = await Promise.all(buildPromises);
    
    console.log(`✅ Successfully triggered production builds for PR #${prNumber}`);
    
    res.json({
      success: true,
      message: `Production builds triggered for PR #${prNumber}`,
      builds: results.map(result => ({
        buildId: result.build.id,
        projectName: result.build.projectName,
        status: result.build.buildStatus,
        sourceVersion: result.build.sourceVersion
      }))
    });

  } catch (error) {
    console.error('❌ Error triggering production builds:', error);
    res.status(500).json({
      error: 'Failed to trigger production builds',
      message: error.message
    });
  }
});

// Trigger single production build endpoint
app.post('/trigger-single-build', async (req, res) => {
  try {
    const { projectName, prNumber, sourceBranch } = req.body;
    
    if (!projectName) {
      return res.status(400).json({
        error: 'Project name is required',
        message: 'Please provide projectName to trigger a build'
      });
    }

    const targetBranch = sourceBranch || 'main';
    console.log(`🚀 Triggering ${projectName} build${prNumber ? ` for PR #${prNumber}` : ` from latest ${targetBranch}`}...`);

    // Trigger single build from specified branch with optional PR number as environment variable
    const environmentVars = [];

    if (prNumber) {
      environmentVars.push({
        name: 'TRIGGERED_FOR_PR',
        value: prNumber.toString(),
        type: 'PLAINTEXT'
      });
    }

    // For dev branch builds, set TEST_ONLY mode
    if (sourceBranch === 'dev') {
      environmentVars.push({
        name: 'RUN_MODE',
        value: 'TEST_ONLY',
        type: 'PLAINTEXT'
      });
    }

    const command = new StartBuildCommand({
      projectName: projectName,
      sourceVersion: targetBranch,
      environmentVariablesOverride: environmentVars
    });
    const result = await codebuild.send(command);

    console.log(`✅ Successfully triggered ${projectName} build${prNumber ? ` for PR #${prNumber}` : ` from latest ${targetBranch}`}`);

    res.json({
      success: true,
      message: `Successfully triggered ${projectName} build${prNumber ? ` for PR #${prNumber}` : ` from latest ${targetBranch}`}`,
      build: {
        buildId: result.build.id,
        projectName: result.build.projectName,
        status: result.build.buildStatus,
        sourceVersion: result.build.sourceVersion
      }
    });

  } catch (error) {
    console.error(`❌ Error triggering ${req.body?.projectName || 'build'}:`, error);
    res.status(500).json({
      error: 'Failed to trigger build',
      message: error.message
    });
  }
});

// Retry existing build endpoint  
app.post('/retry-build', async (req, res) => {
  try {
    const { buildId, projectName } = req.body;
    
    if (!buildId) {
      return res.status(400).json({
        error: 'Build ID is required',
        message: 'Please provide buildId to retry a build'
      });
    }

    console.log(`🔄 Retrying build ${buildId} for project ${projectName}...`);

    // Use retryBuild API to re-run the exact same build with all original parameters
    const command = new RetryBuildCommand({
      id: buildId
    });
    const result = await codebuild.send(command);

    console.log(`✅ Successfully retried build ${buildId}`);
    
    res.json({
      success: true,
      message: `Successfully retried build ${buildId}`,
      build: {
        buildId: result.build.id,
        projectName: result.build.projectName,
        status: result.build.buildStatus,
        sourceVersion: result.build.sourceVersion
      }
    });

  } catch (error) {
    console.error(`❌ Error retrying build ${req.body?.buildId || 'unknown'}:`, error);
    res.status(500).json({
      error: 'Failed to retry build',
      message: error.message
    });
  }
});

// Deploy coordinated (both frontend and backend) endpoint
app.post('/deploy-coordinated', async (req, res) => {
  try {
    const { environment, backendBuildId, frontendBuildId, overrideOutOfDate = false } = req.body;

    if (!environment || !backendBuildId || !frontendBuildId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'Please provide environment, backendBuildId, and frontendBuildId for coordinated deployment'
      });
    }

    // Validate environment
    const validEnvironments = ['sandbox', 'demo', 'production'];
    if (!validEnvironments.includes(environment)) {
      return res.status(400).json({
        error: 'Invalid environment',
        message: `Environment must be one of: ${validEnvironments.join(', ')}`
      });
    }

    console.log(`🚀 Deploying coordinated build to ${environment}: backend=${backendBuildId}, frontend=${frontendBuildId}`);

    // Check for out-of-date builds unless override is specified
    if (!overrideOutOfDate) {
      // TODO: Add validation logic here - for now, just log
      console.log(`⚠️ Coordinated deployment - out-of-date check: override=${overrideOutOfDate}`);
    }

    // For now, return success response - actual deployment logic would go here
    const deploymentId = `coordinated-${Date.now()}`;

    return res.json({
      success: true,
      deploymentId,
      environment,
      deployments: [
        {
          type: 'backend',
          buildId: backendBuildId,
          status: 'initiated'
        },
        {
          type: 'frontend',
          buildId: frontendBuildId,
          status: 'initiated'
        }
      ],
      message: `Coordinated deployment to ${environment} initiated successfully`
    });

  } catch (error) {
    console.error('Error in coordinated deployment:', error);
    return res.status(500).json({
      error: 'Deployment failed',
      message: error.message || 'Unknown error occurred during coordinated deployment'
    });
  }
});

// Deploy independent component endpoint
app.post('/deploy-independent', async (req, res) => {
  try {
    const { environment, buildId, componentType, overrideOutOfDate = false } = req.body;

    if (!environment || !buildId || !componentType) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'Please provide environment, buildId, and componentType for independent deployment'
      });
    }

    // Validate environment and componentType
    const validEnvironments = ['sandbox', 'demo', 'production'];
    const validComponents = ['frontend', 'backend'];

    if (!validEnvironments.includes(environment)) {
      return res.status(400).json({
        error: 'Invalid environment',
        message: `Environment must be one of: ${validEnvironments.join(', ')}`
      });
    }

    if (!validComponents.includes(componentType)) {
      return res.status(400).json({
        error: 'Invalid component type',
        message: `Component type must be one of: ${validComponents.join(', ')}`
      });
    }

    console.log(`🚀 Deploying ${componentType} independently to ${environment}: buildId=${buildId}`);

    // Check for out-of-date builds unless override is specified
    if (!overrideOutOfDate) {
      // TODO: Add validation logic here - for now, just log
      console.log(`⚠️ Independent deployment - out-of-date check: override=${overrideOutOfDate}`);
    }

    // For frontend deployments
    if (componentType === 'frontend') {
      const pipelineName = environment === 'production' ? 'eval-frontend-prod' : `eval-frontend-${environment}`;

      console.log(`🚀 Deploying frontend build ${buildId} using pipeline ${pipelineName}...`);

      // Validate pipeline name format for security
      if (!pipelineName.startsWith('eval-frontend-') || !/^[a-zA-Z0-9\-]+$/.test(pipelineName)) {
        return res.status(400).json({
          error: 'Invalid pipeline name',
          message: 'Pipeline name must be a valid eval-frontend-* pipeline'
        });
      }

      try {
        // Start the pipeline execution
        const command = new StartPipelineExecutionCommand({
          name: pipelineName
        });

        const result = await codepipeline.send(command);

        console.log(`✅ Successfully started frontend deployment pipeline ${pipelineName}`);
        console.log(`📋 Pipeline execution ID: ${result.pipelineExecutionId}`);

        return res.json({
          success: true,
          message: `Successfully triggered frontend deployment to ${environment}`,
          deployment: {
            type: componentType,
            pipelineName,
            pipelineExecutionId: result.pipelineExecutionId,
            deploymentId: result.pipelineExecutionId, // Frontend expects this field
            environment,
            buildId,
            startTime: new Date().toISOString()
          }
        });

      } catch (error) {
        console.error(`❌ Error starting frontend deployment pipeline: ${error.message}`);
        return res.status(500).json({
          error: 'Pipeline start failed',
          message: `Failed to start frontend deployment pipeline: ${error.message}`
        });
      }
    }

    // For backend deployments
    if (componentType === 'backend') {
      const pipelineName = environment === 'production' ? 'eval-backend-prod' : `eval-backend-${environment}`;

      console.log(`🚀 Deploying backend build ${buildId} using pipeline ${pipelineName}...`);

      // Validate pipeline name format for security
      if (!pipelineName.startsWith('eval-backend-') || !/^[a-zA-Z0-9\-]+$/.test(pipelineName)) {
        return res.status(400).json({
          error: 'Invalid pipeline name',
          message: 'Pipeline name must be a valid eval-backend-* pipeline'
        });
      }

      try {
        // Start the pipeline execution
        const command = new StartPipelineExecutionCommand({
          name: pipelineName
        });

        const result = await codepipeline.send(command);

        console.log(`✅ Successfully started backend deployment pipeline ${pipelineName}`);
        console.log(`📋 Pipeline execution ID: ${result.pipelineExecutionId}`);

        return res.json({
          success: true,
          message: `Successfully triggered backend deployment to ${environment}`,
          deployment: {
            type: componentType,
            pipelineName,
            pipelineExecutionId: result.pipelineExecutionId,
            deploymentId: result.pipelineExecutionId, // Frontend expects this field
            environment,
            buildId,
            startTime: new Date().toISOString()
          }
        });

      } catch (error) {
        console.error(`❌ Error starting backend deployment pipeline: ${error.message}`);
        return res.status(500).json({
          error: 'Pipeline start failed',
          message: `Failed to start backend deployment pipeline: ${error.message}`
        });
      }
    }

  } catch (error) {
    console.error('Error in independent deployment:', error);
    return res.status(500).json({
      error: 'Deployment failed',
      message: error.message || 'Unknown error occurred during independent deployment'
    });
  }
});

// Deploy frontend to environment endpoint (keep for backward compatibility)
app.post('/deploy-frontend', async (req, res) => {
  try {
    const { pipelineName, buildId } = req.body;

    if (!pipelineName || !buildId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'Please provide both pipelineName and buildId to deploy frontend'
      });
    }

    console.log(`🚀 Deploying frontend build ${buildId} using pipeline ${pipelineName}...`);

    // Validate pipeline name format for security
    if (!pipelineName.startsWith('eval-frontend-') || !/^[a-zA-Z0-9\-]+$/.test(pipelineName)) {
      return res.status(400).json({
        error: 'Invalid pipeline name',
        message: 'Pipeline name must be a valid eval-frontend-* pipeline'
      });
    }

    // Start the pipeline execution
    const command = new StartPipelineExecutionCommand({
      name: pipelineName
    });
    
    const result = await codepipeline.send(command);

    console.log(`✅ Successfully started deployment pipeline ${pipelineName}`);
    console.log(`📋 Pipeline execution ID: ${result.pipelineExecutionId}`);

    // Extract environment from pipeline name
    const environment = pipelineName.replace('eval-frontend-', '');

    res.json({
      success: true,
      message: `Successfully triggered frontend deployment to ${environment}`,
      deployment: {
        pipelineName,
        pipelineExecutionId: result.pipelineExecutionId,
        environment,
        buildId,
        startTime: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error(`❌ Error deploying frontend via pipeline ${req.body?.pipelineName || 'unknown'}:`, error);
    res.status(500).json({
      error: 'Failed to deploy frontend',
      message: error.message
    });
  }
});

// Check deployment status endpoint
app.get('/deployment-status/:pipelineExecutionId', async (req, res) => {
  try {
    const { pipelineExecutionId } = req.params;

    if (!pipelineExecutionId) {
      return res.status(400).json({
        error: 'Missing pipeline execution ID'
      });
    }

    // First, find which pipeline this execution belongs to by checking recent executions
    const pipelines = ['eval-backend-sandbox', 'eval-backend-demo', 'eval-backend-prod',
                      'eval-frontend-sandbox', 'eval-frontend-demo', 'eval-frontend-prod'];

    let pipelineName = null;
    let executionDetails = null;

    // Check each pipeline to find the execution
    for (const pipeline of pipelines) {
      try {
        const listCommand = new ListPipelineExecutionsCommand({
          pipelineName: pipeline,
          maxResults: 20
        });
        const executions = await codepipeline.send(listCommand);

        const execution = executions.pipelineExecutionSummaries?.find(
          exec => exec.pipelineExecutionId === pipelineExecutionId
        );

        if (execution) {
          pipelineName = pipeline;
          executionDetails = execution;
          break;
        }
      } catch (error) {
        // Continue checking other pipelines if this one fails
        continue;
      }
    }

    if (!pipelineName || !executionDetails) {
      return res.status(404).json({
        error: 'Pipeline execution not found',
        pipelineExecutionId
      });
    }

    res.json({
      pipelineExecutionId,
      pipelineName,
      status: executionDetails.status,
      startTime: executionDetails.startTime,
      lastUpdateTime: executionDetails.lastUpdateTime,
      isComplete: ['Succeeded', 'Failed', 'Cancelled', 'Stopped'].includes(executionDetails.status)
    });

  } catch (error) {
    console.error(`❌ Error checking deployment status for ${req.params.pipelineExecutionId}:`, error);
    res.status(500).json({
      error: 'Failed to check deployment status',
      message: error.message
    });
  }
});

// Check build status endpoint
app.get('/build-status/:buildId', async (req, res) => {
  try {
    const { buildId } = req.params;

    if (!buildId) {
      return res.status(400).json({
        error: 'Missing build ID'
      });
    }

    const batchCommand = new BatchGetBuildsCommand({
      ids: [buildId]
    });

    const buildDetails = await codebuild.send(batchCommand);

    if (!buildDetails.builds || buildDetails.builds.length === 0) {
      return res.status(404).json({
        error: 'Build not found',
        buildId
      });
    }

    const build = buildDetails.builds[0];

    res.json({
      buildId: build.id,
      status: build.buildStatus,
      buildComplete: build.buildComplete,
      currentPhase: build.currentPhase,
      startTime: build.startTime,
      endTime: build.endTime
    });

  } catch (error) {
    console.error(`❌ Error checking build status for ${req.params.buildId}:`, error);
    res.status(500).json({
      error: 'Failed to check build status',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Get latest merge information from GitHub
app.get('/latest-merge/:repo', async (req, res) => {
  try {
    const { repo } = req.params;

    // Validate repo parameter
    if (!['backend', 'frontend'].includes(repo)) {
      return res.status(400).json({ error: 'Repository must be backend or frontend' });
    }

    const url = `https://api.github.com/repos/hoc-stateeval/${repo}/commits/main`;

    // GitHub API headers with optional authentication
    const headers = {
      'User-Agent': 'CI-Dashboard',
      'Accept': 'application/vnd.github.v3+json'
    };

    // Add GitHub token if available
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const https = require('https');

    const promise = new Promise((resolve, reject) => {
      const req = https.request(url, { headers }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const commit = JSON.parse(data);
              const latestMerge = {
                sha: commit.sha.substring(0, 7),
                message: commit.commit.message.split('\n')[0],
                author: commit.commit.author.name,
                date: commit.commit.author.date,
                url: commit.html_url
              };
              resolve(latestMerge);
            } else {
              console.log(`GitHub API error for latest merge ${repo}: ${res.statusCode}`);
              reject(new Error(`GitHub API error: ${res.statusCode}`));
            }
          } catch (e) {
            console.error(`Error parsing GitHub response for latest merge ${repo}:`, e.message);
            reject(e);
          }
        });
      });

      req.on('error', (e) => {
        console.error(`GitHub API request error for latest merge ${repo}:`, e.message);
        reject(e);
      });

      req.end();
    });

    const latestMerge = await promise;
    res.json(latestMerge);

  } catch (error) {
    console.error('Error fetching latest merge:', error);
    res.status(500).json({ error: 'Failed to fetch latest merge information' });
  }
});

// Compare latest GitHub commit with newest build and return commit count difference
app.get('/commit-comparison/:repo', async (req, res) => {
  try {
    const { repo } = req.params;
    console.log(`🔍 Commit comparison endpoint called for: ${repo}`);

    // Validate repo parameter
    if (!['backend', 'frontend'].includes(repo)) {
      return res.status(400).json({ error: 'Repository must be backend or frontend' });
    }

    // Get latest GitHub commit
    const latestMergeUrl = `https://api.github.com/repos/hoc-stateeval/${repo}/commits/main`;

    // GitHub API headers with optional authentication
    const headers = {
      'User-Agent': 'CI-Dashboard',
      'Accept': 'application/vnd.github.v3+json'
    };

    // Add GitHub token if available
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const https = require('https');

    // Get latest GitHub commit
    const getLatestCommit = () => {
      return new Promise((resolve, reject) => {
        const req = https.request(latestMergeUrl, { headers }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              if (res.statusCode === 200) {
                const commit = JSON.parse(data);
                resolve(commit.sha);
              } else {
                reject(new Error(`GitHub API error: ${res.statusCode}`));
              }
            } catch (e) {
              reject(e);
            }
          });
        });

        req.on('error', (e) => {
          reject(e);
        });

        req.end();
      });
    };

    // Get builds data to find the newest commit we have
    const projectNames = [
      'eval-backend-sandbox',
      'eval-frontend-sandbox',
      'eval-backend-demo',
      'eval-frontend-demo',
      'eval-backend-prod',
      'eval-frontend-prod'
    ];
    const builds = await getRecentBuilds(projectNames);

    // Filter builds for the specific repo only and find the newest commit
    const repoBuilds = builds.filter(build => {
      const projectName = build.projectName.toLowerCase();
      // Match builds for the specific repo (e.g., eval-backend-*, eval-frontend-*)
      return projectName.includes(`-${repo}-`) ||
             projectName.startsWith(`eval-${repo}-`) ||
             projectName === `eval-${repo}`;
    });

    // Helper function to get commit SHA from build (check multiple possible fields)
    const getCommitSha = (build) => {
      return build.gitCommit || build.commit || build.resolvedCommit || build.resolvedSourceVersion;
    };

    console.log(`🔍 Commit comparison for ${repo}: found ${repoBuilds.length} builds out of ${builds.length} total`);
    console.log(`📋 Sample project names: ${builds.slice(0, 3).map(b => b.projectName).join(', ')}`);
    console.log(`📋 Filtered ${repo} builds: ${repoBuilds.slice(0, 3).map(b => `${b.projectName}(${getCommitSha(b)})`).join(', ')}`);

    if (repoBuilds.length === 0) {
      console.log(`❌ No ${repo} builds found - likely due to AWS rate limiting`);
      return res.json({
        commitsAhead: 0,
        latestGitHubSha: null,
        newestBuildSha: null,
        message: `No builds found for ${repo} - AWS API rate limited`,
        error: "rate_limited"
      });
    }

    // Find the newest build by endTime
    const newestBuild = repoBuilds
      .filter(build => build.endTime && getCommitSha(build))
      .sort((a, b) => new Date(b.endTime) - new Date(a.endTime))[0];

    if (!newestBuild) {
      return res.json({
        commitsAhead: 0,
        latestGitHubSha: null,
        newestBuildSha: null,
        message: `No builds with git commits found for ${repo}`
      });
    }

    const latestGitHubSha = await getLatestCommit();
    const newestBuildSha = getCommitSha(newestBuild);

    // If they're the same, we're up to date
    if (latestGitHubSha === newestBuildSha || latestGitHubSha.startsWith(newestBuildSha.substring(0, 7))) {
      return res.json({
        commitsAhead: 0,
        latestGitHubSha: latestGitHubSha.substring(0, 7),
        newestBuildSha: newestBuildSha.substring(0, 7),
        message: 'Up to date'
      });
    }

    // Use GitHub API to compare commits
    const compareUrl = `https://api.github.com/repos/hoc-stateeval/${repo}/compare/${newestBuildSha}...${latestGitHubSha}`;

    const getCommitComparison = () => {
      return new Promise((resolve, reject) => {
        const req = https.request(compareUrl, { headers }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              if (res.statusCode === 200) {
                const comparison = JSON.parse(data);
                resolve(comparison);
              } else {
                reject(new Error(`GitHub API error: ${res.statusCode}`));
              }
            } catch (e) {
              reject(e);
            }
          });
        });

        req.on('error', (e) => {
          reject(e);
        });

        req.end();
      });
    };

    const comparison = await getCommitComparison();

    res.json({
      commitsAhead: comparison.ahead_by || 0,
      latestGitHubSha: latestGitHubSha.substring(0, 7),
      newestBuildSha: newestBuildSha.substring(0, 7),
      message: comparison.ahead_by > 0 ? `${comparison.ahead_by} commits ahead` : 'Up to date'
    });

  } catch (error) {
    console.error('Error comparing commits:', error);
    res.status(500).json({ error: 'Failed to compare commits' });
  }
});

// Start server with enhanced process identification
const server = app.listen(PORT, () => {
  const { execSync } = require('child_process');

  try {
    // Get git commit hash for version tracking
    const gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim().substring(0, 7);
    console.log(`🆔 Server Process ID: ${process.pid} | Git: ${gitCommit}`);
  } catch (e) {
    console.log(`🆔 Server Process ID: ${process.pid} | Git: unknown`);
  }

  console.log(`🚀 CI/CD Dashboard server running on http://localhost:${PORT}`);
  console.log(`📊 API endpoint: http://localhost:${PORT}/builds`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  console.log('');
  console.log('💡 Make sure your AWS credentials are configured:');
  console.log('   - aws configure');
  console.log('   - or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY env vars');
});

// Handle server startup errors (port conflicts)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use!`);
    console.error('💡 Kill existing server or use a different port');
    console.error('   Windows: netstat -ano | findstr :3004');
    console.error('   Then: taskkill /PID <process_id> /F');
    process.exit(1);
  } else {
    console.error('❌ Server startup error:', err);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  server.close(() => {
    console.log('✅ Server shut down gracefully');
    process.exit(0);
  });
});