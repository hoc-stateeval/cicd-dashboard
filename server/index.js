require('dotenv').config();
const express = require('express');
const cors = require('cors');
const basicAuth = require('express-basic-auth');
const { CodeBuildClient, BatchGetBuildsCommand, ListBuildsForProjectCommand, BatchGetProjectsCommand, StartBuildCommand, RetryBuildCommand } = require('@aws-sdk/client-codebuild');
const { CloudWatchLogsClient, GetLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { CodePipelineClient, ListPipelinesCommand, GetPipelineCommand, ListPipelineExecutionsCommand, GetPipelineExecutionCommand, StartPipelineExecutionCommand } = require('@aws-sdk/client-codepipeline');
const { S3Client, GetObjectCommand, ListObjectVersionsCommand } = require('@aws-sdk/client-s3');
const https = require('https');
const githubAPI = require('./github-api');

const app = express();
const PORT = process.env.PORT || 3004;

// Unified function to map project names to GitHub repository names
const getRepoFromProject = (projectName) => {
  return projectName?.includes('backend') ? 'backend' : 'frontend';
};

// Enable CORS for frontend
app.use(cors());
app.use(express.json());

// Add /api route aliases for frontend compatibility BEFORE authentication
// This allows the frontend to call /api/builds which redirects to /builds
app.use('/api', (req, res, next) => {
  console.log(`🔧 API middleware: ${req.method} ${req.originalUrl} -> ${req.url.replace(/^\/api/, '') || '/'}`);
  // Remove /api prefix and continue to the actual route handlers
  req.url = req.url.replace(/^\/api/, '') || '/';
  next();
});

// Add basic authentication in production (but not in development)
if (process.env.NODE_ENV === 'production') {
  const authUsers = {};

  // Get credentials from environment variables
  const authUsername = process.env.DASHBOARD_USERNAME || 'admin';
  const authPassword = process.env.DASHBOARD_PASSWORD || 'changeme123';

  authUsers[authUsername] = authPassword;

  app.use(basicAuth({
    users: authUsers,
    challenge: true,
    realm: 'CI/CD Dashboard'
  }));

  console.log(`🔐 Basic authentication enabled for production (username: ${authUsername})`);
} else {
  console.log('🔓 Development mode: No authentication required');
}

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION || 'us-west-2' });
const cloudwatchlogs = new CloudWatchLogsClient({ region: process.env.AWS_REGION || 'us-west-2' });
const codepipeline = new CodePipelineClient({ region: process.env.AWS_REGION || 'us-west-2' });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' });

