require('dotenv').config();
const express = require('express');
const cors = require('cors');
const basicAuth = require('express-basic-auth');
const { CodeBuildClient, BatchGetBuildsCommand, ListBuildsForProjectCommand, StartBuildCommand, RetryBuildCommand } = require('@aws-sdk/client-codebuild');
const { CodePipelineClient, ListPipelinesCommand, GetPipelineCommand, ListPipelineExecutionsCommand, GetPipelineExecutionCommand, StartPipelineExecutionCommand } = require('@aws-sdk/client-codepipeline');
const githubAPI = require('./github-api');

const app = express();
const PORT = process.env.PORT || 3004;

// AWS query start date - filter builds/executions to only include those from Sept 15, 2025 onwards (new format only)
const awsQueryStartDate = new Date('2025-09-15T00:00:00.000Z'); // September 15, 2025 at midnight UTC

// Unified function to map project names to GitHub repository names
const getRepoFromProject = (projectName) => {
  return projectName?.includes('backend') ? 'backend' : 'frontend';
};

// Enable CORS for frontend
app.use(cors());
app.use(express.json());

// Create API router that duplicates all routes under /api prefix
const apiRouter = express.Router();

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

} else {
}

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION || 'us-west-2' });
const codepipeline = new CodePipelineClient({ region: process.env.AWS_REGION || 'us-west-2' });

// Place to put builds that were run with invalid data and so need to be filtered out of our processing
// For example, when testing out running builds from this dashboard, sometimes we didn't send all of the
// required environment variables so the build failed and we don't want this build included
const ignoredUnknownBuilds = new Set([
]);


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

// Shared validation functions to reduce duplication
const validateRequiredParams = (res, params, paramNames, customMessage = null) => {
  const missing = paramNames.filter(name => !params[name]);
  if (missing.length > 0) {
    res.status(400).json({
      error: 'Missing required parameters',
      message: customMessage || `Please provide: ${missing.join(', ')}`
    });
    return false;
  }
  return true;
}

const validateEnvironment = (res, environment) => {
  const validEnvironments = ['sandbox', 'demo', 'production'];
  if (!validEnvironments.includes(environment)) {
    res.status(400).json({
      error: 'Invalid environment',
      message: `Environment must be one of: ${validEnvironments.join(', ')}`
    });
    return false;
  }
  return true;
}

const validatePipelineName = (res, pipelineName, expectedPrefix) => {
  if (!pipelineName.startsWith(expectedPrefix) || !/^[a-zA-Z0-9\-]+$/.test(pipelineName)) {
    res.status(400).json({
      error: 'Invalid pipeline name',
      message: `Pipeline name must be a valid ${expectedPrefix}* pipeline`
    });
    return false;
  }
  return true;
}

const validateRepository = (res, repo) => {
  if (!['backend', 'frontend'].includes(repo)) {
    res.status(400).json({
      error: 'Invalid repository',
      message: 'Repository must be backend or frontend'
    });
    return false;
  }
  return true;
}

// Shared function to handle all API errors consistently across all endpoints
const handleApiError = (error, res, operation = 'operation', defaultErrorMessage = 'Operation failed') => {
  // Log the error first
  console.error(`❌ Error during ${operation}:`, error);

  // Check if this is a rate limiting error first
  if (isRateLimitError(error)) {
    console.log(`⚠️  AWS API rate limiting detected during ${operation}`);
    return res.status(429).json({
      error: 'rate_limited',
      message: 'API rate limiting detected - please wait and try again'
    });
  }

  // Handle other specific error types if needed (e.g., 404)
  if (error.statusCode === 404) {
    return res.status(404).json({
      error: 'Not found',
      message: error.message
    });
  }

  // Default to 500 error for all other cases
  return res.status(500).json({
    error: defaultErrorMessage,
    message: error.message
  });
}

