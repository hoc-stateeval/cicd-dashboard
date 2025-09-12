require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { CodeBuildClient, BatchGetBuildsCommand, ListBuildsForProjectCommand, BatchGetProjectsCommand, StartBuildCommand, RetryBuildCommand } = require('@aws-sdk/client-codebuild');
const { CloudWatchLogsClient, GetLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { CodePipelineClient, ListPipelinesCommand, GetPipelineCommand, ListPipelineExecutionsCommand, GetPipelineExecutionCommand } = require('@aws-sdk/client-codepipeline');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS for frontend
app.use(cors());
app.use(express.json());

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION || 'us-west-2' });
const cloudwatchlogs = new CloudWatchLogsClient({ region: process.env.AWS_REGION || 'us-west-2' });
const codepipeline = new CodePipelineClient({ region: process.env.AWS_REGION || 'us-west-2' });

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
      } else {
        console.log(`Dev branch test build (TEST_ONLY): ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'TEST_ONLY'}`);
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
      // CRITICAL FIX: Default to deployment build when runMode is unknown (CloudWatch logs not ready yet)
      // This prevents temporary misclassification as dev builds
      console.log(`Sandbox build (runMode unknown, defaulting to deployment): ${build.projectName}:${finalPRNumber}`);
      return {
        type: 'production',
        runMode: runMode || 'FULL_BUILD',
        isDeployable: true,
        prNumber: finalPRNumber,
        sourceBranch: sourceBranch
      };
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
  
  // Get commit message from GitHub
  const commitMessage = await getGitHubCommitMessage(repo, commitSha);
  if (!commitMessage) return null;
  
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
      console.log(`Found PR #${match[1]} in commit message: "${commitMessage.substring(0, 60)}..."`);
      return match[1];
    }
  }
  
  return null;
};

