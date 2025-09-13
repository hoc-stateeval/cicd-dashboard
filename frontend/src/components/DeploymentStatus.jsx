import { Card, Row, Col, Badge, Button } from 'react-bootstrap'
import { Clock, GitBranch, AlertTriangle, Rocket } from 'lucide-react'
// Force reload to clear cache

const getHashDisplay = (build) => {
  // Prioritize git commit for deployment correlation, then fall back to artifact hashes
  if (build?.gitCommit) {
    return build.gitCommit.substring(0, 7)
  }
  if (build?.artifacts?.sha256Hash) {
    return build.artifacts.sha256Hash.substring(0, 8)
  }
  if (build?.artifacts?.md5Hash) {
    return build.artifacts.md5Hash.substring(0, 8)
  }
  return '--'
}

export default function DeploymentStatus({ deployments }) {
  if (!deployments || deployments.length === 0) {
    return (
      <Card bg="dark" border="secondary" text="white">
        <Card.Header className="bg-primary bg-opacity-15">
          <Card.Title className="d-flex align-items-center mb-0">
            🎯 Code Pipeline Deployment Targets
          </Card.Title>
        </Card.Header>
        <Card.Body>
          <div className="text-center py-4 text-muted">
            No deployment status available
          </div>
        </Card.Body>
      </Card>
    )
  }

  const formatDateTime = (dateString) => {
    if (!dateString) return 'No verified deployments'
    return new Date(dateString).toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    })
  }

  const getEnvironmentBadgeColor = (env) => {
    switch (env.toLowerCase()) {
      case 'sandbox': return 'info'
      case 'demo': return 'warning'
      case 'production': return 'danger'
      default: return 'secondary'
    }
  }

  const handleDeployFrontend = async (deployment, update) => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/deploy-frontend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          environment: deployment.environment,
          buildId: update.buildId
        }),
      })

      const result = await response.json()
      
      if (response.ok) {
        alert(`✅ Successfully triggered frontend deployment to ${deployment.environment}!\n\nPipeline: ${result.deployment.pipelineName}\nExecution ID: ${result.deployment.pipelineExecutionId}`)
      } else {
        alert(`❌ Failed to deploy frontend: ${result.message}`)
      }
    } catch (error) {
      console.error('Deploy error:', error)
      alert('❌ Failed to deploy frontend: Network error')
    }
  }

  const getUpdateStatusInfo = (deployment, componentType = 'backend', hasUpdatesForComponent = false) => {
    const environment = deployment.environment.toLowerCase()
    const hasCurrentDeployment = deployment.currentDeployment?.backend || deployment.currentDeployment?.frontend
    
    if (!hasCurrentDeployment) {
      return {
        title: 'Available for Deployment:',
        message: 'No builds available for deployment',
        textClass: 'text-light-emphasis',
        showUpdates: false
      }
    }
    
    // When updates are available for this specific component
    if (hasUpdatesForComponent) {
      return {
        title: `Newer ${componentType.charAt(0).toUpperCase() + componentType.slice(1)} Build Available`,
        showUpdates: true
      }
    }
    
    // No updates available for this component
    const textClass = environment === 'sandbox' ? 'text-secondary' : 'text-light-emphasis'
    return {
      title: `Newer ${componentType.charAt(0).toUpperCase() + componentType.slice(1)} Build Available:`,
      message: 'No newer builds available',
      textClass,
      showUpdates: false
    }
  }

  return (
    <Card bg="dark" border="secondary" text="white">
      <Card.Header className="bg-primary bg-opacity-15">
        <Card.Title className="d-flex align-items-center mb-0">
          🎯 Code Pipeline Deployment Targets
        </Card.Title>
      </Card.Header>
      
      {/* Hash explanation for deployment status */}
      <div className="px-3 py-2 small" style={{ backgroundColor: 'rgba(255,255,255,0.1)', borderBottom: '1px solid rgba(255,255,255,0.2)', color: '#e9ecef' }}>
        <strong style={{ color: '#f8f9fa' }}>Hash values:</strong> Git commit (7 chars) - primary method for deployment correlation via S3 version IDs
      </div>
      
      <Card.Body>
        {deployments.map((deployment, index) => (
          <div key={deployment.environment} className={index > 0 ? 'mt-4 pt-4 border-top border-secondary' : ''}>
            {/* Environment Header */}
            <div className="d-flex align-items-center mb-3">
              <Badge bg={getEnvironmentBadgeColor(deployment.environment)} className="me-3 px-3 py-2">
                {deployment.environment.toUpperCase()}
              </Badge>
              <div className="text-muted small">
                <Clock size={14} className="me-1" />
                Last Deployed: {formatDateTime(deployment.lastDeployedAt)}
              </div>
            </div>
            
            {/* Show error message if rate limiting detected */}
            {deployment.error && (
              <div className="alert alert-warning" role="alert">
                <div className="d-flex align-items-center">
                  <AlertTriangle size={16} className="me-2" />
                  <strong>Deployment Status Unavailable</strong>
                </div>
                <div className="mt-2 small">{deployment.error}</div>
              </div>
            )}

            {/* Current Build - only show if no error */}
            {!deployment.error && (
              <div className="mb-3">
                {deployment.currentDeployment?.backend || deployment.currentDeployment?.frontend ? (
                <Row>
                  {deployment.currentDeployment?.backend && (
                    <Col md={6}>
                      <h6 className="text-light mb-2">Currently Deployed Backend:</h6>
                      <div className="bg-secondary bg-opacity-25 p-3 rounded">
                        <div className="fw-bold">
                          <span className="text-info">Backend:</span>
                          <span className="text-light ms-2">
                            {deployment.currentDeployment.backend.prNumber ? `PR#${deployment.currentDeployment.backend.prNumber}` : 'main'} <span className="text-secondary small">({getHashDisplay(deployment.currentDeployment.backend.matchedBuild || deployment.currentDeployment.backend)})</span>
                            {deployment.currentDeployment.backend.buildTimestamp && (
                              <span className="ms-2 small">
                                {formatDateTime(deployment.currentDeployment.backend.buildTimestamp)}
                              </span>
                            )}
                          </span>
                        </div>
                      </div>
                    </Col>
                  )}
                  {deployment.currentDeployment?.frontend && (
                    <Col md={6}>
                      <h6 className="text-light mb-2">Currently Deployed Frontend:</h6>
                      <div className="bg-secondary bg-opacity-25 p-3 rounded">
                        <div className="fw-bold">
                          <span className="text-warning">Frontend:</span>
                          <span className="text-light ms-2">
                            {deployment.currentDeployment.frontend.prNumber ? `PR#${deployment.currentDeployment.frontend.prNumber}` : 'main'} <span className="text-secondary small">({getHashDisplay(deployment.currentDeployment.frontend.matchedBuild || deployment.currentDeployment.frontend)})</span>
                            {deployment.currentDeployment.frontend.buildTimestamp && (
                              <span className="ms-2 small">
                                {formatDateTime(deployment.currentDeployment.frontend.buildTimestamp)}
                              </span>
                            )}
                          </span>
                        </div>
                      </div>
                    </Col>
                  )}
                </Row>
              ) : (
                <div className="bg-secondary bg-opacity-25 p-3 rounded text-center">
                  <div className="text-muted">
                    <span className="fw-bold">No Current Deployment</span>
                    <div className="small mt-1">No verified deployments to this environment</div>
                  </div>
                </div>
              )}
              </div>
            )}

            {/* Available Updates - only show if no error */}
            {!deployment.error && (
              <div>
                {(() => {
                  const backendUpdateInfo = getUpdateStatusInfo(deployment, 'backend', deployment.availableUpdates?.backend?.length > 0)
                  const frontendUpdateInfo = getUpdateStatusInfo(deployment, 'frontend', deployment.availableUpdates?.frontend?.length > 0)
                  
                  // If no available updates for either component, show both "no updates" sections
                  if (!deployment.availableUpdates?.backend?.length && !deployment.availableUpdates?.frontend?.length) {
                    return (
                      <Row>
                        <Col md={6}>
                          <h6 className="text-light mb-2">
                            {backendUpdateInfo.title}
                          </h6>
                          <div className={`small ${backendUpdateInfo.textClass}`}>
                            {backendUpdateInfo.message}
                          </div>
                        </Col>
                        <Col md={6}>
                          <h6 className="text-light mb-2">
                            {frontendUpdateInfo.title}
                          </h6>
                          <div className={`small ${frontendUpdateInfo.textClass}`}>
                            {frontendUpdateInfo.message}
                          </div>
                        </Col>
                      </Row>
                    )
                  }
                  
                  // If there are available updates, show the sections
                  return (
                <Row>
                  {deployment.availableUpdates?.backend?.length > 0 && (
                    <Col md={6}>
                      <h6 className="text-light mb-2 d-flex align-items-center">
                        {getUpdateStatusInfo(deployment, 'backend', true).title}
                        <AlertTriangle size={16} className="ms-2 text-warning" />
                      </h6>
                      <div className="bg-secondary bg-opacity-25 p-3 rounded">
                        <div className="fw-bold">
                          <span className="text-info">Backend:</span>
                          {deployment.availableUpdates.backend.map((update, idx) => (
                            <span key={idx} className="text-light ms-2">
                              {update.prNumber ? `PR#${update.prNumber}` : 'main'} <span className="text-secondary small">({getHashDisplay(update)})</span>
                              {update.buildTimestamp && (
                                <span className="ms-2 small">
                                  {formatDateTime(update.buildTimestamp)}
                                </span>
                              )}
                            </span>
                          ))}
                        </div>
                      </div>
                    </Col>
                  )}
                  {deployment.availableUpdates?.frontend?.length > 0 && (
                    <Col md={6} className={deployment.availableUpdates?.backend?.length === 0 ? "offset-md-6" : ""}>
                      <h6 className="text-light mb-2 d-flex align-items-center">
                        {frontendUpdateInfo.title}
                        <AlertTriangle size={16} className="ms-2 text-warning" />
                      </h6>
                      <div className="bg-secondary bg-opacity-25 p-3 rounded">
                        <div className="fw-bold">
                          {deployment.availableUpdates.frontend.map((update, idx) => (
                            <div key={idx} className="d-flex justify-content-between align-items-center">
                              <span className="text-light">
                                <span className="text-warning">Frontend:</span>
                                <span className="ms-2">
                                  {update.prNumber ? `PR#${update.prNumber}` : 'main'} <span className="text-secondary small">({getHashDisplay(update)})</span>
                                  {update.buildTimestamp && (
                                    <span className="ms-2 small">
                                      {formatDateTime(update.buildTimestamp)}
                                    </span>
                                  )}
                                </span>
                              </span>
                              <Button
                                variant="outline-warning"
                                size="sm"
                                className="ms-3"
                                onClick={() => handleDeployFrontend(deployment, update)}
                              >
                                <Rocket size={14} className="me-1" />
                                Deploy
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </Col>
                  )}
                </Row>
                  )
                })()}
              </div>
            )}
          </div>
        ))}
      </Card.Body>
    </Card>
  )
}