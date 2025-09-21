const { CodePipelineClient, GetPipelineCommand } = require('@aws-sdk/client-codepipeline');

const codepipeline = new CodePipelineClient({
  region: 'us-west-2'
});

async function testDynamicDiscovery() {
  const pipelineName = 'eval-frontend-sandbox';
  
  try {
    console.log(`🔍 Testing dynamic S3 bucket discovery for ${pipelineName}...`);
    
    // Get the pipeline definition to find the correct S3 bucket configuration
    const getPipelineCommand = new GetPipelineCommand({
      name: pipelineName
    });
    
    const pipelineDefinition = await codepipeline.send(getPipelineCommand);
    
    if (pipelineName.toLowerCase().includes('frontend')) {
      console.log('📍 Frontend pipeline detected - looking for Source stage S3 configuration...');
      
      // For frontend pipelines, get bucket from Source stage S3 configuration
      const sourceStage = pipelineDefinition.pipeline?.stages?.find(stage => stage.name === 'Source');
      const sourceAction = sourceStage?.actions?.find(action => action.actionTypeId?.provider === 'S3');
      
      if (sourceAction?.configuration?.S3Bucket && sourceAction?.configuration?.S3ObjectKey) {
        const bucketName = sourceAction.configuration.S3Bucket;
        const objectKey = sourceAction.configuration.S3ObjectKey;
        console.log(`✅ Found frontend deployment bucket from Source stage: ${bucketName}`);
        console.log(`🗂️  Found frontend object key from Source stage: ${objectKey}`);
        console.log(`🪣 Complete S3 path: s3://${bucketName}/${objectKey}`);
      } else {
        console.log(`❌ Could not find S3 source configuration in frontend pipeline definition`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

testDynamicDiscovery();