// Extract build information
const processBuild = async (build) => {
  const classification = await classifyBuild(build);
  
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
    const imageUriVar = build.exportedEnvironmentVariables.find(env => env.name === 'IMAGE_URI');
    if (imageUriVar) {
      artifacts.dockerImageUri = imageUriVar.value;
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
        (buildDetails.builds || []).map(processBuild)
      );
      
      console.log(`Found ${processedBuilds.length} builds for ${projectName}`);
      allBuilds.push(...processedBuilds);
    } catch (error) {
      console.error(`Error fetching builds for ${projectName}:`, error.message);
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
    : builds.filter(build => build.isDeployable);
    
  const projectMap = new Map();
  
  // Group builds by project, keeping only the most recent for each
  filteredBuilds.forEach(build => {
    const projectName = build.projectName;
    const existing = projectMap.get(projectName);
    
    if (!existing || new Date(build.startTime) > new Date(existing.startTime)) {
      projectMap.set(projectName, build);
    }
  });
  
  return Array.from(projectMap.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
};

// Get deployment status from CodePipeline 
// Get actual build information from pipeline execution details
const getBuildInfoFromPipelineExecution = async (pipelineName, executionId, allBuilds = []) => {
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
    const gitCommit = primarySource.revisionId?.substring(0, 8); // Short commit hash
    
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
    
    console.log(`        🎯 Pipeline execution source: commit=${gitCommit}, PR#${prNumber || 'unknown'}`);
    console.log(`        📝 Revision summary: ${primarySource.revisionSummary || 'N/A'}`);
    
    // NEW: Try to match pipeline artifacts back to a specific build
    let matchedBuild = null;
    
    // Get pipeline execution actions to find build artifacts
    const { ListActionExecutionsCommand } = require('@aws-sdk/client-codepipeline');
    
    try {
      console.log(`        🔍 Getting action executions for pipeline ${pipelineName}...`);
      
      const listActionsCommand = new ListActionExecutionsCommand({
        pipelineName: pipelineName,
        filter: {
          pipelineExecutionId: executionId
        }
      });
      
      const actionExecutions = await codepipeline.send(listActionsCommand);
      console.log(`        📊 Found ${actionExecutions.actionExecutionDetails?.length || 0} action executions`);
      
      // Look for CodeBuild actions in the pipeline
      const buildActions = actionExecutions.actionExecutionDetails?.filter(action => 
        action.actionName && 
        (action.actionName.toLowerCase().includes('build') || 
         action.actionExecutionId)
      ) || [];
      
      console.log(`        🔨 Found ${buildActions.length} potential build actions:`);
      buildActions.forEach((action, idx) => {
        console.log(`           ${idx + 1}. ${action.actionName} | Status: ${action.status} | Stage: ${action.stageName}`);
        if (action.output?.outputArtifacts) {
          action.output.outputArtifacts.forEach(artifact => {
            console.log(`              📦 Output artifact: ${artifact.name} | ${artifact.s3location?.bucketName}/${artifact.s3location?.objectKey}`);
          });
        }
      });
      
      // Determine the project name to search based on pipeline name
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
      
      if (searchProjectName && allBuilds.length > 0) {
        console.log(`        📊 Available builds for ${searchProjectName}:`);
        const projectBuilds = allBuilds.filter(build => build.projectName === searchProjectName);
        projectBuilds.slice(0, 5).forEach(build => {
          console.log(`           - ${build.id?.slice(-8)} | ${build.commit} | PR#${build.prNumber || 'unknown'} | ${build.startTime}`);
          if (build.artifacts) {
            console.log(`              📦 Build artifact: ${build.artifacts.location} | Docker: ${build.artifacts.dockerImageUri}`);
          }
        });
        
        // Try to match artifacts between pipeline actions and builds
        for (const action of buildActions) {
          if (action.output?.outputArtifacts) {
            for (const pipelineArtifact of action.output.outputArtifacts) {
              // Try to match S3 location or other artifact identifiers
              for (const build of projectBuilds) {
                if (build.artifacts) {
                  // Match by S3 bucket location
                  if (pipelineArtifact.s3location && build.artifacts.location) {
                    const pipelineBucket = pipelineArtifact.s3location.bucketName;
                    const buildLocation = build.artifacts.location;
                    if (buildLocation.includes(pipelineBucket)) {
                      matchedBuild = build;
                      console.log(`        ✅ Found artifact match: ${build.projectName}:${build.id?.slice(-8)} via S3 bucket ${pipelineBucket}`);
                      break;
                    }
                  }
                  
                  // Match by Docker image URI if available
                  if (build.artifacts.dockerImageUri && action.output?.executionResult?.externalExecutionUrl) {
                    const buildImageUri = build.artifacts.dockerImageUri;
                    const actionUrl = action.output.executionResult.externalExecutionUrl;
                    if (actionUrl.includes(build.id) || buildImageUri.includes(build.commit)) {
                      matchedBuild = build;
                      console.log(`        ✅ Found artifact match: ${build.projectName}:${build.id?.slice(-8)} via Docker image URI`);
                      break;
                    }
                  }
                }
              }
              if (matchedBuild) break;
            }
            if (matchedBuild) break;
          }
        }
      }
    } catch (error) {
      console.log(`        ⚠️ Error getting action executions: ${error.message}`);
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
          console.log(`        ✅ Found commit match: ${build.projectName}:${build.id?.slice(-8)} with commit ${buildCommit}`);
          return true;
        }
        return false;
      });
        
      
      // If no commit match found either, use time-based fallback
      if (!matchedBuild) {
        console.log(`        ⚠️ No matching build found for ${searchProjectName} with commit ${gitCommit}`);
        
        // SMART FALLBACK: Look for builds from the correct target that were created around the deployment time
        // This ensures we find the right build for the right environment
        const deploymentTime = executionDetails.pipelineExecution?.lastUpdateTime;
        if (deploymentTime) {
          // Look for builds within a reasonable time window of the deployment
          const deploymentTimestamp = deploymentTime.getTime();
          const timeWindow = 24 * 60 * 60 * 1000; // 24 hours
          
          const candidateBuilds = projectBuilds
            .filter(build => build.status === 'SUCCEEDED' || build.status === 'SUCCESS')
            .filter(build => {
              const buildTime = new Date(build.startTime).getTime();
              return Math.abs(buildTime - deploymentTimestamp) <= timeWindow;
            })
            .sort((a, b) => {
              // Sort by proximity to deployment time (closest first)
              const aDistance = Math.abs(new Date(a.startTime).getTime() - deploymentTimestamp);
              const bDistance = Math.abs(new Date(b.startTime).getTime() - deploymentTimestamp);
              return aDistance - bDistance;
            });
          
          if (candidateBuilds.length > 0) {
            matchedBuild = candidateBuilds[0];
            console.log(`        🎯 Using time-based fallback: ${matchedBuild.projectName}:${matchedBuild.buildId?.slice(-8)} (${matchedBuild.commit}) - built ${Math.round(Math.abs(new Date(matchedBuild.startTime).getTime() - deploymentTimestamp) / (60 * 1000))} minutes from deployment`);
          } else {
            console.log(`        ⏰ No builds found within time window for ${searchProjectName} near ${deploymentTime}`);
          }
        }
      }
    }
    
    return {
      prNumber: matchedBuild?.prNumber || prNumber,
      gitCommit: matchedBuild?.commit || gitCommit,
      buildTimestamp: matchedBuild?.startTime || executionDetails.pipelineExecution?.lastUpdateTime?.toISOString(),
      matchedBuild: matchedBuild
    };
    
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
            
            if (isBackend) {
              currentDeployment.backend = {
                pipelineName: pipeline.name,
                executionId: successfulExecution.pipelineExecutionId,
                deployedAt: successfulExecution.lastUpdateTime?.toISOString(),
                prNumber: buildInfo.prNumber,
                gitCommit: buildInfo.gitCommit,
                buildTimestamp: buildInfo.buildTimestamp || successfulExecution.lastUpdateTime?.toISOString(),
                matchedBuild: buildInfo.matchedBuild
              };
            } else if (isFrontend) {
              currentDeployment.frontend = {
                pipelineName: pipeline.name,
                executionId: successfulExecution.pipelineExecutionId,
                deployedAt: successfulExecution.lastUpdateTime?.toISOString(),
                prNumber: buildInfo.prNumber,
                gitCommit: buildInfo.gitCommit,
                buildTimestamp: buildInfo.buildTimestamp || successfulExecution.lastUpdateTime?.toISOString(),
                matchedBuild: buildInfo.matchedBuild
              };
            }
            
            // Track the most recent deployment time for this environment
            if (!lastDeployedAt || successfulExecution.lastUpdateTime > new Date(lastDeployedAt)) {
              lastDeployedAt = successfulExecution.lastUpdateTime?.toISOString();
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
    console.log('⚠️  No pipeline data available, falling back to build-based simulation');
    return generateFallbackDeploymentStatus(builds);
  }
  
  // Enhance pipeline status with available updates from builds
  // Use all deployment builds - don't rely solely on isDeployable flag due to CloudWatch rate limiting
  const deploymentBuilds = builds.filter(build => 
    build.status === 'SUCCEEDED' && 
    build.type === 'production' // Only production builds are deployable
  );
  
  return pipelineStatus.map(envStatus => {
    // Find available updates by comparing deployment builds with current deployment timestamps
    const envName = envStatus.environment;
    
    // Filter builds for this specific environment
    const envBuilds = deploymentBuilds.filter(build => {
      const projectName = build.projectName.toLowerCase();
      if (envName === 'production') {
        return projectName.includes('prod');
      }
      return projectName.includes(envName);
    });
    
    // Get current deployment timestamps for comparison (use deployedAt, not buildTimestamp)
    const currentBackendBuildTime = envStatus.currentDeployment?.backend?.deployedAt ? 
      new Date(envStatus.currentDeployment.backend.deployedAt).getTime() : 0;
    const currentFrontendBuildTime = envStatus.currentDeployment?.frontend?.deployedAt ? 
      new Date(envStatus.currentDeployment.frontend.deployedAt).getTime() : 0;
    
    console.log(`      🔍 ${envName} - Current backend build time: ${new Date(currentBackendBuildTime)}, frontend: ${new Date(currentFrontendBuildTime)}`);
    console.log(`      📦 Found ${envBuilds.length} successful production builds for ${envName}`);
    
    // Debug: Show all builds for this environment
    envBuilds.forEach(build => {
      const buildTime = new Date(build.startTime).getTime();
      const isNewer = build.projectName.includes('backend') ? 
        buildTime > currentBackendBuildTime : 
        buildTime > currentFrontendBuildTime;
      console.log(`        📅 ${build.projectName}: ${build.startTime} (${build.status}) PR#${build.prNumber || 'none'} ${isNewer ? '✨ NEWER' : '📋 current/older'}`);
    });
    
    // Get currently deployed build IDs to exclude from available updates
    const currentBackendBuildId = envStatus.currentDeployment?.backend?.matchedBuild?.buildId;
    const currentFrontendBuildId = envStatus.currentDeployment?.frontend?.matchedBuild?.buildId;

    const availableBackendUpdates = envBuilds
      .filter(build => 
        build.projectName.includes('backend') && 
        new Date(build.startTime).getTime() > currentBackendBuildTime &&
        build.buildId !== currentBackendBuildId // Exclude currently deployed build
      )
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
      .slice(0, 1) // Show only the most recent available update
      .map(build => ({
        prNumber: build.prNumber,
        gitCommit: build.commit,
        buildTimestamp: build.startTime
      }));
      
    const availableFrontendUpdates = envBuilds
      .filter(build => 
        build.projectName.includes('frontend') && 
        new Date(build.startTime).getTime() > currentFrontendBuildTime &&
        build.buildId !== currentFrontendBuildId // Exclude currently deployed build
      )
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
      .slice(0, 1) // Show only the most recent available update
      .map(build => ({
        prNumber: build.prNumber,
        gitCommit: build.commit,
        buildTimestamp: build.startTime
      }));

    console.log(`      🎯 Available updates for ${envName}: backend=${availableBackendUpdates.length}, frontend=${availableFrontendUpdates.length}`);
    
    return {
      ...envStatus,
      availableUpdates: {
        backend: availableBackendUpdates,
        frontend: availableFrontendUpdates
      }
    };
  });
};

// Fallback deployment status (conservative approach - show no deployments when pipeline data unavailable)
const generateFallbackDeploymentStatus = (builds) => {
  console.log('⚠️  Using fallback deployment status - showing conservative "no deployment" state');
  
  const deploymentBuilds = builds.filter(build => build.isDeployable);
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
        buildTimestamp: build.startTime
      }));
      
    const availableFrontendUpdates = frontendBuilds
      .filter(build => build.status === 'SUCCESS' || build.status === 'SUCCEEDED')
      .slice(0, 3) // Show top 3 available builds
      .map(build => ({
        prNumber: build.prNumber,
        gitCommit: build.commit,
        buildTimestamp: build.startTime
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
  const deploymentBuilds = builds.filter(build => build.isDeployable);
  
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