const { CodePipelineClient, GetPipelineCommand } = require('@aws-sdk/client-codepipeline');

const codepipeline = new CodePipelineClient({
  region: 'us-west-2'
});

async function debugFrontendPipeline() {
  try {
    console.log('🔍 Fetching frontend pipeline definition...');
    
    const getPipelineCommand = new GetPipelineCommand({
      name: 'eval-frontend-sandbox'
    });
    
    const pipelineDefinition = await codepipeline.send(getPipelineCommand);
    
    console.log('📋 Full pipeline definition:');
    console.log(JSON.stringify(pipelineDefinition, null, 2));
    
    // Look specifically at the stages
    console.log('\n🎯 Pipeline stages:');
    pipelineDefinition.pipeline.stages.forEach((stage, index) => {
      console.log(`\n  Stage ${index}: ${stage.name}`);
      stage.actions.forEach((action, actionIndex) => {
        console.log(`    Action ${actionIndex}: ${action.name} (${action.actionTypeId.provider})`);
        if (action.configuration) {
          console.log(`      Configuration:`, JSON.stringify(action.configuration, null, 8));
        }
      });
    });
    
  } catch (error) {
    console.error('❌ Error fetching pipeline definition:', error);
  }
}

debugFrontendPipeline();