import { Card, Table, Alert } from 'react-bootstrap'
import BuildRow from './BuildRow'

// Helper function to detect PR number inconsistencies for the same component type
function detectPRInconsistencies(builds) {
  if (!builds?.length) return []
  
  const inconsistencies = []
  const componentGroups = {}
  
  // Group builds by component type (backend/frontend) and environment (demo/sandbox)
  builds.forEach(build => {
    if (!build.prNumber) return
    
    const componentType = build.projectName.includes('backend') ? 'backend' : 
                         build.projectName.includes('frontend') ? 'frontend' : 'other'
    const environment = build.projectName.includes('demo') ? 'demo' : 
                       build.projectName.includes('sandbox') ? 'sandbox' : 'other'
    
    if (componentType !== 'other' && environment !== 'other') {
      const key = `${componentType}-${environment}`
      if (!componentGroups[key]) {
        componentGroups[key] = []
      }
      componentGroups[key].push(build)
    }
  })
  
  // Check for inconsistencies for each unique component type
  const checkedComponents = new Set()
  
  Object.entries(componentGroups).forEach(([key, groupBuilds]) => {
    const [componentType] = key.split('-')
    
    // Skip if we've already checked this component type
    if (checkedComponents.has(componentType)) return
    checkedComponents.add(componentType)
    
    // Get all PR numbers for this component type across demo and sandbox
    const demoBuilds = componentGroups[`${componentType}-demo`] || []
    const sandboxBuilds = componentGroups[`${componentType}-sandbox`] || []
    
    if (demoBuilds.length > 0 && sandboxBuilds.length > 0) {
      // Check if the most recent successful builds have different PR numbers
      const latestDemo = demoBuilds
        .filter(b => b.status === 'SUCCEEDED' || b.status === 'SUCCESS')
        .sort((a, b) => new Date((b.endTime || b.startTime)) - new Date((a.endTime || a.startTime)))[0]
      
      const latestSandbox = sandboxBuilds
        .filter(b => b.status === 'SUCCEEDED' || b.status === 'SUCCESS')
        .sort((a, b) => new Date((b.endTime || b.startTime)) - new Date((a.endTime || a.startTime)))[0]
      
      if (latestDemo && latestSandbox && latestDemo.prNumber !== latestSandbox.prNumber) {
        inconsistencies.push({
          componentType,
          demoPR: latestDemo.prNumber,
          sandboxPR: latestSandbox.prNumber,
          demoProject: latestDemo.projectName,
          sandboxProject: latestSandbox.projectName
        })
      }
    }
  })
  
  return inconsistencies
}

export default function BuildSection({ title, builds, emptyMessage, allBuilds, onTriggerProdBuilds }) {
  const inconsistencies = detectPRInconsistencies(builds)
  return (
    <Card bg="dark" border="secondary" text="white">
      <Card.Header className="bg-primary bg-opacity-15">
        <Card.Title className="d-flex align-items-center mb-0">
          {title}
          <span className="text-muted ms-2 fw-normal small">
            ({builds?.length || 0})
          </span>
        </Card.Title>
      </Card.Header>
      
      {/* PR Inconsistency Error */}
      {inconsistencies.length > 0 && (
        <Alert variant="danger" className="m-3 mb-0">
          <Alert.Heading className="h6 mb-2">🚨 PR Number Inconsistency Error</Alert.Heading>
          <div className="small">
            {inconsistencies.map((issue, index) => (
              <div key={index} className="mb-1">
                <strong>{issue.componentType.toUpperCase()}</strong> components have mismatched PR numbers: {' '}
                <code>{issue.demoProject}</code> uses PR#{issue.demoPR}, while {' '}
                <code>{issue.sandboxProject}</code> uses PR#{issue.sandboxPR}
              </div>
            ))}
            <div className="mt-2">
              <strong>Action Required:</strong> Related builds must use the same PR number to ensure consistency across environments. 
              This indicates a potential issue with your automated build triggers.
            </div>
          </div>
        </Alert>
      )}
      
      <Card.Body className="p-0">
        {!builds?.length ? (
          <div className="text-center py-5 text-muted">
            {emptyMessage}
          </div>
        ) : (
          <Table variant="dark" striped bordered hover className="mb-0">
            <thead>
              <tr>
                <th style={{ width: '20%' }}>Project</th>
                <th style={{ width: '10%' }}>Status</th>
                <th className="text-center" style={{ width: '12%' }}>Source → Target</th>
                <th className="text-center" style={{ width: '8%' }}>PR #</th>
                <th style={{ width: '10%' }}>Run Mode</th>
                <th style={{ width: '8%' }}>Duration</th>
                <th style={{ width: '17%' }}>Completed</th>
                <th style={{ width: '15%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {builds.map((build) => (
                <BuildRow 
                  key={build.buildId} 
                  build={build} 
                  allBuilds={allBuilds}
                  onTriggerProdBuilds={onTriggerProdBuilds}
                />
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>
    </Card>
  )
}