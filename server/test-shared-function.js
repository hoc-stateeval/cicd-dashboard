require('dotenv').config();
const { CodePipelineClient, GetPipelineCommand } = require('@aws-sdk/client-codepipeline');

const codepipeline = new CodePipelineClient({ region: process.env.AWS_REGION || 'us-west-2' });

// Shared function to get S3 artifact configuration for any pipeline
const getS3ArtifactConfig = async (pipelineName, codepipelineClient) => {
  try {
    console.log(`        🔍 Getting pipeline definition for S3 artifact discovery...`);
    
    // Get the pipeline definition to find the correct S3 configuration
    const getPipelineCommand = new GetPipelineCommand({
      name: pipelineName
    });
    
    const pipelineDefinition = await codepipelineClient.send(getPipelineCommand);
    
    if (pipelineName.toLowerCase().includes('frontend')) {
      // For frontend pipelines, deployment artifacts are in the Source stage S3 configuration
      const sourceStage = pipelineDefinition.pipeline?.stages?.find(stage => stage.name === 'Source');
      const sourceAction = sourceStage?.actions?.find(action => action.actionTypeId?.provider === 'S3');
      
      if (sourceAction?.configuration?.S3Bucket && sourceAction?.configuration?.S3ObjectKey) {
        const bucketName = sourceAction.configuration.S3Bucket;
        const objectKey = sourceAction.configuration.S3ObjectKey;
        console.log(`        ✅ Found frontend deployment bucket from Source stage: ${bucketName}`);
        console.log(`        🗂️  Found frontend object key from Source stage: ${objectKey}`);
        return { bucketName, objectKey };
      } else {
        console.log(`        ❌ Could not find S3 source configuration in frontend pipeline definition`);
        return { bucketName: null, objectKey: null };
      }
    } else {
      // For backend pipelines, use artifact store configuration (existing working approach)
      const artifactStore = pipelineDefinition.pipeline?.artifactStore;
      if (artifactStore && artifactStore.type === 'S3' && artifactStore.location) {
        const bucketName = artifactStore.location;
        console.log(`        ✅ Found backend S3 bucket from artifact store: ${bucketName}`);
        
        // Determine object key based on pipeline name for backend
        let objectKey = null;
        if (pipelineName.toLowerCase().includes('sandbox')) {
          objectKey = 'eval-backend-sandbox';
        } else if (pipelineName.toLowerCase().includes('demo')) {
          objectKey = 'eval-backend-demo';
        } else if (pipelineName.toLowerCase().includes('prod')) {
          objectKey = 'eval-backend-prod';
        }
        
        console.log(`        🗂️  Determined backend object key: ${objectKey}`);
        return { bucketName, objectKey };
      } else {
        console.log(`        ❌ Could not find S3 artifact store in backend pipeline definition`);
        return { bucketName: null, objectKey: null };
      }
    }
  } catch (error) {
    console.log(`        ❌ Error getting pipeline definition: ${error.message}`);
    console.log(`        🚫 Cannot determine S3 bucket without pipeline definition - skipping`);
    return { bucketName: null, objectKey: null };
  }
};

async function testFunction() {
  console.log('Testing shared S3 artifact config function...\n');
  
  console.log('🧪 Testing frontend sandbox pipeline:');
  const frontendResult = await getS3ArtifactConfig('eval-frontend-sandbox', codepipeline);
  console.log('Result:', frontendResult);
  
  console.log('\n🧪 Testing backend sandbox pipeline:');
  const backendResult = await getS3ArtifactConfig('eval-backend-sandbox', codepipeline);
  console.log('Result:', backendResult);
  
  console.log('\n✅ Test completed');
  process.exit(0);
}

testFunction().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});