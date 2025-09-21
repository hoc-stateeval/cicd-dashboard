const { CodePipelineClient, GetPipelineExecutionCommand, ListPipelineExecutionsCommand } = require('@aws-sdk/client-codepipeline');

const codepipeline = new CodePipelineClient({ region: 'us-east-1' });

async function debugPipelineArtifacts() {
  console.log('🔍 Debugging Pipeline Artifacts - Sandbox vs Demo\n');
  
  // Get recent executions for both pipelines
  // First get all pipelines to find the correct names
  const { ListPipelinesCommand } = require('@aws-sdk/client-codepipeline');
  
  console.log('🔍 Getting all available pipelines...\n');
  const listPipelinesCommand = new ListPipelinesCommand({});
  const allPipelines = await codepipeline.send(listPipelinesCommand);
  
  console.log('📋 Available pipelines:');
  allPipelines.pipelines?.forEach(p => console.log(`   - ${p.name}`));
  
  // Filter for frontend pipelines in sandbox and demo
  const frontendPipelines = (allPipelines.pipelines || [])
    .filter(p => p.name.toLowerCase().includes('frontend'))
    .filter(p => p.name.toLowerCase().includes('sandbox') || p.name.toLowerCase().includes('demo'))
    .map(p => p.name);
    
  console.log('\n🎯 Selected frontend pipelines for comparison:', frontendPipelines);
  
  const pipelines = frontendPipelines;
  
  for (const pipelineName of pipelines) {
    console.log(`\n=== ${pipelineName.toUpperCase()} ===`);
    
    try {
      // Get recent executions
      const listCommand = new ListPipelineExecutionsCommand({
        pipelineName: pipelineName,
        maxResults: 5
      });
      
      const executions = await codepipeline.send(listCommand);
      console.log(`📋 Found ${executions.pipelineExecutionSummaries?.length || 0} recent executions:`);
      
      // Find the most recent successful StartPipelineExecution
      let selectedExecution = (executions.pipelineExecutionSummaries || [])
        .filter(exec => exec.status === 'Succeeded')
        .find(exec => exec.trigger?.triggerType === 'StartPipelineExecution');
        
      if (!selectedExecution) {
        selectedExecution = (executions.pipelineExecutionSummaries || [])
          .find(exec => exec.status === 'Succeeded');
      }
      
      if (!selectedExecution) {
        console.log('❌ No successful execution found');
        continue;
      }
      
      console.log(`🎯 Selected execution: ${selectedExecution.pipelineExecutionId}`);
      console.log(`   Status: ${selectedExecution.status}`);
      console.log(`   Trigger: ${selectedExecution.trigger?.triggerType || 'Unknown'}`);
      console.log(`   Time: ${selectedExecution.lastUpdateTime}`);
      
      // Get detailed execution information
      const detailCommand = new GetPipelineExecutionCommand({
        pipelineName: pipelineName,
        pipelineExecutionId: selectedExecution.pipelineExecutionId
      });
      
      const executionDetails = await codepipeline.send(detailCommand);
      console.log(`\n📦 Pipeline Execution Details:`);
      console.log(`   Execution ARN: ${executionDetails.pipelineExecution?.pipelineExecutionId}`);
      
      // Check artifact stores
      if (executionDetails.pipelineExecution?.artifactRevisions) {
        console.log(`\n🗃️  Artifact Revisions (${executionDetails.pipelineExecution.artifactRevisions.length}):`);
        executionDetails.pipelineExecution.artifactRevisions.forEach((artifact, idx) => {
          console.log(`   ${idx + 1}. Name: ${artifact.name}`);
          console.log(`      Revision ID: ${artifact.revisionId}`);
          console.log(`      Revision Summary: ${artifact.revisionSummary || 'N/A'}`);
          console.log(`      Created: ${artifact.created || 'N/A'}`);
          console.log(`      Revision URL: ${artifact.revisionUrl || 'N/A'}`);
          console.log('');
        });
      } else {
        console.log('   ❌ No artifact revisions found');
      }
      
      // Check if there are any variables or trigger details
      if (executionDetails.pipelineExecution?.trigger) {
        const trigger = executionDetails.pipelineExecution.trigger;
        console.log(`🎯 Trigger Details:`);
        console.log(`   Type: ${trigger.triggerType}`);
        console.log(`   Detail: ${trigger.triggerDetail || 'N/A'}`);
      }
      
    } catch (error) {
      console.error(`❌ Error analyzing ${pipelineName}:`, error.message);
    }
  }
}

debugPipelineArtifacts().catch(console.error);