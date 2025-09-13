require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { CodeBuildClient, BatchGetBuildsCommand, ListBuildsForProjectCommand, BatchGetProjectsCommand, StartBuildCommand, RetryBuildCommand } = require('@aws-sdk/client-codebuild');
const { CloudWatchLogsClient, GetLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { CodePipelineClient, ListPipelinesCommand, GetPipelineCommand, ListPipelineExecutionsCommand, GetPipelineExecutionCommand } = require('@aws-sdk/client-codepipeline');
const { S3Client, GetObjectCommand, ListObjectVersionsCommand } = require('@aws-sdk/client-s3');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS for frontend
app.use(cors());
app.use(express.json());

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION || 'us-west-2' });
const cloudwatchlogs = new CloudWatchLogsClient({ region: process.env.AWS_REGION || 'us-west-2' });
const codepipeline = new CodePipelineClient({ region: process.env.AWS_REGION || 'us-west-2' });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' });

// Get Run Mode and Branch Name from CloudWatch build logs
const getLogDataFromBuild = async (build) => {
  try {
    if (!build.logs?.groupName) {
      return { runMode: null, sourceBranch: null };
    }

    const logGroupName = build.logs.groupName;
    const logStreamName = build.logs.streamName;
    
    if (!logStreamName) {
      return { runMode: null, sourceBranch: null };
    }

    console.log(`Fetching logs for ${build.projectName}:${build.id?.slice(-8)} from ${logGroupName}/${logStreamName}`);

    const command = new GetLogEventsCommand({
      logGroupName,
      logStreamName,
      limit: 100, // Get first 100 log events where info is available
      startFromHead: true
    });

    const response = await cloudwatchlogs.send(command);
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
    
    return { runMode, sourceBranch };
  } catch (error) {
    console.error(`Error fetching logs for ${build.projectName}:${build.id?.slice(-8)}:`, error.message);
    return { runMode: null, sourceBranch: null };
  }
};

