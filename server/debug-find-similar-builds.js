const { CodeBuildClient, BatchGetBuildsCommand, ListBuildsForProjectCommand } = require('@aws-sdk/client-codebuild');

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION || 'us-west-2' });

async function findSimilarBuilds() {
  try {
    console.log(`🔍 Searching for builds with ID containing '18cb94c6'...`);

    // Search in eval-frontend-demo project
    const listCommand = new ListBuildsForProjectCommand({
      projectName: 'eval-frontend-demo',
      sortOrder: 'DESCENDING'
    });

    const buildIds = await codebuild.send(listCommand);
    const recentBuildIds = buildIds.ids?.slice(0, 100) || []; // Get more builds

    console.log(`📋 Found ${recentBuildIds.length} builds in eval-frontend-demo`);

    // Look for builds containing 18cb94c6
    const matchingBuilds = recentBuildIds.filter(id => id.includes('18cb94c6'));

    console.log(`🎯 Found ${matchingBuilds.length} builds matching '18cb94c6':`);
    matchingBuilds.forEach(id => {
      console.log(`   - ${id}`);
    });

    if (matchingBuilds.length > 0) {
      // Get detailed info for all matching builds
      const batchCommand = new BatchGetBuildsCommand({
        ids: matchingBuilds
      });

      const result = await codebuild.send(batchCommand);

      if (result.builds) {
        console.log(`\n📊 Detailed build information:`);
        result.builds.forEach(build => {
          console.log(`\n🏗️  Build: ${build.id}`);
          console.log(`   sourceVersion: ${build.sourceVersion}`);
          console.log(`   resolvedSourceVersion: ${build.resolvedSourceVersion}`);
          console.log(`   artifacts.md5sum: ${build.artifacts?.md5sum}`);
          console.log(`   buildStatus: ${build.buildStatus}`);
          console.log(`   startTime: ${build.startTime}`);
        });
      }
    }

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

findSimilarBuilds();