require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { CodeBuildClient, BatchGetBuildsCommand, ListBuildsForProjectCommand, BatchGetProjectsCommand } = require('@aws-sdk/client-codebuild');
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

// Get Run Mode from CloudWatch build logs
const getRunModeFromLogs = async (build) => {
  try {
    if (!build.logs?.groupName) {
      return null;
    }

    const logGroupName = build.logs.groupName;
    const logStreamName = build.logs.streamName;
    
    if (!logStreamName) {
      return null;
    }

    console.log(`Fetching logs for ${build.projectName}:${build.id?.slice(-8)} from ${logGroupName}/${logStreamName}`);

    const command = new GetLogEventsCommand({
      logGroupName,
      logStreamName,
      limit: 100, // Get first 100 log events where RUN_MODE is set
      startFromHead: true
    });

    const response = await cloudwatchlogs.send(command);
    const events = response.events || [];

    // Look for "Selected RUN_MODE : TEST_ONLY" or "Selected RUN_MODE : FULL_BUILD" in logs
    for (const event of events) {
      const message = event.message;
      if (message && message.includes('Selected RUN_MODE :')) {
        const match = message.match(/Selected RUN_MODE :\s*(\w+)/);
        if (match) {
          const runMode = match[1];
          console.log(`Found RUN_MODE: ${runMode} in logs for ${build.projectName}:${build.id?.slice(-8)}`);
          return runMode;
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error(`Error fetching logs for ${build.projectName}:${build.id?.slice(-8)}:`, error.message);
    return null;
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
  
  // Extract PR number from sourceVersion (pr/291 format)
  let extractedPR = null;
  if (sourceVersion?.startsWith('pr/')) {
    extractedPR = sourceVersion.replace('pr/', '');
  }
  
  const finalPRNumber = prNumber || extractedPR;
  
  console.log(`Classifying ${build.projectName}:${build.id?.slice(-8)} - baseRef: ${baseRef}, sourceVersion: ${sourceVersion}, PR: ${finalPRNumber}`);

  // Get the actual Run Mode from build logs (this is the ground truth)
  const runMode = await getRunModeFromLogs(build);
  console.log(`Build ${build.projectName}:${finalPRNumber} - RunMode from logs: ${runMode}`);

  // Rule 1: baseRef === 'refs/heads/main' → Deployment Builds table
  if (baseRef === 'refs/heads/main') {
    console.log(`Main deployment build: ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'FULL_BUILD'}`);
    return {
      type: 'production',
      runMode: runMode || 'FULL_BUILD',
      isDeployable: true,
      prNumber: finalPRNumber
    };
  }
  
  // Rule 2: baseRef === 'refs/heads/dev' → Dev Builds table  
  if (baseRef === 'refs/heads/dev') {
    console.log(`Dev test build: ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'TEST_ONLY'}`);
    return {
      type: 'dev-test',
      runMode: runMode || 'TEST_ONLY',
      isDeployable: false,
      prNumber: finalPRNumber
    };
  }
  
  // FALLBACK: Since baseRef isn't available via API, use Run Mode from logs to determine classification
  if (runMode) {
    if (runMode === 'FULL_BUILD') {
      console.log(`Deployment build (FULL_BUILD): ${build.projectName}:${finalPRNumber}`);
      return {
        type: 'production',
        runMode: runMode,
        isDeployable: true,
        prNumber: finalPRNumber
      };
    } else if (runMode === 'TEST_ONLY') {
      console.log(`Dev test build (TEST_ONLY): ${build.projectName}:${finalPRNumber}`);
      return {
        type: 'dev-test',
        runMode: runMode,
        isDeployable: false,
        prNumber: finalPRNumber
      };
    }
  }
  
  // Fallback for manual main builds
  if (sourceVersion?.includes('main') || sourceVersion === 'refs/heads/main') {
    console.log(`Manual main build: ${build.projectName}`);
    return {
      type: 'production',
      runMode: runMode || 'FULL_BUILD',
      isDeployable: true,
      prNumber: finalPRNumber
    };
  }
  
  // Fallback for prod projects (always deployment builds)
  if (sourceVersion?.startsWith('pr/') && build.projectName.includes('prod')) {
    console.log(`Prod project build: ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'FULL_BUILD'}`);
    return {
      type: 'production',
      runMode: runMode || 'FULL_BUILD',
      isDeployable: true,
      prNumber: finalPRNumber
    };
  }
  
  // Final fallback for demo projects (also deployment builds)  
  if (sourceVersion?.startsWith('pr/') && build.projectName.includes('demo')) {
    console.log(`Demo project build: ${build.projectName}:${finalPRNumber}, runMode: ${runMode || 'FULL_BUILD'}`);
    return {
      type: 'production',
      runMode: runMode || 'FULL_BUILD',
      isDeployable: true,
      prNumber: finalPRNumber
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
        prNumber: finalPRNumber
      };
    } else {
      console.log(`Sandbox dev build (TEST_ONLY): ${build.projectName}:${finalPRNumber}`);
      return {
        type: 'dev-test',
        runMode: runMode || 'TEST_ONLY',
        isDeployable: false,
        prNumber: finalPRNumber
      };
    }
  }
  
  // Default: unknown builds
  console.log(`Unknown build type: ${build.projectName}:${build.id?.slice(-8)}`);
  return {
    type: 'unknown',
    runMode: runMode || 'SKIP',
    isDeployable: false,
    prNumber: finalPRNumber
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
  
  return {
    buildId: build.id,
    projectName: build.projectName,
    status: build.buildStatus, // SUCCESS, FAILED, IN_PROGRESS, etc.
    ...classification,
    prNumber: prNumber || classification.prNumber, // Use extracted PR if available
    sourceVersion: build.sourceVersion, // Include raw sourceVersion for debugging
    resolvedSourceVersion: build.resolvedSourceVersion, // Include commit SHA
    commit: build.resolvedSourceVersion?.substring(0, 7) || build.sourceVersion?.substring(0, 7) || 'unknown',
    startTime: build.startTime,
    endTime: build.endTime,
    duration: build.endTime ? Math.round((build.endTime - build.startTime) / 1000) : null,
    logs: build.logs?.groupName // For potential PR number extraction from logs
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
// Helper function to correlate pipeline deployment with recent successful builds
const getBuildInfoFromRecentBuilds = async (pipelineName, deploymentTime, builds) => {
  try {
    console.log(`      🔍 Correlating ${pipelineName} deployment at ${deploymentTime} with recent builds`);
    
    // Determine if this is backend or frontend and environment from pipeline name
    const isBackend = pipelineName.toLowerCase().includes('backend');
    const isFrontend = pipelineName.toLowerCase().includes('frontend');
    
    let environment = 'sandbox';
    if (pipelineName.toLowerCase().includes('demo')) {
      environment = 'demo';
    } else if (pipelineName.toLowerCase().includes('prod')) {
      environment = 'production';
    }
    
    console.log(`        🏷️  Pipeline type: ${isBackend ? 'backend' : 'frontend'}, environment: ${environment}`);
    
    // Filter builds to matching project type and deployable builds
    const relevantBuilds = builds.filter(build => {
      const projectType = build.projectName.toLowerCase().includes('backend') ? 'backend' : 'frontend';
      const buildEnvironment = build.projectName.toLowerCase().includes('demo') ? 'demo' : 
                              build.projectName.toLowerCase().includes('prod') ? 'production' : 'sandbox';
      
      return projectType === (isBackend ? 'backend' : 'frontend') && 
             buildEnvironment === environment &&
             build.isDeployable === true &&
             build.status === 'SUCCEEDED';
    });
    
    console.log(`        📦 Found ${relevantBuilds.length} relevant deployable builds for ${isBackend ? 'backend' : 'frontend'} ${environment}`);
    
    if (relevantBuilds.length === 0) {
      console.log(`        ❌ No deployable builds found for ${pipelineName}`);
      return { prNumber: null, gitCommit: null, buildTimestamp: null };
    }
    
    // Find the most recent successful build before or around the deployment time
    const deployTime = new Date(deploymentTime);
    const sortedBuilds = relevantBuilds
      .map(build => ({
        ...build,
        endTime: new Date(build.endTime),
        timeDiff: Math.abs(new Date(build.endTime) - deployTime)
      }))
      .sort((a, b) => a.timeDiff - b.timeDiff); // Sort by closest time to deployment
    
    const mostLikelyBuild = sortedBuilds[0];
    
    console.log(`        🎯 Most likely build: ${mostLikelyBuild.projectName}:${mostLikelyBuild.buildId?.slice(-8)} (PR#${mostLikelyBuild.prNumber || 'unknown'}, ${mostLikelyBuild.commit})`);
    console.log(`        ⏰ Build completed: ${mostLikelyBuild.endTime.toISOString()}, deployment: ${deployTime.toISOString()}, diff: ${Math.round(mostLikelyBuild.timeDiff / 1000 / 60)} minutes`);
    
    return {
      prNumber: mostLikelyBuild.prNumber,
      gitCommit: mostLikelyBuild.commit,
      buildTimestamp: mostLikelyBuild.endTime?.toISOString()
    };
    
  } catch (error) {
    console.error(`        ❌ Error correlating builds for pipeline ${pipelineName}:`, error.message);
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
            maxResults: 5
          });
          
          const executions = await codepipeline.send(listExecutionsCommand);
          const successfulExecution = (executions.pipelineExecutionSummaries || [])
            .find(exec => exec.status === 'Succeeded');
          
          if (successfulExecution) {
            console.log(`    ✅ Found successful execution: ${successfulExecution.pipelineExecutionId} at ${successfulExecution.lastUpdateTime}`);
            
            // Get build information by correlating with recent builds
            const buildInfo = await getBuildInfoFromRecentBuilds(pipeline.name, successfulExecution.lastUpdateTime?.toISOString(), builds);
            
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
                buildTimestamp: buildInfo.buildTimestamp || successfulExecution.lastUpdateTime?.toISOString()
              };
            } else if (isFrontend) {
              currentDeployment.frontend = {
                pipelineName: pipeline.name,
                executionId: successfulExecution.pipelineExecutionId,
                deployedAt: successfulExecution.lastUpdateTime?.toISOString(),
                prNumber: buildInfo.prNumber,
                gitCommit: buildInfo.gitCommit,
                buildTimestamp: buildInfo.buildTimestamp || successfulExecution.lastUpdateTime?.toISOString()
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
    
    // Get current deployment build timestamps for comparison
    const currentBackendBuildTime = envStatus.currentDeployment?.backend?.buildTimestamp ? 
      new Date(envStatus.currentDeployment.backend.buildTimestamp).getTime() : 0;
    const currentFrontendBuildTime = envStatus.currentDeployment?.frontend?.buildTimestamp ? 
      new Date(envStatus.currentDeployment.frontend.buildTimestamp).getTime() : 0;
    
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
    
    const availableBackendUpdates = envBuilds
      .filter(build => 
        build.projectName.includes('backend') && 
        new Date(build.startTime).getTime() > currentBackendBuildTime
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
        new Date(build.startTime).getTime() > currentFrontendBuildTime
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

// Fallback deployment status (original simulation logic)
const generateFallbackDeploymentStatus = (builds) => {
  const deploymentBuilds = builds.filter(build => build.isDeployable);
  const environments = ['sandbox', 'demo', 'production'];
  
  return environments.map(env => {
    // Find most recent backend and frontend builds for this environment
    const envBuilds = deploymentBuilds.filter(build => 
      build.projectName.includes(env === 'production' ? 'prod' : env)
    );
    
    const backendBuild = envBuilds
      .filter(build => build.projectName.includes('backend'))
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))[0];
      
    const frontendBuild = envBuilds
      .filter(build => build.projectName.includes('frontend'))
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))[0];
    
    // For available updates, find builds newer than the "deployed" ones
    const simulatedDeployTime = Math.min(
      backendBuild ? new Date(backendBuild.startTime).getTime() : Date.now(),
      frontendBuild ? new Date(frontendBuild.startTime).getTime() : Date.now()
    );
    
    const availableBackendUpdates = deploymentBuilds
      .filter(build => 
        build.projectName.includes('backend') && 
        build.projectName.includes(env === 'production' ? 'prod' : env) &&
        new Date(build.startTime).getTime() > simulatedDeployTime &&
        build.status === 'SUCCESS'
      )
      .map(build => ({
        prNumber: build.prNumber,
        gitCommit: build.commit,
        buildTimestamp: build.startTime
      }));
      
    const availableFrontendUpdates = deploymentBuilds
      .filter(build => 
        build.projectName.includes('frontend') && 
        build.projectName.includes(env === 'production' ? 'prod' : env) &&
        new Date(build.startTime).getTime() > simulatedDeployTime &&
        build.status === 'SUCCESS'
      )
      .map(build => ({
        prNumber: build.prNumber,
        gitCommit: build.commit,
        buildTimestamp: build.startTime
      }));
    
    return {
      environment: env,
      lastDeployedAt: new Date(simulatedDeployTime).toISOString(),
      currentDeployment: {
        backend: backendBuild ? {
          prNumber: backendBuild.prNumber,
          gitCommit: backendBuild.commit,
          buildTimestamp: backendBuild.startTime
        } : null,
        frontend: frontendBuild ? {
          prNumber: frontendBuild.prNumber,
          gitCommit: frontendBuild.commit,
          buildTimestamp: frontendBuild.startTime
        } : null
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
      'eval-sandbox-frontend',
      'eval-sandbox-backend',
      'eval-demo-frontend', 
      'eval-demo-backend',
      'eval-frontend-prod',
      'eval-backend-prod'
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