const { CodeBuildClient, BatchGetBuildsCommand, ListBuildsForProjectCommand } = require('@aws-sdk/client-codebuild');

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION || 'us-east-1' });

// Branch classification based on your buildspec logic
const classifyBuild = (build) => {
  const env = build.environment?.environmentVariables || [];
  const envVars = env.reduce((acc, { name, value }) => ({ ...acc, [name]: value }), {});
  
  // Extract webhook data from logs or environment
  const sourceVersion = build.sourceVersion;
  const webhookEvent = envVars.CODEBUILD_WEBHOOK_EVENT;
  const headRef = envVars.CODEBUILD_WEBHOOK_HEAD_REF;
  const baseRef = envVars.CODEBUILD_WEBHOOK_BASE_REF;
  
  // Feature → dev (TEST_ONLY builds)
  if (webhookEvent?.includes('PULL_REQUEST') && baseRef === 'refs/heads/dev') {
    return {
      type: 'dev-test',
      branch: headRef?.replace('refs/heads/', '') || 'unknown',
      runMode: 'TEST_ONLY',
      isDeployable: false
    };
  }
  
  // Dev → main (FULL_BUILD for deployment)  
  if (baseRef === 'refs/heads/main' && headRef === 'refs/heads/dev') {
    return {
      type: 'main-deploy',
      branch: 'dev→main', 
      runMode: 'FULL_BUILD',
      isDeployable: true
    };
  }
  
  // Manual main builds (production)
  if (sourceVersion?.includes('main') || sourceVersion === 'refs/heads/main') {
    return {
      type: 'production',
      branch: 'main',
      runMode: 'FULL_BUILD', 
      isDeployable: true
    };
  }
  
  return {
    type: 'unknown',
    branch: 'unknown', 
    runMode: 'SKIP',
    isDeployable: false
  };
};

// Extract build information
const processBuild = (build) => {
  const classification = classifyBuild(build);
  
  return {
    buildId: build.id,
    projectName: build.projectName,
    status: build.buildStatus, // SUCCESS, FAILED, IN_PROGRESS, etc.
    ...classification,
    commit: build.sourceVersion?.substring(0, 7) || 'unknown',
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
      // Get recent build IDs
      const listCommand = new ListBuildsForProjectCommand({
        projectName,
        sortOrder: 'DESCENDING'
      });
      
      const buildIds = await codebuild.send(listCommand);
      const recentBuildIds = buildIds.ids?.slice(0, maxBuilds) || [];
      
      if (recentBuildIds.length === 0) continue;
      
      // Get detailed build info
      const batchCommand = new BatchGetBuildsCommand({
        ids: recentBuildIds
      });
      
      const buildDetails = await codebuild.send(batchCommand);
      const processedBuilds = buildDetails.builds?.map(processBuild) || [];
      
      allBuilds.push(...processedBuilds);
    } catch (error) {
      console.error(`Error fetching builds for ${projectName}:`, error);
    }
  }
  
  return allBuilds.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
};

// Separate dev testing builds from deployment builds
const categorizeBuildHistory = (builds) => {
  const devBuilds = builds.filter(build => build.type === 'dev-test');
  const deploymentBuilds = builds.filter(build => build.isDeployable);
  
  return {
    devBuilds: devBuilds.slice(0, 20), // Recent 20 dev builds
    deploymentBuilds: deploymentBuilds.slice(0, 10), // Recent 10 deployment builds
    summary: {
      totalBuilds: builds.length,
      devTestBuilds: devBuilds.length,
      deploymentBuilds: deploymentBuilds.length,
      failedDevBuilds: devBuilds.filter(b => b.status === 'FAILED').length,
      lastUpdated: new Date().toISOString()
    }
  };
};

// Lambda handler
exports.handler = async (event) => {
  try {
    // Your project names - adjust these to match your actual CodeBuild projects
    const projectNames = [
      'eval-sandbox-frontend',
      'eval-sandbox-backend', 
      'stateeval-frontend',
      'stateeval-backend'
      // Add your actual project names here
    ];
    
    const builds = await getRecentBuilds(projectNames);
    const categorizedBuilds = categorizeBuildHistory(builds);
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify(categorizedBuilds)
    };
    
  } catch (error) {
    console.error('Error in dashboard handler:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Failed to fetch build data',
        message: error.message
      })
    };
  }
};