// Build classification with CloudWatch logs fallback
const classifyBuild = async (build) => {
  const env = build.environment?.environmentVariables || [];
  const envVars = env.reduce((acc, { name, value }) => ({ ...acc, [name]: value }), {});
  
  // Extract data from environment variables
  const sourceVersion = build.sourceVersion;
  const baseRef = envVars.CODEBUILD_WEBHOOK_BASE_REF;
  const prNumber = envVars.CODEBUILD_WEBHOOK_PR_NUMBER;
  const triggeredForPR = envVars.TRIGGERED_FOR_PR;
  
  // Extract PR number from sourceVersion (pr/291 format)
  let extractedPR = null;
  if (sourceVersion?.startsWith('pr/')) {
    extractedPR = sourceVersion.replace('pr/', '');
  }
  
  const finalPRNumber = prNumber || extractedPR || triggeredForPR;
  
  console.log(`Classifying ${build.projectName}:${build.id?.slice(-8)} - baseRef: ${baseRef}, sourceVersion: ${sourceVersion}, PR: ${finalPRNumber}`);

  // Get the actual Run Mode and source branch from build logs (this is the ground truth)
  const { runMode, sourceBranch } = await getLogDataFromBuild(build);
  console.log(`Build ${build.projectName}:${finalPRNumber} - RunMode from logs: ${runMode}, SourceBranch: ${sourceBranch}`);

  // NEW BRANCH-FIRST LOGIC: Check actual source branch from logs before using baseRef
  // This ensures we always use the actual branch context, not just the webhook trigger info
  if (sourceBranch) {
    if (sourceBranch === 'main' || sourceBranch.endsWith('/main')) {
      // For sandbox builds with unknown runMode, skip until logs are available  
      if (!runMode && build.projectName.includes('sandbox')) {
        console.log(`Main branch build (from logs, runMode unknown, skipping): ${build.projectName}:${finalPRNumber}`);
        return null;
      }
      console.log(`Main branch build (from logs): ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'FULL_BUILD'}`);
      return {
        type: 'production',
        runMode: runMode || 'FULL_BUILD',
        isDeployable: true,
        prNumber: finalPRNumber,
        sourceBranch: sourceBranch
      };
    }
    
    // CRITICAL FIX: For dev->main merges, dev branch with FULL_BUILD should be deployment builds
    if (sourceBranch === 'dev' || sourceBranch.endsWith('/dev')) {
      if (runMode === 'FULL_BUILD') {
        console.log(`Dev branch deployment build (FULL_BUILD): ${build.projectName}:${finalPRNumber}, runMode: ${runMode}`);
        return {
          type: 'production',
          runMode: runMode,
          isDeployable: true,
          prNumber: finalPRNumber,
          sourceBranch: sourceBranch
        };
      } else if (runMode === 'TEST_ONLY') {
        console.log(`Dev branch test build (TEST_ONLY): ${build.projectName}:${finalPRNumber}, runMode: ${runMode}`);
        return {
          type: 'dev-test',
          runMode: runMode,
          isDeployable: false,
          prNumber: finalPRNumber,
          sourceBranch: sourceBranch
        };
      } else if (!runMode && build.projectName.includes('sandbox')) {
        // For sandbox dev branch builds with unknown runMode, skip until logs are available
        console.log(`Dev branch sandbox build (runMode unknown, skipping): ${build.projectName}:${finalPRNumber}`);
        return null;
      } else {
        console.log(`Dev branch test build (defaulting TEST_ONLY): ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'TEST_ONLY'}`);
        return {
          type: 'dev-test',
          runMode: runMode || 'TEST_ONLY',
          isDeployable: false,
          prNumber: finalPRNumber,
          sourceBranch: sourceBranch
        };
      }
    }
  }

  // Rule 1: baseRef === 'refs/heads/main' → Deployment Builds table
  if (baseRef === 'refs/heads/main') {
    // For sandbox builds with unknown runMode, skip until logs are available
    if (!runMode && build.projectName.includes('sandbox')) {
      console.log(`Main deployment build (baseRef, runMode unknown, skipping): ${build.projectName}:${finalPRNumber}`);
      return null;
    }
    console.log(`Main deployment build (baseRef): ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'FULL_BUILD'}`);
    return {
      type: 'production',
      runMode: runMode || 'FULL_BUILD',
      isDeployable: true,
      prNumber: finalPRNumber,
      sourceBranch: sourceBranch
    };
  }
  
  // Rule 2: baseRef === 'refs/heads/dev' → Dev Builds table  
  if (baseRef === 'refs/heads/dev') {
    // For sandbox builds with unknown runMode, skip until logs are available
    if (!runMode && build.projectName.includes('sandbox')) {
      console.log(`Dev test build (baseRef, runMode unknown, skipping): ${build.projectName}:${finalPRNumber}`);
      return null;
    }
    console.log(`Dev test build (baseRef): ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'TEST_ONLY'}`);
    return {
      type: 'dev-test',
      runMode: runMode || 'TEST_ONLY',
      isDeployable: false,
      prNumber: finalPRNumber,
      sourceBranch: sourceBranch
    };
  }
  
  // FALLBACK: For builds triggered via main branch (not webhook), always treat as deployment builds
  // This handles cases where dev->main merges trigger TEST_ONLY builds in main branch context
  if (sourceVersion?.includes('main') || sourceVersion === 'refs/heads/main') {
    // For sandbox builds with unknown runMode, skip until logs are available
    if (!runMode && build.projectName.includes('sandbox')) {
      console.log(`Main branch manual/trigger build (runMode unknown, skipping): ${build.projectName}:${finalPRNumber}`);
      return null;
    }
    console.log(`Main branch manual/trigger build: ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'FULL_BUILD'}`);
    return {
      type: 'production',
      runMode: runMode || 'FULL_BUILD', 
      isDeployable: true,
      prNumber: finalPRNumber,
      sourceBranch: sourceBranch
    };
  }
  
  // DEPRECATED FALLBACK: Use Run Mode from logs (this should rarely be needed now)
  if (runMode) {
    if (runMode === 'FULL_BUILD') {
      console.log(`Deployment build (FULL_BUILD fallback): ${build.projectName}:${finalPRNumber}`);
      return {
        type: 'production',
        runMode: runMode,
        isDeployable: true,
        prNumber: finalPRNumber,
        sourceBranch: sourceBranch
      };
    } else if (runMode === 'TEST_ONLY') {
      // Check if this is a feature branch (PR->dev merge) or dev->main merge
      const isFeatureBranch = sourceBranch && 
        (sourceBranch.startsWith('feature/') || 
         sourceBranch.startsWith('bugfix/') ||
         sourceBranch.startsWith('hotfix/'));
      
      if (isFeatureBranch) {
        console.log(`Feature branch TEST_ONLY build: ${build.projectName}:${finalPRNumber} from ${sourceBranch}`);
        return {
          type: 'dev-test',
          runMode: runMode,
          isDeployable: false,
          prNumber: finalPRNumber,
          sourceBranch: sourceBranch
        };
      } else {
        // For sandbox builds with TEST_ONLY but unknown source branch, skip until more info available
        if (build.projectName.includes('sandbox')) {
          console.log(`Sandbox TEST_ONLY build (source branch unknown, skipping): ${build.projectName}:${finalPRNumber}`);
          return null;
        }
        console.log(`Integration TEST_ONLY build: ${build.projectName}:${finalPRNumber}`);
        // For TEST_ONLY without feature branch context, likely dev->main merge
        return {
          type: 'production',
          runMode: runMode,
          isDeployable: true,
          prNumber: finalPRNumber,
          sourceBranch: sourceBranch
        };
      }
    }
  }
  
  // Fallback for prod projects (always deployment builds)
  if (sourceVersion?.startsWith('pr/') && build.projectName.includes('prod')) {
    console.log(`Prod project build: ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'FULL_BUILD'}`);
    return {
      type: 'production',
      runMode: runMode || 'FULL_BUILD',
      isDeployable: true,
      prNumber: finalPRNumber,
      sourceBranch: sourceBranch
    };
  }
  
  // Final fallback for demo projects (also deployment builds)  
  if (sourceVersion?.startsWith('pr/') && build.projectName.includes('demo')) {
    console.log(`Demo project build: ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'FULL_BUILD'}`);
    return {
      type: 'production',
      runMode: runMode || 'FULL_BUILD',
      isDeployable: true,
      prNumber: finalPRNumber,
      sourceBranch: sourceBranch
    };
  }
  
  // Last fallback: sandbox projects with PR numbers - need to determine dev vs deployment
  if (sourceVersion?.startsWith('pr/') && build.projectName.includes('sandbox')) {
    if (runMode === 'FULL_BUILD') {
      console.log(`Sandbox deployment build (FULL_BUILD): ${build.projectName}:${finalPRNumber}`);
      return {
        type: 'production',
        runMode: runMode,
        isDeployable: true,
        prNumber: finalPRNumber,
        sourceBranch: sourceBranch
      };
    } else if (runMode === 'TEST_ONLY') {
      console.log(`Sandbox dev build (TEST_ONLY): ${build.projectName}:${finalPRNumber}`);
      return {
        type: 'dev-test',
        runMode: runMode,
        isDeployable: false,
        prNumber: finalPRNumber,
        sourceBranch: sourceBranch
      };
    } else {
      // Skip builds with unknown runMode until CloudWatch logs are available
      console.log(`Sandbox build (runMode unknown, skipping until logs available): ${build.projectName}:${finalPRNumber}`);
      return null;
    }
  }
  
  // Default: unknown builds
  console.log(`Unknown build type: ${build.projectName}:${build.id?.slice(-8)}`);
  return {
    type: 'unknown',
    runMode: runMode || 'SKIP',
    isDeployable: false,
    prNumber: finalPRNumber,
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

// Extract PR number from commit message or other sources
const extractPRFromCommit = async (build) => {
  // Try to get commit SHA from resolvedSourceVersion
  const commitSha = build.resolvedSourceVersion;
  if (!commitSha) return null;
  
  // Determine repo from project name
  const repo = build.projectName.includes('backend') ? 'backend' : 'frontend';
  
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
const findPRFromRelatedBuilds = (build, allBuilds) => {
  if (!build.resolvedSourceVersion || !allBuilds) return null;
  
  const commitSha = build.resolvedSourceVersion;
  const currentProject = build.projectName;
  
  // Look for other builds with the same commit hash that have a PR number
  const relatedBuilds = allBuilds.filter(otherBuild => 
    otherBuild.resolvedSourceVersion === commitSha &&
    otherBuild.projectName !== currentProject && // Different project
    otherBuild.prNumber // Has a PR number
  );
  
  if (relatedBuilds.length > 0) {
    // Sort by most recent and take the first one
    const mostRecent = relatedBuilds.sort((a, b) => 
      new Date(b.startTime) - new Date(a.startTime)
    )[0];
    
    console.log(`🔗 Found PR #${mostRecent.prNumber} from related build ${mostRecent.projectName}:${mostRecent.id?.slice(-8)} with same commit ${commitSha.substring(0,8)}`);
    return mostRecent.prNumber;
  }
  
  return null;
};

// Extract build information
const processBuild = async (build) => {
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
  
  return {
    buildId: build.id,
    projectName: build.projectName,
    status: build.buildStatus, // SUCCESS, FAILED, IN_PROGRESS, etc.
    ...classification,
    prNumber: prNumber || classification.prNumber, // Use extracted PR if available
    sourceVersion: build.sourceVersion, // Include raw sourceVersion for debugging
    resolvedSourceVersion: build.resolvedSourceVersion, // Include commit SHA
    resolvedCommit: build.resolvedSourceVersion, // Full commit hash for artifact matching
    commit: build.resolvedSourceVersion?.substring(0, 7) || build.sourceVersion?.substring(0, 7) || 'unknown',
    startTime: build.startTime,
    endTime: build.endTime,
    duration: build.endTime ? Math.round((build.endTime - build.startTime) / 1000) : null,
    logs: build.logs?.groupName, // For potential PR number extraction from logs
    artifacts: artifacts // Artifact hashes for deployment correlation
  };
};

// Get recent builds for specified projects
const getRecentBuilds = async (projectNames, maxBuilds = 200) => {
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
  
  // Second pass: do cross-referencing to find missing PR numbers
  console.log(`🔄 Second pass: Cross-referencing PR numbers for ${allBuilds.length} total builds...`);
  for (const build of allBuilds) {
    if (!build.prNumber && (build.sourceVersion === 'refs/heads/main' || build.sourceVersion === 'main')) {
      const crossRefPR = findPRFromRelatedBuilds(build, allBuilds);
      if (crossRefPR) {
        build.prNumber = crossRefPR;
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

// Get latest 2 builds per project for a specific build category
const getLatestBuildPerProjectByCategory = (builds, category) => {
  const filteredBuilds = category === 'dev' 
    ? builds.filter(build => build.type === 'dev-test')
    : builds.filter(build => build.isDeployable);
    
  const projectMap = new Map();
  
  // Group builds by project, keeping the 2 most recent for each
  filteredBuilds.forEach(build => {
    const projectName = build.projectName;
    const existing = projectMap.get(projectName) || [];
    
    // Add this build to the project's builds array
    existing.push(build);
    
    // Sort by startTime (most recent first) and keep only top 2
    existing.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    if (existing.length > 2) {
      existing.splice(2); // Keep only first 2
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
    if (category === 'deployment') {
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
        // Determine S3 bucket and key based on pipeline name
        let bucketName = null;
        let objectKey = null;
        
        if (pipelineName.toLowerCase().includes('frontend')) {
          bucketName = 'eval-frontend-artifacts';
          objectKey = pipelineName.toLowerCase().includes('sandbox') ? 'eval-frontend-sandbox' :
                     pipelineName.toLowerCase().includes('demo') ? 'eval-frontend-demo' :
                     pipelineName.toLowerCase().includes('prod') ? 'eval-frontend-prod' : null;
        } else if (pipelineName.toLowerCase().includes('backend')) {
          bucketName = 'eval-backend-artifacts';
          objectKey = pipelineName.toLowerCase().includes('sandbox') ? 'eval-backend-sandbox' :
                     pipelineName.toLowerCase().includes('demo') ? 'eval-backend-demo' :
                     pipelineName.toLowerCase().includes('prod') ? 'eval-backend-prod' : null;
        }
        
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
    if (matchedBuild) {
      if (matchedBuild._matchedViaArtifacts) {
        matchingMethod = 'Method A (Artifacts)';
      } else if (matchedBuild._matchedViaCommitFromPipeline) {
        matchingMethod = 'Method B (Pipeline Commit)';
      } else if (matchedBuild._matchedViaBuildCommit) {
        matchingMethod = 'Method C (Build Commit)';
      } else {
        matchingMethod = 'Method B (Pipeline Commit)'; // Default for direct pipeline commits
      }
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
    return { prNumber: null, gitCommit: null, buildTimestamp: null };
  }
};

const getPipelineDeploymentStatus = async (builds) => {
  try {
    console.log('🔄 Fetching pipeline deployment status...');
    
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
            const buildInfo = await getBuildInfoFromPipelineExecution(pipeline.name, successfulExecution.pipelineExecutionId, builds);
            
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

// Generate deployment status combining CodePipeline data with available builds
const generateDeploymentStatus = async (builds) => {
  // Get actual deployment status from CodePipeline
  const pipelineStatus = await getPipelineDeploymentStatus(builds);
  
  if (pipelineStatus.length === 0) {
    console.log('⚠️  No pipeline data available - AWS API issues detected');
    return generateErrorDeploymentStatus('AWS API access issues detected - deployment status temporarily unavailable. Please check AWS permissions or wait for rate limits to reset.');
  }
  
  // Enhance pipeline status with available updates from builds
  // Use all deployment builds - don't rely solely on isDeployable flag due to CloudWatch rate limiting
  const deploymentBuilds = builds.filter(build => 
    build.status === 'SUCCEEDED' && 
    build.type === 'production' // Only production builds are deployable
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
      console.log(`      🔍 Latest backend build for ${envName}: ${latestBackendBuild.projectName}:${latestBackendBuild.buildId?.slice(-8)} (${latestBackendBuild.artifacts?.md5Hash?.substring(0,7) || latestBackendBuild.commit}) at ${new Date(latestBackendBuild.startTime).toISOString()}`);
    }
      
    const availableBackendUpdates = latestBackendBuild && 
      new Date(latestBackendBuild.startTime).getTime() > currentBackendBuildTime &&
      latestBackendBuild.buildId !== currentBackendBuildId // Exclude currently deployed build
      ? [{
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
      console.log(`      🔍 Latest frontend build for ${envName}: ${latestFrontendBuild.projectName}:${latestFrontendBuild.buildId?.slice(-8)} (${latestFrontendBuild.artifacts?.md5Hash?.substring(0,7) || latestFrontendBuild.commit}) at ${new Date(latestFrontendBuild.startTime).toISOString()}`);
      console.log(`      📅 Current deployed frontend time: ${new Date(currentFrontendBuildTime).toISOString()}, newer? ${new Date(latestFrontendBuild.startTime).getTime() > currentFrontendBuildTime}`);
    }
      
    const availableFrontendUpdates = latestFrontendBuild && 
      new Date(latestFrontendBuild.startTime).getTime() > currentFrontendBuildTime &&
      latestFrontendBuild.buildId !== currentFrontendBuildId // Exclude currently deployed build
      ? [{
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
    
    return {
      ...envStatus,
      availableUpdates: {
        backend: availableBackendUpdates,
        frontend: availableFrontendUpdates
      }
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
    build.status === 'SUCCEEDED' && 
    build.type === 'production' // Only production builds are deployable - match the main deployment table logic
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

// Separate dev testing builds from deployment builds
const categorizeBuildHistory = async (builds) => {
  const devBuilds = builds.filter(build => build.type === 'dev-test');
  const deploymentBuilds = builds.filter(build => 
    build.status === 'SUCCEEDED' && 
    build.type === 'production' // Only production builds are deployable - match the main deployment table logic
  );
  
  // Get latest dev build per project and latest deployment build per project separately
  const latestDevBuilds = getLatestBuildPerProjectByCategory(builds, 'dev');
  const latestDeploymentBuilds = getLatestBuildPerProjectByCategory(builds, 'deployment');
  
  // Generate deployment status for the three environments (now async)
  const deployments = await generateDeploymentStatus(builds);
  
  return {
    devBuilds: latestDevBuilds,
    deploymentBuilds: latestDeploymentBuilds,
    deployments: deployments,
    summary: {
      totalBuilds: builds.length,
      devTestBuilds: devBuilds.length,
      deploymentBuilds: deploymentBuilds.length,
      failedDevBuilds: devBuilds.filter(b => b.status === 'FAILED').length,
      uniqueProjects: new Set([...latestDevBuilds.map(b => b.projectName), ...latestDeploymentBuilds.map(b => b.projectName)]).size,
      lastUpdated: new Date().toISOString()
    }
  };
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
      'eval-frontend-prod'
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
    const { projectName, prNumber } = req.body;
    
    if (!projectName || !prNumber) {
      return res.status(400).json({
        error: 'Project name and PR number are required',
        message: 'Please provide both projectName and prNumber to trigger a single build'
      });
    }

    console.log(`🚀 Triggering ${projectName} build for PR #${prNumber}...`);

    // Trigger single build from main branch with PR number as environment variable
    const command = new StartBuildCommand({
      projectName: projectName,
      sourceVersion: 'main',
      environmentVariablesOverride: [
        {
          name: 'TRIGGERED_FOR_PR',
          value: prNumber.toString(),
          type: 'PLAINTEXT'
        }
      ]
    });
    const result = await codebuild.send(command);

    console.log(`✅ Successfully triggered ${projectName} build for PR #${prNumber}`);
    
    res.json({
      success: true,
      message: `Successfully triggered ${projectName} build for PR #${prNumber}`,
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 CI/CD Dashboard server running on http://localhost:${PORT}`);
  console.log(`📊 API endpoint: http://localhost:${PORT}/builds`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  console.log('');
  console.log('💡 Make sure your AWS credentials are configured:');
  console.log('   - aws configure');
  console.log('   - or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY env vars');
});