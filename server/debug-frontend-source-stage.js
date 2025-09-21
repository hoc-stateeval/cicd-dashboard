const { CodePipelineClient, GetPipelineCommand } = require('@aws-sdk/client-codepipeline');

async function testFrontendPipelineStage() {
  const codepipeline = new CodePipelineClient({ region: 'us-west-2' });
  const pipelineName = 'eval-frontend-sandbox';
  
  try {
    console.log(`🔍 Getting pipeline definition for ${pipelineName}...`);
    
    const getPipelineCommand = new GetPipelineCommand({
      name: pipelineName
    });
    
    const pipelineDefinition = await codepipeline.send(getPipelineCommand);
    
    console.log('📋 Pipeline definition received');
    console.log('📊 Number of stages:', pipelineDefinition.pipeline?.stages?.length);
    
    pipelineDefinition.pipeline?.stages?.forEach((stage, index) => {
      console.log(`📍 Stage ${index}: ${stage.name}`);
      stage.actions?.forEach((action, actionIndex) => {
        console.log(`  🔧 Action ${actionIndex}: ${action.name}`);
        console.log(`     Provider: ${action.actionTypeId?.provider}`);
        console.log(`     Category: ${action.actionTypeId?.category}`);
        if (action.configuration) {
          console.log(`     Configuration:`, JSON.stringify(action.configuration, null, 6));
        }
      });
    });
    
    // Test the specific frontend logic
    console.log('\n🔍 Testing frontend-specific logic:');
    if (pipelineName.toLowerCase().includes('frontend')) {
      console.log('✅ Pipeline name contains "frontend"');
      
      const sourceStage = pipelineDefinition.pipeline?.stages?.find(stage => stage.name === 'Source');
      console.log('📍 Source stage found:', sourceStage ? 'YES' : 'NO');
      
      if (sourceStage) {
        console.log('📊 Source stage actions:', sourceStage.actions?.length);
        
        const sourceAction = sourceStage?.actions?.find(action => action.actionTypeId?.provider === 'S3');
        console.log('🪣 S3 source action found:', sourceAction ? 'YES' : 'NO');
        
        if (sourceAction) {
          console.log('⚙️ S3 source action configuration:', JSON.stringify(sourceAction.configuration, null, 2));
          
          if (sourceAction?.configuration?.S3Bucket && sourceAction?.configuration?.S3ObjectKey) {
            console.log(`✅ Found frontend deployment bucket: ${sourceAction.configuration.S3Bucket}`);
            console.log(`✅ Found frontend object key: ${sourceAction.configuration.S3ObjectKey}`);
          } else {
            console.log('❌ S3Bucket or S3ObjectKey missing in configuration');
          }
        } else {
          console.log('❌ No S3 source action found');
          sourceStage.actions?.forEach((action, idx) => {
            console.log(`  Action ${idx}: ${action.name} (${action.actionTypeId?.provider})`);
          });
        }
      }
    } else {
      console.log('❌ Pipeline name does not contain "frontend"');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testFrontendPipelineStage().catch(console.error);