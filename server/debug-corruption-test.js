const { CodeBuildClient, BatchGetBuildsCommand } = require('@aws-sdk/client-codebuild');

const codebuild = new CodeBuildClient({ region: process.env.AWS_REGION || 'us-west-2' });

async function testCorruption() {
  try {
    const buildId = 'eval-frontend-demo:14beaeb9-d530-48a9-b3c4-4fd018cb94c6';

    console.log(`🔍 Testing corruption for build: ${buildId}`);

    // Direct AWS API call
    const command = new BatchGetBuildsCommand({
      ids: [buildId]
    });

    const result = await codebuild.send(command);

    if (result.builds && result.builds.length > 0) {
      const build = result.builds[0];

      console.log(`\n📋 Direct AWS API data:`);
      console.log(`   resolvedSourceVersion: ${build.resolvedSourceVersion}`);
      console.log(`   artifacts.md5sum: ${build.artifacts?.md5sum}`);
      console.log(`   sourceVersion: ${build.sourceVersion}`);

      // Test what happens if we simulate the dashboard processing
      console.log(`\n🔬 Simulating dashboard processing:`);
      console.log(`   Original resolvedSourceVersion: ${build.resolvedSourceVersion}`);
      console.log(`   First 7 chars: ${build.resolvedSourceVersion?.substring(0, 7)}`);
      console.log(`   MD5 hash: ${build.artifacts?.md5sum}`);
      console.log(`   First 7 chars of MD5: ${build.artifacts?.md5sum?.substring(0, 7)}`);

      // Check if they match
      const gitCommit = build.resolvedSourceVersion?.substring(0, 7);
      const md5Short = build.artifacts?.md5sum?.substring(0, 7);

      console.log(`\n❗ Corruption check:`);
      console.log(`   Git commit (7 chars): ${gitCommit}`);
      console.log(`   MD5 hash (7 chars): ${md5Short}`);
      console.log(`   Are they different? ${gitCommit !== md5Short ? 'YES - this is correct' : 'NO - CORRUPTED'}`);

      if (gitCommit === md5Short) {
        console.log(`🚨 CORRUPTION DETECTED: resolvedSourceVersion contains MD5 hash instead of git commit!`);
      } else {
        console.log(`✅ No corruption detected in AWS API response`);
      }

    } else {
      console.log('❌ No build found');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

testCorruption();