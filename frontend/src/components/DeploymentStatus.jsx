import { Card, Row, Col, Badge } from 'react-bootstrap'
import { Clock, GitBranch, AlertTriangle } from 'lucide-react'

export default function DeploymentStatus({ deployments }) {
  if (!deployments || deployments.length === 0) {
    return (
      <Card bg="dark" border="secondary" text="white">
        <Card.Header>
          <Card.Title className="d-flex align-items-center mb-0">
            🎯 Main Deployment Targets
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
    if (!dateString) return 'Never'
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

  return (
    <Card bg="dark" border="secondary" text="white">
      <Card.Header>
        <Card.Title className="d-flex align-items-center mb-0">
          🎯 Main Deployment Targets
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

            {/* Current Build */}
            <div className="mb-3">
              <h6 className="text-light mb-2">Current Build:</h6>
              <Row>
                {deployment.currentDeployment?.backend && (
                  <Col md={6}>
                    <div className="bg-secondary bg-opacity-25 p-3 rounded">
                      <div className="fw-bold">
                        <span className="text-info">Backend:</span>
                        {deployment.currentDeployment.backend.prNumber || deployment.currentDeployment.backend.gitCommit ? (
                          <>
                            {deployment.currentDeployment.backend.prNumber && (
                              <span className="text-light ms-2">PR#{deployment.currentDeployment.backend.prNumber}</span>
                            )}
                            {deployment.currentDeployment.backend.gitCommit && (
                              <span className="text-light ms-2">
                                ({deployment.currentDeployment.backend.gitCommit})
                              </span>
                            )}
                            {deployment.currentDeployment.backend.buildTimestamp && (
                              <span className="text-light ms-2 small">
                                {formatDateTime(deployment.currentDeployment.backend.buildTimestamp)}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted ms-2">No build information available</span>
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
                        {deployment.currentDeployment.frontend.prNumber || deployment.currentDeployment.frontend.gitCommit ? (
                          <>
                            {deployment.currentDeployment.frontend.prNumber && (
                              <span className="text-light ms-2">PR#{deployment.currentDeployment.frontend.prNumber}</span>
                            )}
                            {deployment.currentDeployment.frontend.gitCommit && (
                              <span className="text-light ms-2">
                                ({deployment.currentDeployment.frontend.gitCommit})
                              </span>
                            )}
                            {deployment.currentDeployment.frontend.buildTimestamp && (
                              <span className="text-light ms-2 small">
                                {formatDateTime(deployment.currentDeployment.frontend.buildTimestamp)}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted ms-2">No build information available</span>
                        )}
                      </div>
                    </div>
                  </Col>
                )}
              </Row>
              {!deployment.currentDeployment?.backend && !deployment.currentDeployment?.frontend && (
                <div className="text-light-emphasis small">No current deployment information available</div>
              )}
            </div>

            {/* Available Updates */}
            <div>
              <h6 className="text-light mb-2 d-flex align-items-center">
                Available Updates:
                {(deployment.availableUpdates?.backend?.length > 0 || deployment.availableUpdates?.frontend?.length > 0) && (
                  <AlertTriangle size={16} className="ms-2 text-warning" />
                )}
              </h6>
              
              {(!deployment.availableUpdates?.backend?.length && !deployment.availableUpdates?.frontend?.length) ? (
                <div className="text-light-emphasis small">No updates available</div>
              ) : (
                <Row>
                  {deployment.availableUpdates?.backend?.length > 0 && (
                    <Col md={6}>
                      <div className="bg-secondary bg-opacity-25 p-3 rounded">
                        <div className="fw-bold">
                          <span className="text-info">Backend:</span>
                          {deployment.availableUpdates.backend.map((update, idx) => (
                            <span key={idx}>
                              {update.prNumber && (
                                <span className="text-light ms-2">PR#{update.prNumber}</span>
                              )}
                              {update.gitCommit && (
                                <span className="text-light ms-2">
                                  ({update.gitCommit})
                                </span>
                              )}
                              {update.buildTimestamp && (
                                <span className="text-light ms-2 small">
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
                    <Col md={6}>
                      <div className="bg-secondary bg-opacity-25 p-3 rounded">
                        <div className="fw-bold">
                          <span className="text-warning">Frontend:</span>
                          {deployment.availableUpdates.frontend.map((update, idx) => (
                            <span key={idx}>
                              {update.prNumber && (
                                <span className="text-light ms-2">PR#{update.prNumber}</span>
                              )}
                              {update.gitCommit && (
                                <span className="text-light ms-2">
                                  ({update.gitCommit})
                                </span>
                              )}
                              {update.buildTimestamp && (
                                <span className="text-light ms-2 small">
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
              )}
            </div>
          </div>
        ))}
      </Card.Body>
    </Card>
  )
}