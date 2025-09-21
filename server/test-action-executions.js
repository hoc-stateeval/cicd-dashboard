const { CodePipelineClient, GetPipelineExecutionCommand, ListActionExecutionsCommand } = require('@aws-sdk/client-codepipeline');

const codepipeline = new CodePipelineClient({ region: 'us-east-1' });

async function testActionExecutions() {
  console.log('🔍 Testing Action Executions to find S3 Object URLs\n');
  
  // First list all pipelines to find the correct names
  const { ListPipelinesCommand } = require('@aws-sdk/client-codepipeline');
  const listPipelinesCommand = new ListPipelinesCommand({});
  const allPipelines = await codepipeline.send(listPipelinesCommand);
  
  console.log('📋 Available pipelines:');
  allPipelines.pipelines?.forEach(p => console.log(`   - ${p.name}`));
  
  // Use any pipeline from the list that we have debug files for
  const availablePipelines = (allPipelines.pipelines || []).map(p => p.name);
  
  if (availablePipelines.length === 0) {
    console.log('❌ No pipelines found');
    return;
  }
  
  // Look for a pipeline that matches our debug files
  const debugPipelines = ['eval-backend-sandbox', 'eval-frontend-sandbox', 'eval-frontend-demo', 'eval-frontend-prod'];
  let pipelineName = null;
  
  for (const debugPipeline of debugPipelines) {
    if (availablePipelines.find(p => p === debugPipeline)) {
      pipelineName = debugPipeline;
      break;
    }
  }
  
  if (!pipelineName) {
    console.log('❌ No matching pipeline found in available pipelines');
    return;
  }
  
  // Use appropriate execution ID based on pipeline
  let pipelineExecutionId;
  if (pipelineName === 'eval-backend-sandbox') {
    pipelineExecutionId = '8205d1f1-7148-4a5d-a840-050b10fd2312';
  } else if (pipelineName === 'eval-frontend-sandbox') {
    pipelineExecutionId = '2afea30a-da9d-45f4-96cf-dbe355f91893';
  } else if (pipelineName === 'eval-frontend-demo') {
    pipelineExecutionId = '2949ee92-0b7a-4b5d-bedf-eb8a16ff94f6';
  } else if (pipelineName === 'eval-frontend-prod') {
    pipelineExecutionId = '44d6087b-d5c4-422e-b0fc-5ec62a30d44d';
  } else {
    console.log('❌ No execution ID mapping for pipeline:', pipelineName);
    return;
  }
  
  console.log(`\nSelected Pipeline: ${pipelineName}`);
  console.log(`Execution ID: ${pipelineExecutionId}\n`);
  
  try {
    // Get action executions for this pipeline execution
    const listActionsCommand = new ListActionExecutionsCommand({
      pipelineName: pipelineName,
      filter: {
        pipelineExecutionId: pipelineExecutionId
      }
    });
    
    const actionExecutions = await codepipeline.send(listActionsCommand);
    console.log(`📋 Found ${actionExecutions.actionExecutionDetails?.length || 0} action executions:`);
    
    (actionExecutions.actionExecutionDetails || []).forEach((action, idx) => {
      console.log(`\n${idx + 1}. Action: ${action.actionName}`);
      console.log(`   Stage: ${action.stageName}`);
      console.log(`   Status: ${action.status}`);
      console.log(`   Type: ${action.actionExecutionId}`);
      
      if (action.output) {
        console.log(`   🎯 OUTPUT:`);
        if (action.output.outputArtifacts) {
          console.log(`   📦 Output Artifacts (${action.output.outputArtifacts.length}):`);
          action.output.outputArtifacts.forEach((artifact, artifactIdx) => {
            console.log(`      ${artifactIdx + 1}. Name: ${artifact.name}`);
            console.log(`         S3 Location: ${artifact.s3location?.bucketName}/${artifact.s3location?.objectKey || 'N/A'}`);
            console.log(`         Version ID: ${artifact.s3location?.versionId || 'N/A'}`);
            if (artifact.s3location) {
              console.log(`         🎯 FULL S3 URL: s3://${artifact.s3location.bucketName}/${artifact.s3location.objectKey}?versionId=${artifact.s3location.versionId}`);
            }
          });
        }
        if (action.output.outputVariables) {
          console.log(`   📝 Output Variables:`, action.output.outputVariables);
        }
      }
      
      if (action.input) {
        console.log(`   📥 INPUT:`);
        if (action.input.inputArtifacts) {
          console.log(`   📦 Input Artifacts (${action.input.inputArtifacts.length}):`);
          action.input.inputArtifacts.forEach((artifact, artifactIdx) => {
            console.log(`      ${artifactIdx + 1}. Name: ${artifact.name}`);
            console.log(`         S3 Location: ${artifact.s3location?.bucketName}/${artifact.s3location?.objectKey || 'N/A'}`);
            console.log(`         Version ID: ${artifact.s3location?.versionId || 'N/A'}`);
          });
        }
      }
    });
    
  } catch (error) {
    console.error(`❌ Error:`, error.message);
  }
}

testActionExecutions().catch(console.error);