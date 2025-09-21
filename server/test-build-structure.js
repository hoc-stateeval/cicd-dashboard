const { CodeBuildClient, BatchGetBuildsCommand, ListBuildsForProjectCommand } = require('@aws-sdk/client-codebuild');
require('dotenv').config();

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION || 'us-west-2' });

const investigateBuildStructure = async () => {
  try {
    console.log('🔍 Investigating AWS CodeBuild structure for artifact information...');
    
    // Get a recent build from one of the projects
    const projectName = 'eval-frontend-sandbox'; 
    
    const listCommand = new ListBuildsForProjectCommand({
      projectName,
      sortOrder: 'DESCENDING',
      maxResults: 1  // Just get the most recent build
    });
    
    const recentBuilds = await codebuild.send(listCommand);
    
    if (!recentBuilds.ids || recentBuilds.ids.length === 0) {
      console.log('No builds found for', projectName);
      return;
    }
    
    const buildId = recentBuilds.ids[0];
    console.log(`\nExamining build: ${buildId}`);
    
    // Get detailed build info
    const batchCommand = new BatchGetBuildsCommand({
      ids: [buildId]
    });
    
    const buildDetails = await codebuild.send(batchCommand);
    
    if (!buildDetails.builds || buildDetails.builds.length === 0) {
      console.log('No build details found');
      return;
    }
    
    const build = buildDetails.builds[0];
    
    console.log('\n=== FULL BUILD OBJECT STRUCTURE ===');
    console.log(JSON.stringify(build, null, 2));
    
    console.log('\n=== ARTIFACT INFORMATION ===');
    if (build.artifacts) {
      console.log('✅ Artifacts found:', JSON.stringify(build.artifacts, null, 2));
    } else {
      console.log('❌ No artifacts property found');
    }
    
    console.log('\n=== SECONDARY ARTIFACTS ===');
    if (build.secondaryArtifacts) {
      console.log('✅ Secondary artifacts found:', JSON.stringify(build.secondaryArtifacts, null, 2));
    } else {
      console.log('❌ No secondaryArtifacts property found');
    }
    
    console.log('\n=== BUILD CACHE ===');
    if (build.cache) {
      console.log('Cache info:', JSON.stringify(build.cache, null, 2));
    } else {
      console.log('No cache info found');
    }
    
    console.log('\n=== KEY BUILD PROPERTIES FOR ARTIFACT TRACKING ===');
    console.log('Build ID:', build.id);
    console.log('Project Name:', build.projectName);
    console.log('Source Version:', build.sourceVersion);
    console.log('Resolved Source Version:', build.resolvedSourceVersion);
    console.log('Build Number:', build.buildNumber);
    console.log('Build Status:', build.buildStatus);
    
    // Look for any hash-like properties that could be used for artifact correlation
    console.log('\n=== POTENTIAL ARTIFACT IDENTIFIERS ===');
    const allKeys = Object.keys(build);
    const hashLikeKeys = allKeys.filter(key => 
      key.toLowerCase().includes('hash') || 
      key.toLowerCase().includes('md5') ||
      key.toLowerCase().includes('sha') ||
      key.toLowerCase().includes('etag') ||
      key.toLowerCase().includes('checksum')
    );
    
    if (hashLikeKeys.length > 0) {
      console.log('Found hash-like properties:');
      hashLikeKeys.forEach(key => {
        console.log(`  ${key}:`, build[key]);
      });
    } else {
      console.log('No obvious hash/checksum properties found at top level');
    }
    
  } catch (error) {
    console.error('Error investigating build structure:', error);
  }
};

investigateBuildStructure();