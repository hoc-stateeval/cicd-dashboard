const { CodeBuildClient, BatchGetBuildsCommand } = require('@aws-sdk/client-codebuild');

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION || 'us-west-2' });

async function debugSpecificBuild() {
  try {
    const buildId = 'eval-frontend-demo:14beaeb9-d530-48a9-b3c4-4fd018cb94c6';

    console.log(`🔍 Fetching specific build: ${buildId}`);

    const command = new BatchGetBuildsCommand({
      ids: [buildId]
    });

    const result = await codebuild.send(command);

    if (result.builds && result.builds.length > 0) {
      const build = result.builds[0];
      console.log(`📋 Raw AWS Build Data:`);
      console.log(`   id: ${build.id}`);
      console.log(`   projectName: ${build.projectName}`);
      console.log(`   sourceVersion: ${build.sourceVersion}`);
      console.log(`   resolvedSourceVersion: ${build.resolvedSourceVersion}`);
      console.log(`   artifacts.md5sum: ${build.artifacts?.md5sum}`);
      console.log(`   buildStatus: ${build.buildStatus}`);
      console.log(`   startTime: ${build.startTime}`);
      console.log(`   endTime: ${build.endTime}`);
    } else {
      console.log('❌ No build found');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

debugSpecificBuild();