const getS3ArtifactConfig = async (pipelineName, codepipelineClient) => {
  try {

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
      return { bucketName, objectKey };
    } else {
      return { bucketName: null, objectKey: null };
    }
  } catch (error) {
    return { bucketName: null, objectKey: null };
  }
};


// Build classification based on project and environment metadata
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
    return {
      type: 'dev-test',
      isDeployable: false,
      prNumber: actualPRNumber,
      sourceBranch: sourceBranch
    };
  }

  if (build.projectName.includes('mainbranchtest')) {
    return {
      type: 'main-test',
      isDeployable: false,
      prNumber: actualPRNumber,
      sourceBranch: sourceBranch
    };
  }

  // Default: production builds (anything not classified as test builds above)

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
  
  
  // Get commit details from GitHub (includes message and other metadata)
  const commitDetails = await githubAPI.getCommitDetails(repo, commitSha);
  if (!commitDetails?.message) {
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
      return match[1];
    }
  }
  
  return null;
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

  const classification = await classifyBuild(build);
  
  // Skip builds that can't be classified yet (missing metadata)
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
    hotfixDetails = await githubAPI.getCommitDetails(repo, build.resolvedSourceVersion);

    if (hotfixDetails) {
      // Mark as hotfix and add to the classification
      hotfixDetails.isHotfix = true;
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
    } else if (commitDetails?.message) {
      // Fallback: try to extract PR title from commit message
      prTitle = extractPRTitleFromCommitMessage(commitDetails.message);
    }

  }


  // Extract build number - AWS provides this directly as an integer
  const buildNumber = build.buildNumber;

  return {
    buildId: build.id,
    buildNumber: buildNumber, // CodeBuild build number (sequential integer)
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
      
      // Get recent build IDs - limit at API level for efficiency
      const listCommand = new ListBuildsForProjectCommand({
        projectName,
        sortOrder: 'DESCENDING',
        maxResults: maxBuilds  // Limit at API level instead of slicing
      });

      const buildIds = await codebuild.send(listCommand);
      const recentBuildIds = buildIds.ids || [];
      
      if (recentBuildIds.length === 0) {
        continue;
      }
      
      // Get detailed build info
      const batchCommand = new BatchGetBuildsCommand({
        ids: recentBuildIds
      });
      
      const buildDetails = await codebuild.send(batchCommand);

      // Filter builds to only include those from Sept 15, 2025 onwards (new format only)
      const todayBuilds = (buildDetails.builds || []).filter(build => {
        if (!build.startTime) return false;
        const buildDate = new Date(build.startTime);
        return buildDate >= awsQueryStartDate;
      });


      const processedBuilds = await Promise.all(
        todayBuilds.map(build => processBuild(build))
      );
      
      // Filter out null results (invalid builds)
      const validBuilds = processedBuilds.filter(build => build !== null);
      
      allBuilds.push(...validBuilds);
    } catch (error) {
      console.error(`Error fetching builds for ${projectName}:`, error.message);
    }
  }
  
  // Second pass: use GitHub API to find missing PR numbers for main branch builds
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

  // Pipeline name is the same as the project name
  const searchProjectName = pipelineName;

  try {
    
    // Get pipeline execution details to find the actual source revision
    const getPipelineExecutionCommand = new GetPipelineExecutionCommand({
      pipelineName: pipelineName,
      pipelineExecutionId: executionId
    });
    
    const executionDetails = await codepipeline.send(getPipelineExecutionCommand);
    
    
    const sourceRevisions = executionDetails.pipelineExecution?.artifactRevisions || [];
    
    
    if (sourceRevisions.length === 0) {
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
    } else {
      // This is a git commit
      gitCommit = primarySource.revisionId?.substring(0, 8);
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
    
    
    // NEW: Pipeline-centric correlation - start with S3 version ID and get Docker image URI
    let matchedBuild = null;
    let dockerImageUri = null;
    
    // For S3 version ID - need to access the S3 bucket to get the git commit hash
    if (s3VersionId) {
      
      try {
        // Get S3 bucket and object key using shared function
        const s3Config = await getS3ArtifactConfig(pipelineName, codepipeline);
        const bucketName = s3Config.bucketName;
        const objectKey = s3Config.objectKey;
        
        if (bucketName && objectKey) {
          
          // Use AWS SDK to get the S3 object with version ID
          const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
          const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' });
          
          const getObjectCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: objectKey,
            VersionId: s3VersionId
          });
          
          const s3Response = await s3Client.send(getObjectCommand);
          
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
            const imageDefContent = await zip.files['imagedefinitions.json'].async('string');
            
            try {
              const imageDef = JSON.parse(imageDefContent);
              if (Array.isArray(imageDef) && imageDef.length > 0 && imageDef[0].imageUri) {
                const imageUri = imageDef[0].imageUri;
                // Split by ":" and take the second part (tag) which should be the commit hash
                const uriParts = imageUri.split(':');
                if (uriParts.length >= 2) {
                  extractedCommit = uriParts[1].substring(0, 8); // Take first 8 chars
                }
              }
            } catch (parseError) {
              // Error parsing imagedefinitions.json - continue without commit
            }
          }
          
          if (extractedCommit) {
            gitCommit = extractedCommit;
          }
          
        }
        
      } catch (error) {
        // Error accessing S3 version - continue without S3 data
      }
    }
    
    // Extract Docker image URI from git commit to enable Method A correlation
    if (gitCommit && searchProjectName && allBuilds.length > 0) {
      const projectBuilds = allBuilds.filter(build => build.projectName === searchProjectName);
      // Find build that matches the git commit hash to get its Docker image URI

      for (const build of projectBuilds) {
        const buildCommit = build.commit || build.sourceVersion?.substring(0, 8);
        if (buildCommit === gitCommit) {
          dockerImageUri = build.artifacts?.dockerImageUri;
          break;
        }
      }

    }
    
    // Now that we have the Docker image URI from the pipeline deployment, find the matching CodeBuild
    if (dockerImageUri && searchProjectName && allBuilds.length > 0) {
      const projectBuilds = allBuilds.filter(build => build.projectName === searchProjectName);
      
      // Find CodeBuild with matching Docker image URI
      for (const build of projectBuilds) {
        if (build.artifacts?.dockerImageUri === dockerImageUri) {
          matchedBuild = build;
          matchedBuild._matchedViaArtifacts = true;
          break;
        }
      }
      
      // If exact match not found, try tag matching
      if (!matchedBuild) {
        // Extract tag from pipeline Docker image URI
        const pipelineTagMatch = dockerImageUri.match(/:([^:]+)$/);
        if (pipelineTagMatch) {
          const pipelineTag = pipelineTagMatch[1];
          
          for (const build of projectBuilds) {
            if (build.artifacts?.dockerImageUri) {
              const buildTagMatch = build.artifacts.dockerImageUri.match(/:([^:]+)$/);
              if (buildTagMatch) {
                const buildTag = buildTagMatch[1];
                if (buildTag === pipelineTag) {
                  matchedBuild = build;
                  matchedBuild._matchedViaArtifacts = true;
                  break;
                }
              }
            }
          }
        }
      }
      
    }
    
    // No final fallbacks - only use exact correlations to prevent false positives
    
    // Determine which method was used for matching (only Method A is used)
    let matchingMethod = 'None';
    if (matchedBuild) {
      if (matchedBuild._matchedViaArtifacts) {
        matchingMethod = 'Method A (Artifacts)';
      } else {
        matchingMethod = 'Unknown'; // Should not happen with Method A only
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
    
    return result;
    
  } catch (error) {
    console.error(`        ❌ Error getting pipeline execution details for ${pipelineName}:`, error.message);
    return { prNumber: null, gitCommit: null, buildTimestamp: null, matchedBuild: null, matchingMethod: 'None' };
  }
};

