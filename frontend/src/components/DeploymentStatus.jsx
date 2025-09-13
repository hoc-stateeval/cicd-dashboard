import { Card, Row, Col, Badge, Button, Table } from 'react-bootstrap'
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

export default function DeploymentStatus({ deployments, prodBuildStatuses = {} }) {
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

  const handleDeployAll = async (deployment) => {
    try {
      console.log(`Deploying all updates for ${deployment.environment}...`)

      const backendUpdate = deployment.availableUpdates?.backend?.[0]
      const frontendUpdate = deployment.availableUpdates?.frontend?.[0]

      if (!backendUpdate || !frontendUpdate) {
        alert('Both frontend and backend updates are required for bulk deployment')
        return
      }

      // Deploy both components in parallel
      const deploymentPromises = []

      // Deploy backend
      deploymentPromises.push(
        fetch(`${import.meta.env.VITE_API_URL || '/api'}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            environment: deployment.environment,
            component: 'backend',
            buildInfo: backendUpdate
          })
        })
      )

      // Deploy frontend
      deploymentPromises.push(
        fetch(`${import.meta.env.VITE_API_URL || '/api'}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            environment: deployment.environment,
            component: 'frontend',
            buildInfo: frontendUpdate
          })
        })
      )

      const results = await Promise.all(deploymentPromises)

      // Check if all deployments succeeded
      const allSucceeded = results.every(response => response.ok)

      if (allSucceeded) {
        console.log(`All deployments to ${deployment.environment} completed successfully`)
        alert(`Successfully deployed both frontend and backend to ${deployment.environment}`)
      } else {
        console.error('Some deployments failed:', results)
        alert(`Some deployments to ${deployment.environment} failed. Check console for details.`)
      }

      // Refresh the page to show updated deployment status
      setTimeout(() => {
        window.location.reload()
      }, 2000)

    } catch (error) {
      console.error('Error deploying all updates:', error)
      alert(`Failed to deploy updates to ${deployment.environment}: ${error.message}`)
    }
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
          pipelineName: deployment.currentDeployment.frontend.pipelineName,
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

  const handleCoordinatedDeploy = async (deployment) => {
    try {
      const backendUpdate = deployment.availableUpdates?.backend?.[0]
      const frontendUpdate = deployment.availableUpdates?.frontend?.[0]

      if (!backendUpdate || !frontendUpdate) {
        alert('❌ Missing builds for coordinated deployment')
        return
      }

      const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/deploy-coordinated`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          environment: deployment.environment,
          backendBuildId: backendUpdate.buildId,
          frontendBuildId: frontendUpdate.buildId
        }),
      })

      const result = await response.json()

      if (response.ok) {
        alert(`✅ Successfully triggered coordinated deployment to ${deployment.environment}!\n\nDeployment ID: ${result.deploymentId}\nBackend: ${backendUpdate.buildId}\nFrontend: ${frontendUpdate.buildId}`)
      } else {
        alert(`❌ Failed to deploy coordinated: ${result.message}`)
      }
    } catch (error) {
      console.error('Coordinated deploy error:', error)
      alert('❌ Failed to deploy coordinated: Network error')
    }
  }

  const handleIndependentDeploy = async (deployment, componentType) => {
    try {
      const update = deployment.availableUpdates?.[componentType]?.[0]

      if (!update) {
        alert(`❌ No ${componentType} build available for deployment`)
        return
      }

      const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/deploy-independent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          environment: deployment.environment,
          buildId: update.buildId,
          componentType
        }),
      })

      const result = await response.json()

      if (response.ok) {
        alert(`✅ Successfully triggered independent ${componentType} deployment to ${deployment.environment}!\n\nDeployment ID: ${result.deployment.deploymentId}\nBuild ID: ${update.buildId}`)
      } else {
        alert(`❌ Failed to deploy ${componentType}: ${result.message}`)
      }
    } catch (error) {
      console.error(`Independent ${componentType} deploy error:`, error)
      alert(`❌ Failed to deploy ${componentType}: Network error`)
    }
  }

  const SmartDeploymentButtons = ({ deployment, component }) => {
    const coordination = deployment.deploymentCoordination

    if (!coordination) {
      // Fallback to simple deploy button if no coordination data
      return (
        <Button
          variant="outline-warning"
          size="sm"
          className="ms-3"
          onClick={() => handleDeployFrontend(deployment, deployment.availableUpdates.frontend[0])}
        >
          <Rocket size={14} className="me-1" />
          Deploy
        </Button>
      )
    }

    switch (coordination.state) {
      case 'BUILDS_OUT_OF_DATE':
        // For demo and sandbox environments, ignore "builds out of date" and show simple Deploy button
        if ((deployment.environment === 'demo' || deployment.environment === 'sandbox') && deployment.availableUpdates?.[component]?.length > 0) {
          const buttonVariant = component === 'backend' ? 'outline-info' : 'outline-warning'
          return (
            <Button
              variant={buttonVariant}
              size="sm"
              className="ms-3"
              onClick={() => handleIndependentDeploy(deployment, component)}
              title={`Deploy ${component} update`}
            >
              <Rocket size={14} className="me-1" />
              Deploy
            </Button>
          )
        }

        // For production with available updates but out of date, show disabled Deploy button
        if (deployment.environment === 'production' && deployment.availableUpdates?.[component]?.length > 0) {
          return (
            <Button
              variant="outline-secondary"
              size="sm"
              className="ms-3"
              disabled
              title={`Cannot deploy ${component}: ${coordination.reason}`}
            >
              <Rocket size={14} className="me-1" />
              Deploy (Blocked)
            </Button>
          )
        }

        // For other non-demo/sandbox environments, show "Build Required"
        return (
          <div className="ms-3 d-flex flex-column align-items-end">
            <Button variant="outline-secondary" size="sm" disabled title={coordination.reason}>
              <AlertTriangle size={14} className="me-1" />
              Build Required
            </Button>
            <small className="text-warning mt-1 text-end" style={{ fontSize: '0.75rem', maxWidth: '120px' }}>
              {coordination.reason}
            </small>
          </div>
        )

      case 'NO_UPDATES_AVAILABLE':
        return (
          <Button variant="outline-secondary" size="sm" className="ms-3" disabled title={coordination.reason}>
            <Clock size={14} className="me-1" />
            Up to Date
          </Button>
        )

      case 'BOTH_READY_COORDINATED':
        return (
          <div className="ms-3 d-flex flex-column align-items-end gap-1">
            <Button
              variant="warning"
              size="sm"
              onClick={() => handleCoordinatedDeploy(deployment)}
              title="Deploy both frontend and backend together (recommended)"
            >
              <Rocket size={14} className="me-1" />
              Deploy Both
            </Button>
            <div className="d-flex gap-1">
              <Button
                variant="outline-warning"
                size="sm"
                onClick={() => handleIndependentDeploy(deployment, 'backend')}
                title="Deploy only backend"
                style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              >
                Backend Only
              </Button>
              <Button
                variant="outline-warning"
                size="sm"
                onClick={() => handleIndependentDeploy(deployment, 'frontend')}
                title="Deploy only frontend"
                style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              >
                Frontend Only
              </Button>
            </div>
          </div>
        )

      case 'BOTH_READY_INDEPENDENT':
        return (
          <div className="ms-3 d-flex flex-column align-items-end gap-1">
            <Button
              variant="outline-warning"
              size="sm"
              onClick={() => handleCoordinatedDeploy(deployment)}
              title="Deploy both together"
            >
              <Rocket size={14} className="me-1" />
              Deploy Both
            </Button>
            <div className="d-flex gap-1">
              <Button
                variant="warning"
                size="sm"
                onClick={() => handleIndependentDeploy(deployment, 'backend')}
                title="Deploy backend independently (recommended)"
                style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              >
                Backend Only
              </Button>
              <Button
                variant="warning"
                size="sm"
                onClick={() => handleIndependentDeploy(deployment, 'frontend')}
                title="Deploy frontend independently (recommended)"
                style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              >
                Frontend Only
              </Button>
            </div>
          </div>
        )

      case 'BACKEND_ONLY_READY':
        return (
          <Button
            variant="warning"
            size="sm"
            className="ms-3"
            onClick={() => handleIndependentDeploy(deployment, 'backend')}
            title={coordination.reason}
          >
            <Rocket size={14} className="me-1" />
            Deploy Backend
          </Button>
        )

      case 'FRONTEND_ONLY_READY':
        return (
          <Button
            variant="warning"
            size="sm"
            className="ms-3"
            onClick={() => handleIndependentDeploy(deployment, 'frontend')}
            title={coordination.reason}
          >
            <Rocket size={14} className="me-1" />
            Deploy Frontend
          </Button>
        )

      default:
        return (
          <Button variant="outline-secondary" size="sm" className="ms-3" disabled title="Deployment state unknown">
            <AlertTriangle size={14} className="me-1" />
            Unknown State
          </Button>
        )
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
          <div key={deployment.environment} className={index > 0 ? 'mt-4' : ''}>
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

            {/* Deployment Table - only show if no error */}
            {!deployment.error && (
              <div>
                <div className="px-3 py-2 bg-secondary bg-opacity-25 d-flex justify-content-between align-items-center">
                  <h6 className="mb-0 text-light">
                    🚀 {deployment.environment.charAt(0).toUpperCase() + deployment.environment.slice(1)} Deployments
                  </h6>
                  {/* Deploy All button - only show when both frontend and backend have available updates */}
                  {deployment.availableUpdates?.backend?.length > 0 &&
                   deployment.availableUpdates?.frontend?.length > 0 && (
                    (() => {
                      const isProduction = deployment.environment === 'production'
                      const isOutOfDate = deployment.deploymentCoordination?.state === 'BUILDS_OUT_OF_DATE'
                      const isBlocked = isProduction && isOutOfDate

                      return (
                        <Button
                          size="sm"
                          variant={isBlocked ? "outline-secondary" : "outline-primary"}
                          onClick={isBlocked ? undefined : () => handleDeployAll(deployment)}
                          disabled={isBlocked}
                          title={isBlocked
                            ? `Cannot deploy: ${deployment.deploymentCoordination?.reason}`
                            : `Deploy both frontend and backend updates to ${deployment.environment}`}
                        >
                          <Rocket size={14} className="me-1" />
                          Deploy All{isBlocked ? ' (Blocked)' : ''}
                        </Button>
                      )
                    })()
                  )}
                </div>
                <Table variant="dark" striped bordered hover className="mb-0">
                  <thead>
                    <tr>
                      <th width="20%">Component</th>
                      <th width="40%">Currently Deployed</th>
                      <th width="40%">Available Updates</th>
                    </tr>
                  </thead>
                <tbody>
                  {/* Backend Row */}
                  <tr>
                    <td className="align-middle">
                      <span className="fw-bold text-info">Backend</span>
                    </td>
                    <td className="align-middle">
                      {deployment.currentDeployment?.backend ? (
                        <div>
                          <div className="fw-bold text-light">
                            {deployment.currentDeployment.backend.prNumber ? `PR#${deployment.currentDeployment.backend.prNumber}` : 'main'}
                            <span className="text-secondary small ms-2">({getHashDisplay(deployment.currentDeployment.backend.matchedBuild || deployment.currentDeployment.backend)})</span>
                          </div>
                          {deployment.currentDeployment.backend.buildTimestamp && (
                            <div className="small text-muted">
                              {formatDateTime(deployment.currentDeployment.backend.buildTimestamp)}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted">No deployment</span>
                      )}
                    </td>
                    <td className="align-middle">
                      {deployment.availableUpdates?.backend?.length > 0 ? (
                        <div className="d-flex justify-content-between align-items-center">
                          <div>
                            <div className="fw-bold text-light">
                              {deployment.availableUpdates.backend[0].prNumber ? `PR#${deployment.availableUpdates.backend[0].prNumber}` : 'main'}
                              <span className="text-secondary small ms-2">({getHashDisplay(deployment.availableUpdates.backend[0])})</span>
                              {(() => {
                                const isBackendDemoBuild = deployment.availableUpdates.backend[0].projectName?.includes('backend') && deployment.availableUpdates.backend[0].projectName?.includes('demo');
                                const isProdBuild = deployment.availableUpdates.backend[0].projectName?.includes('backend') && deployment.availableUpdates.backend[0].projectName?.includes('prod');
                                let isOutOfDate = false;

                                if (isProdBuild) {
                                  isOutOfDate = prodBuildStatuses['backend']?.needsBuild === true;
                                } else if (isBackendDemoBuild) {
                                  isOutOfDate = prodBuildStatuses['backend-demo']?.needsBuild === true;
                                }

                                return isOutOfDate ? (
                                  <Badge bg="warning" text="dark" className="ms-2" title="Production build is out of date - newer code available in sandbox">
                                    <AlertTriangle size={12} className="me-1" />
                                    Build Needed
                                  </Badge>
                                ) : null;
                              })()}
                            </div>
                            {deployment.availableUpdates.backend[0].buildTimestamp && (
                              <div className="small text-muted">
                                {formatDateTime(deployment.availableUpdates.backend[0].buildTimestamp)}
                              </div>
                            )}
                          </div>
                          <div className="ms-3">
                            <SmartDeploymentButtons deployment={deployment} component="backend" />
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted small">No updates available</span>
                      )}
                    </td>
                  </tr>

                  {/* Frontend Row */}
                  <tr>
                    <td className="align-middle">
                      <span className="fw-bold text-warning">Frontend</span>
                    </td>
                    <td className="align-middle">
                      {deployment.currentDeployment?.frontend ? (
                        <div>
                          <div className="fw-bold text-light">
                            {deployment.currentDeployment.frontend.prNumber ? `PR#${deployment.currentDeployment.frontend.prNumber}` : 'main'}
                            <span className="text-secondary small ms-2">({getHashDisplay(deployment.currentDeployment.frontend.matchedBuild || deployment.currentDeployment.frontend)})</span>
                          </div>
                          {deployment.currentDeployment.frontend.buildTimestamp && (
                            <div className="small text-muted">
                              {formatDateTime(deployment.currentDeployment.frontend.buildTimestamp)}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted">No deployment</span>
                      )}
                    </td>
                    <td className="align-middle">
                      {deployment.availableUpdates?.frontend?.length > 0 ? (
                        <div className="d-flex justify-content-between align-items-center">
                          <div>
                            <div className="fw-bold text-light">
                              {deployment.availableUpdates.frontend[0].prNumber ? `PR#${deployment.availableUpdates.frontend[0].prNumber}` : 'main'}
                              <span className="text-secondary small ms-2">({getHashDisplay(deployment.availableUpdates.frontend[0])})</span>
                              {(() => {
                                const isProdBuild = deployment.availableUpdates.frontend[0].projectName?.includes('frontend') && deployment.availableUpdates.frontend[0].projectName?.includes('prod');
                                const isOutOfDate = isProdBuild && prodBuildStatuses['frontend']?.needsBuild === true;

                                return isOutOfDate ? (
                                  <Badge bg="warning" text="dark" className="ms-2" title="Production build is out of date - newer code available in sandbox">
                                    <AlertTriangle size={12} className="me-1" />
                                    Build Needed
                                  </Badge>
                                ) : null;
                              })()}
                            </div>
                            {deployment.availableUpdates.frontend[0].buildTimestamp && (
                              <div className="small text-muted">
                                {formatDateTime(deployment.availableUpdates.frontend[0].buildTimestamp)}
                              </div>
                            )}
                          </div>
                          <div className="ms-3">
                            <SmartDeploymentButtons deployment={deployment} component="frontend" />
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted small">No updates available</span>
                      )}
                    </td>
                  </tr>
                </tbody>
                </Table>
              </div>
            )}
          </div>
        ))}
      </Card.Body>
    </Card>
  )
}