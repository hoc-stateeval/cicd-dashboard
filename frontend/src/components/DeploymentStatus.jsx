import { Card, Row, Col, Badge } from 'react-bootstrap'
import { Clock, GitBranch, AlertTriangle } from 'lucide-react'
// Force reload to clear cache

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
                <h6 className="text-light mb-2">Currently Deployed:</h6>
                {deployment.currentDeployment?.backend || deployment.currentDeployment?.frontend ? (
                <Row>
                  {deployment.currentDeployment?.backend && (
                    <Col md={6}>
                      <div className="bg-secondary bg-opacity-25 p-3 rounded">
                        <div className="fw-bold">
                          <span className="text-info">Backend:</span>
                          {deployment.currentDeployment.backend.prNumber ? (
                            <>
                              <span className="text-white ms-2">PR#{deployment.currentDeployment.backend.prNumber}</span>
                              {(deployment.currentDeployment.backend.matchedBuild?.artifacts?.md5Hash || deployment.currentDeployment.backend.matchedBuild?.artifacts?.sha256Hash) && (
                                <span className="text-secondary ms-2 small">
                                  ({(deployment.currentDeployment.backend.matchedBuild.artifacts.md5Hash || deployment.currentDeployment.backend.matchedBuild.artifacts.sha256Hash).substring(0,7)})
                                </span>
                              )}
                              {deployment.currentDeployment.backend.buildTimestamp && (
                                <span className="text-white ms-2 small">
                                  {formatDateTime(deployment.currentDeployment.backend.buildTimestamp)}
                                </span>
                              )}
                            </>
                          ) : deployment.currentDeployment.backend.gitCommit ? (
                            <>
                              <span className="text-white ms-2">
                                ({deployment.currentDeployment.backend.gitCommit})
                              </span>
                              {(deployment.currentDeployment.backend.matchedBuild?.artifacts?.md5Hash || deployment.currentDeployment.backend.matchedBuild?.artifacts?.sha256Hash) && (
                                <span className="text-secondary ms-2 small">
                                  ({(deployment.currentDeployment.backend.matchedBuild.artifacts.md5Hash || deployment.currentDeployment.backend.matchedBuild.artifacts.sha256Hash).substring(0,7)})
                                </span>
                              )}
                              {deployment.currentDeployment.backend.buildTimestamp && (
                                <span className="text-white ms-2 small">
                                  {formatDateTime(deployment.currentDeployment.backend.buildTimestamp)}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-light ms-2">No build information available</span>
                          )}
                        </div>
                      </div>
                    </Col>
                  )}
                  {deployment.currentDeployment?.frontend && (
                    <Col md={6}>
                      <div className="bg-secondary bg-opacity-25 p-3 rounded">
                        <div className="fw-bold">
                          <span className="text-warning">Frontend:</span>
                          {deployment.currentDeployment.frontend.prNumber ? (
                            <>
                              <span className="text-white ms-2">PR#{deployment.currentDeployment.frontend.prNumber}</span>
                              {(deployment.currentDeployment.frontend.matchedBuild?.artifacts?.md5Hash || deployment.currentDeployment.frontend.matchedBuild?.artifacts?.sha256Hash) && (
                                <span className="text-secondary ms-2 small">
                                  ({(deployment.currentDeployment.frontend.matchedBuild.artifacts.md5Hash || deployment.currentDeployment.frontend.matchedBuild.artifacts.sha256Hash).substring(0,7)})
                                </span>
                              )}
                              {deployment.currentDeployment.frontend.buildTimestamp && (
                                <span className="text-white ms-2 small">
                                  {formatDateTime(deployment.currentDeployment.frontend.buildTimestamp)}
                                </span>
                              )}
                            </>
                          ) : deployment.currentDeployment.frontend.gitCommit ? (
                            <>
                              <span className="text-white ms-2">
                                ({deployment.currentDeployment.frontend.gitCommit})
                              </span>
                              {(deployment.currentDeployment.frontend.matchedBuild?.artifacts?.md5Hash || deployment.currentDeployment.frontend.matchedBuild?.artifacts?.sha256Hash) && (
                                <span className="text-secondary ms-2 small">
                                  ({(deployment.currentDeployment.frontend.matchedBuild.artifacts.md5Hash || deployment.currentDeployment.frontend.matchedBuild.artifacts.sha256Hash).substring(0,7)})
                                </span>
                              )}
                              {deployment.currentDeployment.frontend.buildTimestamp && (
                                <span className="text-white ms-2 small">
                                  {formatDateTime(deployment.currentDeployment.frontend.buildTimestamp)}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-light ms-2">No build information available</span>
                          )}
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
                              {update.prNumber ? `PR#${update.prNumber}` : 'main'} <span className="text-secondary small">({update.artifacts?.md5Hash?.substring(0,7) || update.artifacts?.sha256Hash?.substring(0,7) || update.gitCommit})</span>
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
                          <span className="text-warning">Frontend:</span>
                          {deployment.availableUpdates.frontend.map((update, idx) => (
                            <span key={idx} className="text-light ms-2">
                              {update.prNumber ? `PR#${update.prNumber}` : 'main'} <span className="text-secondary small">({update.artifacts?.md5Hash?.substring(0,7) || update.artifacts?.sha256Hash?.substring(0,7) || update.gitCommit})</span>
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