const getPipelineDeploymentStatus = async (builds) => {
  try {

    // For deployment correlation, we need more build history than the main dashboard
    // to find matches for older deployments
    const allProjectNames = [
      'eval-backend-sandbox', 'eval-backend-demo', 'eval-backend-prod',
      'eval-frontend-sandbox', 'eval-frontend-demo', 'eval-frontend-prod'
    ];

    // Fetch builds for each project separately with a limit of 10 builds per project
    const deploymentBuilds = [];
    for (const projectName of allProjectNames) {
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
    
    
    const environments = ['sandbox', 'demo', 'production'];
    const deploymentStatus = [];
    
    for (const env of environments) {
      
      // Find pipelines for this environment
      const envPipelines = deploymentPipelines.filter(pipeline => {
        const name = pipeline.name.toLowerCase();
        if (env === 'production') {
          return name.includes('prod');
        }
        return name.includes(env);
      });
      
      
      const currentDeployment = { backend: null, frontend: null };
      let lastDeployedAt = null;
      
      // PIPELINE-CENTRIC APPROACH: Get deployments from pipeline executions
      
      
        // Get the most recent successful execution for each pipeline
        for (const pipeline of envPipelines) {
        try {
          
          const listExecutionsCommand = new ListPipelineExecutionsCommand({
            pipelineName: pipeline.name,
            maxResults: 10 // Increased to capture more recent executions
          });
          
          const executions = await codepipeline.send(listExecutionsCommand);
          
          // Filter pipeline executions to only include those from Sept 15, 2025 onwards
          const todayExecutions = (executions.pipelineExecutionSummaries || []).filter(exec => {
            if (!exec.lastUpdateTime) return false;
            const execDate = new Date(exec.lastUpdateTime);
            return execDate >= awsQueryStartDate;
          });

          // Log all executions for debugging

          // Check for active (InProgress) deployments
          const activeExecution = todayExecutions.find(exec => exec.status === 'InProgress');
          const isActivelyDeploying = !!activeExecution;

          if (isActivelyDeploying) {
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


          if (successfulExecution) {
            
            // Helper function to create deployment entry
            const createDeploymentEntry = (buildInfo, pipeline, successfulExecution, isActivelyDeploying, extraProps = {}) => {
              return {
                pipelineName: pipeline.name,
                executionId: successfulExecution.pipelineExecutionId,
                deployedAt: successfulExecution.lastUpdateTime?.toISOString(),
                prNumber: buildInfo.prNumber,
                gitCommit: buildInfo.gitCommit,
                buildTimestamp: buildInfo.buildTimestamp || successfulExecution.lastUpdateTime?.toISOString(),
                buildNumber: buildInfo.matchedBuild?.buildNumber, // Include build number from matched build
                matchedBuild: buildInfo.matchedBuild,
                matchingMethod: buildInfo.matchingMethod,
                deploymentStatus: isActivelyDeploying ? 'DEPLOYING' : 'DEPLOYED',
                ...extraProps
              };
            };

            // Helper function to create "too old build" deployment entry
            const createTooOldBuildEntry = (buildInfo, pipeline, successfulExecution, isActivelyDeploying) => {
              return {
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
            };

            // Get build information from pipeline execution details
            const buildInfo = await getBuildInfoFromPipelineExecution(pipeline.name, successfulExecution.pipelineExecutionId, deploymentBuilds);
            
            // Determine if this is backend or frontend based on pipeline name
            const isBackend = pipeline.name.toLowerCase().includes('backend');
            const isFrontend = pipeline.name.toLowerCase().includes('frontend');
            
            // Create deployment entry for both matched and unmatched builds
            if (buildInfo.matchedBuild && buildInfo.matchingMethod !== 'None') {
              // Valid matched build
              const deploymentEntry = createDeploymentEntry(buildInfo, pipeline, successfulExecution, isActivelyDeploying);

              if (isBackend) {
                currentDeployment.backend = deploymentEntry;
              } else if (isFrontend) {
                currentDeployment.frontend = deploymentEntry;
              }

              // Only track deployment time when we have a valid correlation
              if (!lastDeployedAt || successfulExecution.lastUpdateTime > new Date(lastDeployedAt)) {
                lastDeployedAt = successfulExecution.lastUpdateTime?.toISOString();
              }
            } else {
              // No matching build found - show "too old build" message
              console.log(`    ⚠️ Creating deployment entry for ${pipeline.name} with 'too old build' message (method: ${buildInfo.matchingMethod})`);

              const tooOldEntry = createTooOldBuildEntry(buildInfo, pipeline, successfulExecution, isActivelyDeploying);

              if (isBackend) {
                currentDeployment.backend = tooOldEntry;
              } else if (isFrontend) {
                currentDeployment.frontend = tooOldEntry;
              }

              // Track deployment time even for unmatched builds
              if (!lastDeployedAt || successfulExecution.lastUpdateTime > new Date(lastDeployedAt)) {
                lastDeployedAt = successfulExecution.lastUpdateTime?.toISOString();
              }
            }
          } else {
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
    
    
    // Get currently deployed build IDs to exclude from available updates
    const currentBackendBuildId = envStatus.currentDeployment?.backend?.matchedBuild?.buildId;
    const currentFrontendBuildId = envStatus.currentDeployment?.frontend?.matchedBuild?.buildId;

    // Find the exact backend build that appears in Deployment Builds table by project name
    const expectedBackendProjectName = getProjectName(envName, 'backend');
    const latestBackendBuild = deploymentBuilds
      .filter(build => build.projectName === expectedBackendProjectName)
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())[0];
      
      
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
    

    return {
      ...envStatus,
      availableUpdates: {
        backend: availableBackendUpdates,
        frontend: availableFrontendUpdates
      }
    };
  });
  
  
  return result;
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

  // Generate deployment status for the three environments (now async)
  const deployments = await generateDeploymentStatus(builds);

  const response = {
    devBuilds: latestDevBuilds,
    deploymentBuilds: latestMainBuilds,
    mainTestBuilds: latestMainTestBuilds,
    unknownBuilds: latestUnknownBuilds,
    deployments: deployments,
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

  if (latestUnknownBuilds.length > 0) {
  }

  return response;
};

// Shared Functions for Endpoint Logic

// Shared function for independent deployment (used by both /deploy-independent and /api/deploy-independent)
async function deployIndependentLogic(environment, buildId, componentType, overrideOutOfDate = false) {
  // buildId is optional - when not provided, pipeline will build from latest GitHub source
  if (!environment || !componentType) {
    throw new Error('Missing required parameters: Please provide environment and componentType');
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

  // For frontend deployments
  if (componentType === 'frontend') {
    const pipelineName = environment === 'production' ? 'eval-frontend-prod' : `eval-frontend-${environment}`;


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


  const command = new BatchGetBuildsCommand({
    ids: [buildId]
  });

  const result = await codebuild.send(command);

  if (!result.builds || result.builds.length === 0) {
    const error = new Error(`Build ${buildId} not found`);
    error.statusCode = 404;
    throw error;
  }

  const build = result.builds[0];

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


  const command = new RetryBuildCommand({
    id: buildId
  });
  const result = await codebuild.send(command);


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


// Shared function for triggering single build (used by both /trigger-single-build and /api/trigger-single-build)
async function triggerSingleBuildLogic(projectName, prNumber, sourceBranch) {
  if (!projectName) {
    throw new Error('Project name is required');
  }

  const targetBranch = sourceBranch || 'main';

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
// Note: Many routes have both /api/* and /* versions for Render deployment compatibility
// =============================================================================

// -----------------------------------------------------------------------------
// BUILD DATA ENDPOINTS
// -----------------------------------------------------------------------------

const getBuildsRequest = async (req, res) => {
  try {
    const categorizedBuilds = await fetchBuildsLogic();
    res.json(categorizedBuilds);
  } catch (error) {
    return handleApiError(error, res, 'fetch builds', 'Failed to fetch build data');
  }
};

app.get('/builds', getBuildsRequest);

// -----------------------------------------------------------------------------
// BUILD ACTION ENDPOINTS
// -----------------------------------------------------------------------------

const triggerSingleBuildRequest = async (req, res) => {
  try {
    const { projectName, prNumber, sourceBranch } = req.body;
    const result = await triggerSingleBuildLogic(projectName, prNumber, sourceBranch);
    res.json(result);
  } catch (error) {
    return handleApiError(error, res, 'trigger build', 'Failed to trigger build');
  }
};

app.post('/trigger-single-build', triggerSingleBuildRequest);

const retryBuildRequest = async (req, res) => {
  try {
    const { buildId, projectName } = req.body;
    const result = await retryBuildLogic(buildId, projectName);
    res.json(result);
  } catch (error) {
    return handleApiError(error, res, 'retry build', 'Failed to retry build');
  }
};

app.post('/retry-build', retryBuildRequest);

// -----------------------------------------------------------------------------
// DEPLOYMENT ACTION ENDPOINTS
// -----------------------------------------------------------------------------

const handleDeployCoordinatedRequest = async (req, res) => {
  try {
    const { environment, backendBuildId, frontendBuildId, overrideOutOfDate = false } = req.body;

    if (!validateRequiredParams(res, { environment, backendBuildId, frontendBuildId },
        ['environment', 'backendBuildId', 'frontendBuildId'],
        'Please provide environment, backendBuildId, and frontendBuildId for coordinated deployment')) {
      return;
    }

    if (!validateEnvironment(res, environment)) {
      return;
    }


    // Check for out-of-date builds unless override is specified
    if (!overrideOutOfDate) {
      // TODO: Add validation logic here - for now, just log
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
    return handleApiError(error, res, 'coordinated deployment', 'Deployment failed');
  }
};

app.post('/deploy-coordinated', handleDeployCoordinatedRequest);

// Shared handler for deploy-independent endpoints (both /deploy-independent and /api/deploy-independent for compatibility)
const handleDeployIndependentRequest = async (req, res) => {
  try {
    const { environment, buildId, componentType, overrideOutOfDate = false } = req.body;
    const result = await deployIndependentLogic(environment, buildId, componentType, overrideOutOfDate);
    res.json(result);
  } catch (error) {
    return handleApiError(error, res, 'independent deployment', 'Deployment failed');
  }
};

app.post('/deploy-independent', handleDeployIndependentRequest);

// Shared handler for deploy-frontend endpoints (both /deploy-frontend and /api/deploy-frontend for compatibility)
const handleDeployFrontendRequest = async (req, res) => {
  try {
    const { pipelineName, buildId } = req.body;

    if (!validateRequiredParams(res, { pipelineName, buildId },
        ['pipelineName', 'buildId'],
        'Please provide both pipelineName and buildId to deploy frontend')) {
      return;
    }

    if (!validatePipelineName(res, pipelineName, 'eval-frontend-')) {
      return;
    }

    // Start the pipeline execution
    const command = new StartPipelineExecutionCommand({
      name: pipelineName
    });

    const result = await codepipeline.send(command);


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
    return handleApiError(error, res, 'frontend deployment', 'Failed to deploy frontend');
  }
};

app.post('/deploy-frontend', handleDeployFrontendRequest);

// -----------------------------------------------------------------------------
// STATUS & MONITORING ENDPOINTS
// -----------------------------------------------------------------------------

// Shared handler for deployment-status endpoints (both /deployment-status and /api/deployment-status for compatibility)
const handleDeploymentStatusRequest = async (req, res) => {
  try {
    const { pipelineExecutionId } = req.params;

    if (!validateRequiredParams(res, { pipelineExecutionId },
        ['pipelineExecutionId'], 'Missing pipeline execution ID')) {
      return;
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
    return handleApiError(error, res, 'deployment status check', 'Failed to check deployment status');
  }
};

app.get('/deployment-status/:pipelineExecutionId', handleDeploymentStatusRequest);

// Shared handler for build-status endpoints (both /build-status and /api/build-status for compatibility)
const handleBuildStatusRequest = async (req, res) => {
  try {
    const { buildId } = req.params;
    const result = await getBuildStatusLogic(buildId);
    res.json(result);
  } catch (error) {
    return handleApiError(error, res, 'build status check', 'Failed to check build status');
  }
};

app.get('/build-status/:buildId', handleBuildStatusRequest);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// GitHub cache stats endpoint
app.get('/cache-stats', (req, res) => {
  const stats = githubAPI.getCacheStats();
  res.json({
    cache: stats,
    timestamp: new Date().toISOString()
  });
});



// -----------------------------------------------------------------------------
// GIT/GITHUB INTEGRATION ENDPOINTS
// -----------------------------------------------------------------------------


// Shared handler for latest-merge endpoints (both /latest-merge and /api/latest-merge for compatibility)
const handleLatestMergeRequest = async (req, res) => {
  try {
    const result = await githubAPI.fetchLatestMergeApiLogic(req.params.repo, req.params.branch);
    // Extract just the latestCommit data to match the expected format
    res.json(result.latestCommit);
  } catch (error) {
    return handleApiError(error, res, `fetch latest merge for ${req.params.repo}/${req.params.branch}`, 'Failed to fetch latest merge info');
  }
};

app.get('/latest-merge/:repo/:branch', handleLatestMergeRequest);


// Compare latest GitHub commit with newest build and return commit count difference
app.get('/commit-comparison/:repo', async (req, res) => {
  try {
    const { repo } = req.params;

    if (!validateRepository(res, repo)) {
      return;
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


    if (repoBuilds.length === 0) {
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
    return handleApiError(error, res, 'compare commits', 'Failed to compare commits');
  }
});

// Register all routes under /api prefix as well for frontend compatibility
apiRouter.get('/builds', getBuildsRequest);
apiRouter.post('/trigger-single-build', triggerSingleBuildRequest);
apiRouter.post('/retry-build', retryBuildRequest);
apiRouter.post('/deploy-coordinated', handleDeployCoordinatedRequest);
apiRouter.post('/deploy-independent', handleDeployIndependentRequest);
apiRouter.post('/deploy-frontend', handleDeployFrontendRequest);
apiRouter.get('/deployment-status/:pipelineExecutionId', handleDeploymentStatusRequest);
apiRouter.get('/build-status/:buildId', handleBuildStatusRequest);
apiRouter.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});
apiRouter.get('/cache-stats', (req, res) => {
  const stats = githubAPI.getCacheStats();
  res.json(stats);
});
apiRouter.get('/latest-merge/:repo/:branch', handleLatestMergeRequest);
apiRouter.get('/commit-comparison/:repo', async (req, res) => {
  try {
    const { repo } = req.params;
    const { prodSha, devSha } = req.query;

    if (!validateRequiredParams(res, { repo, prodSha, devSha }, ['repo', 'prodSha', 'devSha'])) {
      return;
    }

    if (!validateRepository(res, repo)) {
      return;
    }

    const comparison = await githubAPI.compareCommits(repo, prodSha, devSha);
    res.json(comparison);

  } catch (error) {
    return handleApiError(error, res, 'compare commits', 'Failed to compare commits');
  }
});

// Mount the API router
app.use('/api', apiRouter);

// In production, serve static files from the built frontend
// In development, the frontend runs on its own port with Vite dev server
const path = require('path');
const fs = require('fs');

if (process.env.NODE_ENV === 'production') {
  // Path to the built frontend files
  const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');

  // Check if the built frontend exists
  if (fs.existsSync(frontendDistPath)) {

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
}

// Start server with enhanced process identification
const server = app.listen(PORT, () => {
  const { execSync } = require('child_process');

  try {
    // Get git commit hash for version tracking
    const gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim().substring(0, 7);
  } catch (e) {
    // Git not available
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