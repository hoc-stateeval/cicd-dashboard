const { CodePipelineClient, GetPipelineExecutionCommand, ListPipelinesCommand } = require('@aws-sdk/client-codepipeline');
require('dotenv').config();

const codepipeline = new CodePipelineClient({ region: process.env.AWS_REGION || 'us-west-2' });

const investigatePipelineArtifacts = async () => {
  try {
    console.log('🔍 Investigating CodePipeline execution artifact information...');
    
    // First, get a pipeline
    const listCommand = new ListPipelinesCommand({});
    const pipelines = await codepipeline.send(listCommand);
    
    if (!pipelines.pipelines || pipelines.pipelines.length === 0) {
      console.log('No pipelines found');
      return;
    }
    
    // Find a frontend pipeline
    const frontendPipeline = pipelines.pipelines.find(p => 
      p.name.toLowerCase().includes('frontend') && p.name.toLowerCase().includes('sandbox')
    );
    
    if (!frontendPipeline) {
      console.log('No frontend sandbox pipeline found');
      return;
    }
    
    console.log(`\n📋 Examining pipeline: ${frontendPipeline.name}`);
    
    // Get the latest successful execution
    const { ListPipelineExecutionsCommand } = require('@aws-sdk/client-codepipeline');
    const listExecutionsCommand = new ListPipelineExecutionsCommand({
      pipelineName: frontendPipeline.name,
      maxResults: 5 // Get recent executions
    });
    
    const executions = await codepipeline.send(listExecutionsCommand);
    const anyExecution = executions.pipelineExecutions?.[0]; // Get the most recent execution
    
    if (!anyExecution) {
      console.log('No executions found');
      return;
    }
    
    console.log(`\n📋 Examining execution: ${anyExecution.pipelineExecutionId} (status: ${anyExecution.status})`);
    
    // Get detailed execution information
    const getExecutionCommand = new GetPipelineExecutionCommand({
      pipelineName: frontendPipeline.name,
      pipelineExecutionId: anyExecution.pipelineExecutionId
    });
    
    const executionDetails = await codepipeline.send(getExecutionCommand);
    
    console.log('\n=== FULL EXECUTION DETAILS ===');
    console.log(JSON.stringify(executionDetails, null, 2));
    
    console.log('\n=== ARTIFACT REVISIONS ===');
    if (executionDetails.pipelineExecution?.artifactRevisions) {
      executionDetails.pipelineExecution.artifactRevisions.forEach((revision, idx) => {
        console.log(`\nArtifact ${idx + 1}:`);
        console.log('  Name:', revision.name);
        console.log('  Revision ID:', revision.revisionId);
        console.log('  Revision Summary:', revision.revisionSummary);
        console.log('  Revision URL:', revision.revisionUrl);
        console.log('  Created:', revision.created);
      });
    } else {
      console.log('No artifact revisions found');
    }
    
  } catch (error) {
    console.error('Error investigating pipeline artifacts:', error);
  }
};

investigatePipelineArtifacts();