// Static list of ignored unknown build IDs
// Add build IDs here to hide them from the Unknown Builds table
const ignoredUnknownBuilds = new Set([
  // Starting fresh with new builds from today onwards (2025-09-15)
  // Add unknown build IDs here as needed: 'project-name:buildId'
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
// Cleared on 2025-09-15 for fresh start with new build data
const logDataCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper function to detect AWS API rate limiting errors
const isRateLimitError = (error) => {
  // Check for explicit rate limiting error codes
  if (error.name === 'ThrottlingException' || error.name === 'TooManyRequestsException') {
    return true;
  }

  // Check for HTTP status codes indicating rate limiting
  if (error.$metadata?.httpStatusCode === 429 || error.$metadata?.httpStatusCode === 403) {
    return true;
  }

  // Check for error messages that indicate rate limiting
  const message = error.message?.toLowerCase() || '';
  if (message.includes('rate limit') || message.includes('throttl') || message.includes('too many requests')) {
    return true;
  }

  return false;
}

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

  // Determine source branch from sourceVersion
  let sourceBranch = null;
  if (sourceVersion === 'refs/heads/main' || sourceVersion === 'main') {
    sourceBranch = 'main';
  } else if (sourceVersion === 'refs/heads/dev' || sourceVersion === 'dev') {
    sourceBranch = 'dev';
  } else if (sourceVersion?.startsWith('pr/')) {
    sourceBranch = 'feature'; // PR builds are from feature branches
  }

  // Handle new dedicated test targets first
  if (build.projectName.includes('devbranchtest')) {
    console.log(`Dev test build: ${build.projectName}:${finalPRNumber}`);
    return {
      type: 'dev-test',
      isDeployable: false,
      prNumber: actualPRNumber,
      sourceBranch: sourceBranch
    };
  }

  if (build.projectName.includes('mainbranchtest')) {
    console.log(`Main test build: ${build.projectName}:${finalPRNumber}`);
    return {
      type: 'main-test',
      isDeployable: false,
      prNumber: actualPRNumber,
      sourceBranch: sourceBranch
    };
  }

  // Default: production builds (anything not classified as test builds above)
  console.log(`Production build: ${build.projectName}:${finalPRNumber}`);

  // TODO: Add logic here to detect unknown builds if needed
  // Example criteria might be: specific project patterns, source branches, etc.
  // if (someUnknownCriteria) {
  //   console.log(`Unknown build type: ${build.projectName}:${build.id?.slice(-8)}`);
  //   return {
  //     type: 'unknown',
  //     isDeployable: false,
  //     prNumber: actualPRNumber,
  //     sourceBranch: sourceBranch
  //   };
  // }

  return {
    type: 'production',
    isDeployable: true,
    prNumber: actualPRNumber,
    sourceBranch: sourceBranch
  };
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
  
  // Get commit details from GitHub (includes message and other metadata)
  const commitDetails = await githubAPI.getCommitDetails(repo, commitSha);
  if (!commitDetails?.message) {
    console.log(`⚠️ Could not fetch commit details for ${repo}:${commitSha?.substring(0,8)} - possibly rate limited or auth issue`);
    return null;
  }
  const commitMessage = commitDetails.message;
  
  // Only extract PR numbers from actual PR merge patterns, not issue references
  // "Merge pull request #123 from feature-branch" - GitHub merge commits
  // "(#123)" - Squash merge format
  // "PR #123" - Explicit PR reference
  // Do NOT match standalone "#123" as these are often issue references in hotfix commits

  const patterns = [
    /Merge pull request #(\d+)/i,
    /\(#(\d+)\)/,
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



// Extract PR title from merge commit message as fallback
const extractPRTitleFromCommitMessage = (commitMessage) => {
  if (!commitMessage) return null;

  const lines = commitMessage.split('\n');

  // Check if this is a merge commit
  if (lines[0] && lines[0].includes('Merge pull request #')) {
    // GitHub merge commits have this structure:
    // Line 0: "Merge pull request #123 from branch-name"
    // Line 1: "" (empty)
    // Line 2+: Actual PR title and description

    if (lines.length >= 3 && lines[2]?.trim()) {
      return lines[2].trim();
    }
  }

  return null;
};

// Cross-reference PR numbers between builds with same commit hash (legacy function)
const findPRFromGitHub = async (build) => {
  if (!build.resolvedSourceVersion) return null;

  const commitSha = build.resolvedSourceVersion;
  const repo = getRepoFromProject(build.projectName);

  const prDetails = await githubAPI.getPRDetails(commitSha, repo);
  return prDetails?.number || null;
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
    hotfixDetails = await githubAPI.getCommitDetails(repo, build.resolvedSourceVersion);

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
  
  // For PR builds, fetch commit details and PR details to show in tooltip
  let commitDetails = null;
  let prDetails = null;
  let prTitle = null;

  if ((prNumber || classification.prNumber) && build.resolvedSourceVersion && !hotfixDetails) {
    const repo = getRepoFromProject(build.projectName);

    // Fetch commit details (for author, date, etc.)
    commitDetails = await githubAPI.getCommitDetails(repo, build.resolvedSourceVersion);

    // Fetch PR details (for actual PR title)
    prDetails = await githubAPI.getPRDetails(build.resolvedSourceVersion, repo);

    if (prDetails?.title) {
      prTitle = prDetails.title;
      console.log(`🎯 Found PR title for ${build.projectName}:${build.id?.slice(-8)} - PR #${prDetails.number}: "${prTitle}"`);
    } else if (commitDetails?.message) {
      // Fallback: try to extract PR title from commit message
      prTitle = extractPRTitleFromCommitMessage(commitDetails.message);
      if (prTitle) {
        console.log(`📝 Extracted PR title from commit message for ${build.projectName}:${build.id?.slice(-8)}: "${prTitle}"`);
      }
    }

    if (commitDetails) {
      console.log(`📝 Fetched commit details for PR build ${build.projectName}:${build.id?.slice(-8)} - ${commitDetails.author?.name}`);
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
    commitMessage: commitDetails?.message || hotfixDetails?.message, // Commit message for tooltip
    prTitle: prTitle // PR title if available, for enhanced tooltip display
  };
};

// Get recent builds for specified projects
const getRecentBuilds = async (projectNames, maxBuilds = 10) => {
  const allBuilds = [];
  
  for (const projectName of projectNames) {
    try {
      console.log(`Fetching builds for project: ${projectName}`);
      
      // Get recent build IDs - limit at API level for efficiency
      const listCommand = new ListBuildsForProjectCommand({
        projectName,
        sortOrder: 'DESCENDING',
        maxResults: maxBuilds  // Limit at API level instead of slicing
      });

      const buildIds = await codebuild.send(listCommand);
      const recentBuildIds = buildIds.ids || [];
      
      if (recentBuildIds.length === 0) {
        console.log(`No builds found for ${projectName}`);
        continue;
      }
      
      // Get detailed build info
      const batchCommand = new BatchGetBuildsCommand({
        ids: recentBuildIds
      });
      
      const buildDetails = await codebuild.send(batchCommand);

      // Filter builds to only include those from Sept 15, 2025 onwards (new format only)
      const startDate = new Date('2025-09-15T00:00:00.000Z'); // September 15, 2025 at midnight UTC

      const todayBuilds = (buildDetails.builds || []).filter(build => {
        if (!build.startTime) return false;
        const buildDate = new Date(build.startTime);
        return buildDate >= startDate;
      });

      console.log(`Filtered to ${todayBuilds.length} builds from Sept 15, 2025 onwards (from ${buildDetails.builds?.length || 0} total)`);

      const processedBuilds = await Promise.all(
        todayBuilds.map(build => processBuild(build))
      );
      
      // Filter out null results (invalid builds)
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


// Get latest build per project for a specific build category
const getLatestBuildPerProjectByCategory = (builds, category) => {
  let filteredBuilds;
  switch (category) {
    case 'dev':
      filteredBuilds = builds.filter(build => build.type === 'dev-test');
      break;
    case 'main':
      filteredBuilds = builds.filter(build => build.type === 'production');
      break;
    case 'main-test':
      filteredBuilds = builds.filter(build => build.type === 'main-test');
      break;
    case 'unknown':
    default:
      filteredBuilds = builds.filter(build => build.type === 'unknown');
      break;
  }
    
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

  // Pipeline name is the same as the project name
  const searchProjectName = pipelineName;
  console.log(`   Using searchProjectName: ${searchProjectName}`);

  try {
    console.log(`      🔍 Getting source details for ${pipelineName} execution ${executionId}`);
    
    // Get pipeline execution details to find the actual source revision
    const getPipelineExecutionCommand = new GetPipelineExecutionCommand({
      pipelineName: pipelineName,
      pipelineExecutionId: executionId
    });
    
    const executionDetails = await codepipeline.send(getPipelineExecutionCommand);
    
    
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

/**
 * Get deployment status for all environments by correlating CodePipeline executions with CodeBuild artifacts
 *
 * This function:
 * 1. Fetches recent build history (100 builds per project) to find matches for deployed artifacts
 * 2. Lists all CodePipeline pipelines and their recent executions
 * 3. Extracts deployment artifacts (S3 locations, Docker image URIs) from pipeline executions
 * 4. Correlates deployed artifacts with CodeBuild builds using:
 *    - Method A: S3 artifact hash/location matching (most reliable)
 *    - Method B: Git commit SHA matching (fallback)
 * 5. Returns deployment status for sandbox, demo, and production environments
 *
 * The extended build history (100 vs 10 builds) is needed because deployments may reference
 * older builds that wouldn't appear in the limited dashboard view.
 *
 * @param {Array} builds - Build data from main API (not used directly, kept for compatibility)
 * @returns {Array} Array of environment deployment statuses with matched builds
 */
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

    // Fetch builds for each project separately with a limit of 10 builds per project
    const deploymentBuilds = [];
    for (const projectName of allProjectNames) {
      console.log(`Fetching 10 recent builds for ${projectName}...`);
      const projectBuilds = await getRecentBuilds([projectName], 10);
      deploymentBuilds.push(...projectBuilds);
    }
    
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
          
          // Filter pipeline executions to only include those from Sept 15, 2025 onwards
          const startDate = new Date('2025-09-15T00:00:00.000Z'); // September 15, 2025 at midnight UTC

          const todayExecutions = (executions.pipelineExecutionSummaries || []).filter(exec => {
            if (!exec.lastUpdateTime) return false;
            const execDate = new Date(exec.lastUpdateTime);
            return execDate >= startDate;
          });

          // Log all executions for debugging
          console.log(`    📋 Found ${executions.pipelineExecutionSummaries?.length || 0} total executions, ${todayExecutions.length} from Sept 15, 2025 onwards:`);
          todayExecutions.forEach((exec, idx) => {
            console.log(`      ${idx + 1}. ${exec.pipelineExecutionId} | ${exec.status} | ${exec.trigger?.triggerType || 'Unknown'} | ${exec.lastUpdateTime}`);
          });

          // Check for active (InProgress) deployments
          const activeExecution = todayExecutions.find(exec => exec.status === 'InProgress');
          const isActivelyDeploying = !!activeExecution;

          if (isActivelyDeploying) {
            console.log(`    🚀 Active deployment detected: ${activeExecution.pipelineExecutionId} (${pipeline.name})`);
          }

          // Prioritize StartPipelineExecution over CloudWatchEvent executions
          // Look for the most recent successful StartPipelineExecution first
          let successfulExecution = todayExecutions
            .filter(exec => exec.status === 'Succeeded')
            .find(exec => exec.trigger?.triggerType === 'StartPipelineExecution');

          // If no StartPipelineExecution found, fall back to any successful execution from today
          if (!successfulExecution) {
            successfulExecution = todayExecutions
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
            
            // Create deployment entry for both matched and unmatched builds
            if (buildInfo.matchedBuild && buildInfo.matchingMethod !== 'None') {
              // Valid matched build
              if (isBackend) {
                currentDeployment.backend = {
                  pipelineName: pipeline.name,
                  executionId: successfulExecution.pipelineExecutionId,
                  deployedAt: successfulExecution.lastUpdateTime?.toISOString(),
                  prNumber: buildInfo.prNumber,
                  gitCommit: buildInfo.gitCommit,
                  buildTimestamp: buildInfo.buildTimestamp || successfulExecution.lastUpdateTime?.toISOString(),
                  matchedBuild: buildInfo.matchedBuild,
                  matchingMethod: buildInfo.matchingMethod,
                  deploymentStatus: isActivelyDeploying ? 'DEPLOYING' : 'DEPLOYED'
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
                  matchingMethod: buildInfo.matchingMethod,
                  deploymentStatus: isActivelyDeploying ? 'DEPLOYING' : 'DEPLOYED'
                };
              }

              // Only track deployment time when we have a valid correlation
              if (!lastDeployedAt || successfulExecution.lastUpdateTime > new Date(lastDeployedAt)) {
                lastDeployedAt = successfulExecution.lastUpdateTime?.toISOString();
              }
            } else {
              // No matching build found - show "too old build" message
              console.log(`    ⚠️ Creating deployment entry for ${pipeline.name} with 'too old build' message (method: ${buildInfo.matchingMethod})`);

              if (isBackend) {
                currentDeployment.backend = {
                  pipelineName: pipeline.name,
                  executionId: successfulExecution.pipelineExecutionId,
                  deployedAt: successfulExecution.lastUpdateTime?.toISOString(),
                  prNumber: null,
                  gitCommit: buildInfo.gitCommit || 'Unknown',
                  buildTimestamp: successfulExecution.lastUpdateTime?.toISOString(),
                  matchedBuild: null,
                  matchingMethod: 'Too old build',
                  isTooOld: true,
                  deploymentStatus: isActivelyDeploying ? 'DEPLOYING' : 'DEPLOYED'
                };
              } else if (isFrontend) {
                currentDeployment.frontend = {
                  pipelineName: pipeline.name,
                  executionId: successfulExecution.pipelineExecutionId,
                  deployedAt: successfulExecution.lastUpdateTime?.toISOString(),
                  prNumber: null,
                  gitCommit: buildInfo.gitCommit || 'Unknown',
                  buildTimestamp: successfulExecution.lastUpdateTime?.toISOString(),
                  matchedBuild: null,
                  matchingMethod: 'Too old build',
                  isTooOld: true,
                  deploymentStatus: isActivelyDeploying ? 'DEPLOYING' : 'DEPLOYED'
                };
              }

              // Track deployment time even for unmatched builds
              if (!lastDeployedAt || successfulExecution.lastUpdateTime > new Date(lastDeployedAt)) {
                lastDeployedAt = successfulExecution.lastUpdateTime?.toISOString();
              }
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
    console.log('⚠️  No pipeline data available');
    // Return empty result instead of error status - let frontend handle gracefully
    return [];
  }
  
  // Enhance pipeline status with available updates from builds
  // Only include deployable builds for deployment correlation - exclude test builds
  const deploymentBuilds = builds.filter(build =>
    build.type === 'production' && // Production builds only
    build.isDeployable === true && // Only deployable builds (excludes test builds)
    build.status === 'SUCCEEDED' // Only successful builds
  );

  console.log(`🔍 DEBUG: deploymentBuilds count: ${deploymentBuilds.length}, sample hotfixDetails:`,
    deploymentBuilds.slice(0, 2).map(b => ({
      id: b.buildId?.slice(-8),
      project: b.projectName,
      hasHotfix: !!b.hotfixDetails?.isHotfix,
      sourceBranch: b.sourceBranch
    })));
  
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
          projectName: latestBackendBuild.projectName,
          matchedBuild: latestBackendBuild // Add full build object for consistent data structure
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
          projectName: latestFrontendBuild.projectName,
          matchedBuild: latestFrontendBuild // Add full build object for consistent data structure
        }]
      : [];
    
    console.log(`      🎯 DEBUG: Frontend artifacts for ${envName}:`, JSON.stringify(latestFrontendBuild?.artifacts, null, 2));
    console.log(`      🎯 DEBUG: availableFrontendUpdates for ${envName}:`, JSON.stringify(availableFrontendUpdates, null, 2));

    console.log(`      🎯 Available updates for ${envName}: backend=${availableBackendUpdates.length}, frontend=${availableFrontendUpdates.length}`);

    // Determine deployment coordination state
    // TEMPORARILY COMMENTED OUT - Using red indicators for deployment state instead
    // const deploymentCoordination = determineDeploymentState(
    //   availableBackendUpdates,
    //   availableFrontendUpdates,
    //   prodBuildStatuses,
    //   envName
    // );

    return {
      ...envStatus,
      availableUpdates: {
        backend: availableBackendUpdates,
        frontend: availableFrontendUpdates
      }
      // deploymentCoordination - TEMPORARILY COMMENTED OUT
    };
  });
  
  // Note: Removed flawed artifact-based rate limiting detection
  // Rate limiting should be detected from actual HTTP error responses, not missing data
  
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
        buildId: build.buildId,
        prNumber: build.prNumber,
        gitCommit: build.commit,
        buildTimestamp: build.startTime,
        artifacts: build.artifacts,
        projectName: build.projectName,
        matchedBuild: build // Add full build object for consistent data structure
      }));
      
    const availableFrontendUpdates = frontendBuilds
      .filter(build => build.status === 'SUCCESS' || build.status === 'SUCCEEDED')
      .slice(0, 3) // Show top 3 available builds
      .map(build => ({
        buildId: build.buildId,
        prNumber: build.prNumber,
        gitCommit: build.commit,
        buildTimestamp: build.startTime,
        artifacts: build.artifacts,
        projectName: build.projectName,
        matchedBuild: build // Add full build object for consistent data structure
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
      // if (componentType === 'backend' || componentType === 'frontend') {
      //   if (prod && prod.projectName.includes('prod')) {
      //     prodBuildStatuses[componentType] = {
      //       needsBuild: false,
      //       current: {
      //         projectName: prod.projectName,
      //         commit: prod.commit,
      //         prNumber: prod.prNumber,
      //         buildTimestamp: prod.startTime
      //       }
      //     };
      //   }
      // }

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
  // Filter out test builds from sandbox projects since sandbox target no longer includes test builds
  const filteredBuilds = builds.filter(build => {
    const isSandboxProject = build.projectName?.includes('sandbox');
    const isTestTarget = build.projectName?.includes('test'); // devbranchtest, mainbranchtest, etc.
    return !(isSandboxProject && isTestTarget);
  });

  const devBuilds = filteredBuilds.filter(build => build.type === 'dev-test');
  const deploymentBuilds = filteredBuilds.filter(build =>
    build.type === 'production' && // Production builds only
    build.isDeployable === true && // Only deployable builds (excludes test builds)
    build.status === 'SUCCEEDED' // Only successful builds
  );
  const mainTestBuilds = filteredBuilds.filter(build =>
    build.type === 'main-test' // Main branch test builds (already test-only by definition)
  );
  // Filter unknown builds and exclude ignored ones
  const allUnknownBuilds = filteredBuilds.filter(build => build.type === 'unknown');
  const unknownBuilds = allUnknownBuilds.filter(build => !ignoredUnknownBuilds.has(`${build.projectName}:${build.buildId.slice(-8)}`));

  // Get latest dev build per project and latest deployment build per project separately
  const latestDevBuilds = getLatestBuildPerProjectByCategory(filteredBuilds, 'dev');
  const latestMainBuilds = getLatestBuildPerProjectByCategory(filteredBuilds, 'main');
  const latestMainTestBuilds = getLatestBuildPerProjectByCategory(mainTestBuilds, 'main-test');
  const latestUnknownBuilds = getLatestBuildPerProjectByCategory(unknownBuilds, 'unknown');

  // Detect out-of-date production builds first (needed for deployment coordination)
  const prodBuildStatuses = detectOutOfDateProdBuilds(filteredBuilds);

  // Generate deployment status for the three environments (now async)
  const deployments = await generateDeploymentStatus(builds, prodBuildStatuses);
  console.log('🏭 Production build statuses:', JSON.stringify(prodBuildStatuses, null, 2));

  const response = {
    devBuilds: latestDevBuilds,
    deploymentBuilds: latestMainBuilds,
    mainTestBuilds: latestMainTestBuilds,
    unknownBuilds: latestUnknownBuilds,
    deployments: deployments,
    prodBuildStatuses: prodBuildStatuses,
    summary: {
      totalBuilds: filteredBuilds.length,
      devTestBuilds: devBuilds.length,
      deploymentBuilds: deploymentBuilds.length,
      mainTestBuilds: mainTestBuilds.length,
      unknownBuilds: unknownBuilds.length,
      failedDevBuilds: devBuilds.filter(b => b.status === 'FAILED').length,
      uniqueProjects: new Set([...latestDevBuilds.map(b => b.projectName), ...latestMainBuilds.map(b => b.projectName), ...latestMainTestBuilds.map(b => b.projectName), ...latestUnknownBuilds.map(b => b.projectName)]).size,
      lastUpdated: new Date().toISOString(),
      rateLimitWarning: false // Rate limiting now handled via HTTP error responses
    }
  };

  console.log(`🔍 API Response - unknownBuilds count: ${latestUnknownBuilds.length}, devBuilds count: ${latestDevBuilds.length}, deploymentBuilds count: ${latestMainBuilds.length}, mainTestBuilds count: ${latestMainTestBuilds.length}`);
  if (latestUnknownBuilds.length > 0) {
    console.log('🔍 Unknown builds being returned:', latestUnknownBuilds.map(b => `${b.projectName}:${b.buildId.slice(-8)}`));
  }

  return response;
};

// Shared Functions for Endpoint Logic

// Shared function for independent deployment (used by both /deploy-independent and /api/deploy-independent)
async function deployIndependentLogic(environment, buildId, componentType, overrideOutOfDate = false) {
  if (!environment || !buildId || !componentType) {
    throw new Error('Missing required parameters: Please provide environment, buildId, and componentType');
  }

  // Validate environment and componentType
  const validEnvironments = ['sandbox', 'demo', 'production'];
  const validComponents = ['frontend', 'backend'];

  if (!validEnvironments.includes(environment)) {
    const error = new Error(`Environment must be one of: ${validEnvironments.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  if (!validComponents.includes(componentType)) {
    const error = new Error(`Component type must be one of: ${validComponents.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  console.log(`🚀 Deploying ${componentType} independently to ${environment}: buildId=${buildId}`);

  // Check for out-of-date builds unless override is specified
  if (!overrideOutOfDate) {
    console.log(`⚠️ Independent deployment - out-of-date check: override=${overrideOutOfDate}`);
  }

  // For frontend deployments
  if (componentType === 'frontend') {
    const pipelineName = environment === 'production' ? 'eval-frontend-prod' : `eval-frontend-${environment}`;

    console.log(`🚀 Deploying frontend build ${buildId} using pipeline ${pipelineName}...`);

    // Validate pipeline name format for security
    if (!pipelineName.startsWith('eval-frontend-') || !/^[a-zA-Z0-9\-]+$/.test(pipelineName)) {
      const error = new Error('Pipeline name must be a valid eval-frontend-* pipeline');
      error.statusCode = 400;
      throw error;
    }

    try {
      const command = new StartPipelineExecutionCommand({
        name: pipelineName
      });

      const result = await codepipeline.send(command);

      console.log(`✅ Successfully started frontend deployment pipeline ${pipelineName}`);
      console.log(`📋 Pipeline execution ID: ${result.pipelineExecutionId}`);

      return {
        success: true,
        message: `Successfully triggered frontend deployment to ${environment}`,
        deployment: {
          type: componentType,
          pipelineName,
          pipelineExecutionId: result.pipelineExecutionId,
          deploymentId: result.pipelineExecutionId,
          environment,
          buildId,
          startTime: new Date().toISOString()
        }
      };

    } catch (error) {
      console.error(`❌ Error starting frontend deployment pipeline: ${error.message}`);
      const pipelineError = new Error(`Failed to start frontend deployment pipeline: ${error.message}`);
      pipelineError.statusCode = 500;
      throw pipelineError;
    }
  }

  // For backend deployments
  if (componentType === 'backend') {
    const pipelineName = environment === 'production' ? 'eval-backend-prod' : `eval-backend-${environment}`;

    console.log(`🚀 Deploying backend build ${buildId} using pipeline ${pipelineName}...`);

    // Validate pipeline name format for security
    if (!pipelineName.startsWith('eval-backend-') || !/^[a-zA-Z0-9\-]+$/.test(pipelineName)) {
      const error = new Error('Pipeline name must be a valid eval-backend-* pipeline');
      error.statusCode = 400;
      throw error;
    }

    try {
      const command = new StartPipelineExecutionCommand({
        name: pipelineName
      });

      const result = await codepipeline.send(command);

      console.log(`✅ Successfully started backend deployment pipeline ${pipelineName}`);
      console.log(`📋 Pipeline execution ID: ${result.pipelineExecutionId}`);

      return {
        success: true,
        message: `Successfully triggered backend deployment to ${environment}`,
        deployment: {
          type: componentType,
          pipelineName,
          pipelineExecutionId: result.pipelineExecutionId,
          deploymentId: result.pipelineExecutionId,
          environment,
          buildId,
          startTime: new Date().toISOString()
        }
      };

    } catch (error) {
      console.error(`❌ Error starting backend deployment pipeline: ${error.message}`);
      const pipelineError = new Error(`Failed to start backend deployment pipeline: ${error.message}`);
      pipelineError.statusCode = 500;
      throw pipelineError;
    }
  }
}

// Shared function for checking build status (used by both /build-status and /api/build-status)
async function getBuildStatusLogic(buildId) {
  if (!buildId) {
    throw new Error('Build ID is required');
  }

  console.log(`🔍 Checking build status for ${buildId}...`);

  const command = new BatchGetBuildsCommand({
    ids: [buildId]
  });

  const result = await codebuild.send(command);

  if (!result.builds || result.builds.length === 0) {
    console.log(`❌ Build not found: ${buildId}`);
    const error = new Error(`Build ${buildId} not found`);
    error.statusCode = 404;
    throw error;
  }

  const build = result.builds[0];
  console.log(`✅ Build status for ${buildId}: ${build.buildStatus}`);

  return {
    buildId: build.id,
    status: build.buildStatus,
    buildComplete: build.buildComplete,
    phase: build.currentPhase,
    projectName: build.projectName,
    startTime: build.startTime,
    endTime: build.endTime,
    sourceVersion: build.sourceVersion
  };
}

// Shared function for retrying build (used by both /retry-build and /api/retry-build)
async function retryBuildLogic(buildId, projectName) {
  if (!buildId) {
    throw new Error('Build ID is required');
  }

  console.log(`🔄 Retrying build ${buildId} for project ${projectName || 'unknown'}...`);

  const command = new RetryBuildCommand({
    id: buildId
  });
  const result = await codebuild.send(command);

  console.log(`✅ Successfully retried build ${buildId}`);

  return {
    success: true,
    message: `Successfully retried build ${buildId}`,
    build: {
      buildId: result.build.id,
      projectName: result.build.projectName,
      status: result.build.buildStatus,
      sourceVersion: result.build.sourceVersion
    }
  };
}

// Shared function for triggering production builds (used by both /trigger-prod-builds and /api/trigger-prod-builds)
async function triggerProdBuildsLogic(prNumber) {
  if (!prNumber) {
    throw new Error('PR number is required');
  }

  console.log(`🚀 Triggering production builds for PR #${prNumber}...`);

  const productionProjects = ['eval-backend-prod', 'eval-frontend-prod'];
  const buildPromises = productionProjects.map(async (projectName) => {
    const command = new StartBuildCommand({
      projectName: projectName,
      sourceVersion: 'main',
      environmentVariablesOverride: [
        {
          name: 'TRIGGERED_FOR_PR',
          value: prNumber.toString()
        }
      ]
    });

    return await codebuild.send(command);
  });

  const results = await Promise.all(buildPromises);

  console.log(`✅ Successfully triggered production builds for PR #${prNumber}`);

  return {
    success: true,
    message: `Production builds triggered for PR #${prNumber}`,
    builds: results.map(result => ({
      buildId: result.build.id,
      projectName: result.build.projectName,
      status: result.build.buildStatus,
      sourceVersion: result.build.sourceVersion
    }))
  };
}

// Shared function for triggering single build (used by both /trigger-single-build and /api/trigger-single-build)
async function triggerSingleBuildLogic(projectName, prNumber, sourceBranch) {
  if (!projectName) {
    throw new Error('Project name is required');
  }

  const targetBranch = sourceBranch || 'main';
  console.log(`🚀 Triggering ${projectName} build${prNumber ? ` for PR #${prNumber}` : ` from latest ${targetBranch}`}...`);

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

  return {
    success: true,
    message: `Successfully triggered ${projectName} build${prNumber ? ` for PR #${prNumber}` : ` from latest ${targetBranch}`}`,
    build: {
      buildId: result.build.id,
      projectName: result.build.projectName,
      status: result.build.buildStatus,
      sourceVersion: result.build.sourceVersion
    }
  };
}

// Shared function for fetching builds (used by both /builds and /api/builds)
async function fetchBuildsLogic() {
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

  const builds = await getRecentBuilds(projectNames, 10); // Conservative: 10 builds per project = ~100 total
  const categorizedBuilds = await categorizeBuildHistory(builds);

  console.log(`✅ Returning ${builds.length} total builds`);
  return categorizedBuilds;
}



// =============================================================================
// API ROUTES
// =============================================================================
// This section contains all REST API endpoints for the CI/CD Dashboard.
// Routes are organized by functionality:
//   - Data retrieval (GET): builds, deployment status, latest merge info
//   - Actions (POST): triggering builds, deployments, retries
//   - Utilities: health checks, cache stats
//
// Note: Many routes have both /api/* and /* versions for compatibility
// =============================================================================

// -----------------------------------------------------------------------------
// BUILD DATA ENDPOINTS
// -----------------------------------------------------------------------------

// Add /api/builds alias that works the same as /builds for frontend compatibility
app.get('/api/builds', async (req, res) => {
  try {
    const categorizedBuilds = await fetchBuildsLogic();
    res.json(categorizedBuilds);
  } catch (error) {
    console.error('❌ Error fetching builds via /api/builds:', error);

    // Check if this is a rate limiting error
    if (isRateLimitError(error)) {
      console.log('⚠️  AWS API rate limiting detected in /api/builds');
      return res.status(429).json({
        error: 'rate_limited',
        message: 'AWS API rate limiting detected - please wait and try again'
      });
    }

    res.status(500).json({
      error: 'Failed to fetch build data',
      message: error.message
    });
  }
});

app.get('/builds', async (req, res) => {
  try {
    const categorizedBuilds = await fetchBuildsLogic();
    res.json(categorizedBuilds);
  } catch (error) {
    console.error('❌ Error in /builds endpoint:', error);

    // Check if this is a rate limiting error
    if (isRateLimitError(error)) {
      console.log('⚠️  AWS API rate limiting detected in /builds');
      return res.status(429).json({
        error: 'rate_limited',
        message: 'AWS API rate limiting detected - please wait and try again'
      });
    }

    res.status(500).json({
      error: 'Failed to fetch build data',
      message: error.message
    });
  }
});

// -----------------------------------------------------------------------------
// BUILD ACTION ENDPOINTS
// -----------------------------------------------------------------------------

// Trigger production builds endpoint
app.post('/trigger-prod-builds', async (req, res) => {
  try {
    const { prNumber } = req.body;
    const result = await triggerProdBuildsLogic(prNumber);
    res.json(result);
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
    const result = await triggerSingleBuildLogic(projectName, prNumber, sourceBranch);
    res.json(result);
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
    const result = await retryBuildLogic(buildId, projectName);
    res.json(result);
  } catch (error) {
    console.error(`❌ Error retrying build ${req.body?.buildId || 'unknown'}:`, error);
    res.status(500).json({
      error: 'Failed to retry build',
      message: error.message
    });
  }
});

// -----------------------------------------------------------------------------
// DEPLOYMENT ACTION ENDPOINTS
// -----------------------------------------------------------------------------

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

// Add /api/deploy-independent alias for frontend compatibility
app.post('/api/deploy-independent', async (req, res) => {
  try {
    const { environment, buildId, componentType, overrideOutOfDate = false } = req.body;
    const result = await deployIndependentLogic(environment, buildId, componentType, overrideOutOfDate);
    res.json(result);
  } catch (error) {
    console.error('❌ API: Error in independent deployment:', error);

    if (error.statusCode && [400, 404].includes(error.statusCode)) {
      return res.status(error.statusCode).json({
        error: error.statusCode === 400 ? 'Invalid parameters' : 'Not found',
        message: error.message
      });
    }

    res.status(500).json({
      error: 'Deployment failed',
      message: error.message || 'Unknown error occurred during independent deployment'
    });
  }
});

// Deploy independent component endpoint
app.post('/deploy-independent', async (req, res) => {
  try {
    const { environment, buildId, componentType, overrideOutOfDate = false } = req.body;
    const result = await deployIndependentLogic(environment, buildId, componentType, overrideOutOfDate);
    res.json(result);
  } catch (error) {
    console.error('Error in independent deployment:', error);

    if (error.statusCode && [400, 404].includes(error.statusCode)) {
      return res.status(error.statusCode).json({
        error: error.statusCode === 400 ? 'Invalid parameters' : 'Not found',
        message: error.message
      });
    }

    res.status(500).json({
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

// -----------------------------------------------------------------------------
// STATUS & MONITORING ENDPOINTS
// -----------------------------------------------------------------------------

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
    const result = await getBuildStatusLogic(buildId);
    res.json(result);
  } catch (error) {
    console.error(`❌ Error checking build status for ${req.params.buildId}:`, error);

    if (error.statusCode === 404) {
      return res.status(404).json({
        error: 'Build not found',
        message: error.message
      });
    }

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

// GitHub cache stats endpoint
app.get('/api/cache-stats', (req, res) => {
  const stats = githubAPI.getCacheStats();
  res.json({
    cache: stats,
    timestamp: new Date().toISOString()
  });
});

// -----------------------------------------------------------------------------
// /API/* COMPATIBILITY ENDPOINTS
// -----------------------------------------------------------------------------
// These endpoints provide /api/* versions of the above routes for frontend compatibility

// Add /api/trigger-single-build alias for frontend compatibility
app.post('/api/trigger-single-build', async (req, res) => {
  try {
    const { projectName, prNumber, sourceBranch } = req.body;
    const result = await triggerSingleBuildLogic(projectName, prNumber, sourceBranch);
    res.json(result);
  } catch (error) {
    console.error(`❌ Error triggering ${req.body?.projectName || 'build'} via /api/trigger-single-build:`, error);
    res.status(500).json({
      error: 'Failed to trigger build',
      message: error.message
    });
  }
});

// Add /api/trigger-prod-builds alias for frontend compatibility
app.post('/api/trigger-prod-builds', async (req, res) => {
  try {
    const { prNumber } = req.body;
    const result = await triggerProdBuildsLogic(prNumber);
    res.json(result);
  } catch (error) {
    console.error('❌ Error triggering production builds via /api/trigger-prod-builds:', error);
    res.status(500).json({
      error: 'Failed to trigger production builds',
      message: error.message
    });
  }
});

// Add /api/deploy alias for frontend compatibility (returns 501 - not implemented)
app.post('/api/deploy', async (req, res) => {
  res.status(501).json({
    error: 'Endpoint not implemented',
    message: 'Use /api/deploy-coordinated, /api/deploy-frontend, or /api/deploy-independent instead'
  });
});

// Add /api/deploy-frontend alias for frontend compatibility
app.post('/api/deploy-frontend', async (req, res) => {
  try {
    const { pipelineName, buildId } = req.body;

    if (!pipelineName || !buildId) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'Please provide both pipelineName and buildId to deploy frontend'
      });
    }

    console.log(`🚀 Deploying frontend build ${buildId} using pipeline ${pipelineName} via /api/deploy-frontend...`);

    // Use same validation and logic as /deploy-frontend
    if (!pipelineName.startsWith('eval-frontend-') || !/^[a-zA-Z0-9\-]+$/.test(pipelineName)) {
      return res.status(400).json({
        error: 'Invalid pipeline name',
        message: 'Pipeline name must start with "eval-frontend-" and contain only alphanumeric characters and hyphens'
      });
    }

    const command = new StartPipelineExecutionCommand({
      name: pipelineName,
      variables: [
        {
          name: 'BUILD_ID',
          value: buildId
        }
      ]
    });

    const result = await codepipeline.send(command);
    console.log(`✅ Frontend deployment started: ${result.pipelineExecutionId} via /api/deploy-frontend`);

    res.json({
      success: true,
      message: `Frontend deployment started for build ${buildId}`,
      pipelineExecutionId: result.pipelineExecutionId,
      pipelineName: pipelineName
    });

  } catch (error) {
    console.error('❌ Error deploying frontend via /api/deploy-frontend:', error);
    res.status(500).json({
      error: 'Failed to deploy frontend',
      message: error.message
    });
  }
});

// Add /api/deploy-coordinated alias for frontend compatibility
app.post('/api/deploy-coordinated', async (req, res) => {
  try {
    const { environment, backendBuildInfo, frontendBuildInfo, skipOutOfDateCheck = false } = req.body;

    if (!environment) {
      return res.status(400).json({
        error: 'Missing environment parameter',
        message: 'Please provide the target environment for deployment'
      });
    }

    console.log(`🚀 Starting coordinated deployment to ${environment} via /api/deploy-coordinated...`);

    // Use same logic as /deploy-coordinated
    const deployCommand = new StartExecutionCommand({
      stateMachineArn: process.env.DEPLOYMENT_STATE_MACHINE_ARN,
      input: JSON.stringify({
        environment: environment,
        backendBuildInfo: backendBuildInfo,
        frontendBuildInfo: frontendBuildInfo,
        skipOutOfDateCheck: skipOutOfDateCheck
      })
    });

    const result = await stepFunctions.send(deployCommand);
    console.log(`✅ Coordinated deployment started: ${result.executionArn} via /api/deploy-coordinated`);

    res.json({
      success: true,
      message: `Coordinated deployment to ${environment} started`,
      executionArn: result.executionArn
    });

  } catch (error) {
    console.error('❌ Error in coordinated deployment via /api/deploy-coordinated:', error);
    res.status(500).json({
      error: 'Failed to start coordinated deployment',
      message: error.message
    });
  }
});

// Add /api/deployment-status alias for frontend compatibility
app.get('/api/deployment-status/:pipelineExecutionId', async (req, res) => {
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

    // Get detailed pipeline execution status
    const getExecutionCommand = new GetPipelineExecutionCommand({
      pipelineName: pipelineName,
      pipelineExecutionId: pipelineExecutionId
    });

    const execution = await codepipeline.send(getExecutionCommand);

    res.json({
      pipelineExecutionId,
      pipelineName,
      status: executionDetails.status,
      startTime: executionDetails.startTime,
      lastUpdateTime: executionDetails.lastUpdateTime,
      isComplete: ['Succeeded', 'Failed', 'Cancelled', 'Stopped'].includes(executionDetails.status)
    });

  } catch (error) {
    console.error(`❌ Error checking deployment status for ${req.params?.pipelineExecutionId}:`, error);
    res.status(500).json({
      error: 'Failed to check deployment status',
      message: error.message
    });
  }
});

// Add /api/retry-build alias for frontend compatibility
app.post('/api/retry-build', async (req, res) => {
  try {
    const { buildId, projectName } = req.body;
    const result = await retryBuildLogic(buildId, projectName);
    res.json(result);
  } catch (error) {
    console.error(`❌ Error retrying build via /api/retry-build:`, error);
    res.status(500).json({
      error: 'Failed to retry build',
      message: error.message
    });
  }
});

// Add /api/build-status alias for frontend compatibility
app.get('/api/build-status/:buildId', async (req, res) => {
  try {
    const { buildId } = req.params;
    const result = await getBuildStatusLogic(buildId);
    res.json(result);
  } catch (error) {
    console.error(`❌ Error checking build status for ${req.params?.buildId || 'unknown'} via /api/build-status:`, error);

    if (error.statusCode === 404) {
      return res.status(404).json({
        error: 'Build not found',
        message: error.message
      });
    }

    res.status(500).json({
      error: 'Failed to check build status',
      message: error.message
    });
  }
});

// -----------------------------------------------------------------------------
// GIT/GITHUB INTEGRATION ENDPOINTS
// -----------------------------------------------------------------------------

// Get latest merge information from GitHub for a specific branch
app.get('/api/latest-merge/:repo/:branch', async (req, res) => {
  try {
    const result = await githubAPI.fetchLatestMergeApiLogic(req.params.repo, req.params.branch);
    // Extract just the latestCommit data to match the expected format
    res.json(result.latestCommit);
  } catch (error) {
    console.error(`❌ Error fetching latest merge for ${req.params.repo}/${req.params.branch} via /api/latest-merge:`, error);
    res.status(500).json({ error: 'Failed to fetch latest merge info', message: error.message });
  }
});

// Get latest merge information from GitHub for a specific branch
app.get('/latest-merge/:repo/:branch', async (req, res) => {
  try {
    const apiResult = await githubAPI.fetchLatestMergeApiLogic(req.params.repo, req.params.branch);
    // Convert to flat format expected by this endpoint
    const result = {
      sha: apiResult.latestCommit.sha.substring(0, 7), // Use 7 chars for legacy compatibility
      message: apiResult.latestCommit.message,
      author: apiResult.latestCommit.author,
      date: apiResult.latestCommit.date,
      url: apiResult.latestCommit.url
    };
    res.json(result);
  } catch (error) {
    console.error(`❌ Error fetching latest merge for ${req.params.repo}/${req.params.branch} via /latest-merge:`, error);
    res.status(500).json({ error: 'Failed to fetch latest merge info', message: error.message });
  }
});

// Get latest merge information from GitHub (legacy endpoint for main branch)
app.get('/latest-merge/:repo', async (req, res) => {
  try {
    const apiResult = await githubAPI.fetchLatestMergeApiLogic(req.params.repo, 'main');
    // Convert to flat format expected by this endpoint
    const result = {
      sha: apiResult.latestCommit.sha.substring(0, 7), // Use 7 chars for legacy compatibility
      message: apiResult.latestCommit.message,
      author: apiResult.latestCommit.author,
      date: apiResult.latestCommit.date,
      url: apiResult.latestCommit.url
    };
    res.json(result);
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

    // Get builds data to find the newest commit we have
    const projectNames = [
      'eval-backend-sandbox',
      'eval-frontend-sandbox',
      'eval-backend-demo',
      'eval-frontend-demo',
      'eval-backend-prod',
      'eval-frontend-prod'
    ];
    const builds = await getRecentBuilds(projectNames, 10); // Conservative: 10 builds per project = ~100 total

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
      console.log(`❌ No ${repo} builds found`);
      return res.json({
        commitsAhead: 0,
        latestGitHubSha: null,
        newestBuildSha: null,
        message: `No builds found for ${repo}`,
        error: "no_builds"
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

    // Get latest GitHub commit using centralized API
    const latestMergeData = await githubAPI.fetchLatestMergeApiLogic(repo, 'main');
    if (!latestMergeData?.latestCommit?.sha) {
      return res.status(500).json({ error: 'Failed to fetch latest GitHub commit' });
    }

    const latestGitHubSha = latestMergeData.latestCommit.sha;
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

    // Use centralized GitHub API to compare commits
    const comparison = await githubAPI.compareCommits(repo, newestBuildSha, latestGitHubSha);
    if (!comparison) {
      return res.status(500).json({ error: 'Failed to compare commits' });
    }

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

// In production, serve static files from the built frontend
// In development, the frontend runs on its own port with Vite dev server
const path = require('path');
const fs = require('fs');

if (process.env.NODE_ENV === 'production') {
  // Path to the built frontend files
  const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');

  // Check if the built frontend exists
  if (fs.existsSync(frontendDistPath)) {
    console.log('🎯 Production mode: Serving static frontend files from', frontendDistPath);

    // Serve static files from frontend/dist
    app.use(express.static(frontendDistPath));

    // Handle client-side routing - serve index.html for all non-API routes
    app.get('*', (req, res) => {
      // Don't serve index.html for API routes
      if (req.path.startsWith('/api') ||
          req.path.startsWith('/builds') ||
          req.path.startsWith('/health') ||
          req.path.startsWith('/trigger') ||
          req.path.startsWith('/deploy') ||
          req.path.startsWith('/retry') ||
          req.path.startsWith('/latest-merge') ||
          req.path.startsWith('/commit-comparison') ||
          req.path.startsWith('/build-status') ||
          req.path.startsWith('/deployment-status')) {
        return res.status(404).json({ error: 'Not found' });
      }

      res.sendFile(path.join(frontendDistPath, 'index.html'));
    });
  } else {
    console.log('⚠️  Frontend build not found at', frontendDistPath);
    console.log('   Run "npm run build" in the frontend directory first');
  }
} else {
  console.log('🔧 Development mode: Frontend should be running on separate port (usually 3003)');
}

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