import { useState, useEffect } from 'react'
import { Card, Row, Col, Badge, Button, Table, Spinner, OverlayTrigger, Tooltip } from 'react-bootstrap'
import { Clock, GitBranch, AlertTriangle, Rocket, XCircle } from 'lucide-react'
import BuildDisplay from './BuildDisplay'
// Force reload to clear cache - v2 with debug logs

const formatDeploymentTooltip = (deployment, componentType) => {
  if (!deployment) return null

  const deployedAt = deployment.deployedAt ? new Date(deployment.deployedAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }) : 'Unknown'

  const buildTimestamp = deployment.buildTimestamp ? new Date(deployment.buildTimestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }) : 'Unknown'

  const matchedBuild = deployment.matchedBuild || {}
  const commitAuthor = matchedBuild.commitAuthor || 'Unknown'
  const commitMessage = matchedBuild.commitMessage ? matchedBuild.commitMessage.split('\n')[0] : 'Not available'

  return (
    <div className="text-start">
      <div><strong>{componentType}:</strong> {formatBuildSource(deployment)}</div>
      <div><strong>Commit:</strong> {deployment.gitCommit || '?'}</div>
      <div><strong>Author:</strong> {commitAuthor}</div>
      <div><strong>Message:</strong> {commitMessage}</div>
      <div><strong>Built:</strong> {buildTimestamp}</div>
      <div><strong>Deployed:</strong> {deployedAt}</div>
      <div className="text-muted small">Currently deployed</div>
    </div>
  )
}

const formatAvailableUpdateTooltip = (build, componentType) => {
  if (!build) return null

  const buildTimestamp = build.buildTimestamp ? new Date(build.buildTimestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }) : 'Unknown'

  const commitAuthor = build.commitAuthor || 'Unknown'
  const commitMessage = build.commitMessage ? build.commitMessage.split('\n')[0] : 'Not available'

  return (
    <div className="text-start">
      <div><strong>{componentType}:</strong> {formatBuildSource(build)}</div>
      <div><strong>Commit:</strong> {build.gitCommit || '?'}</div>
      <div><strong>Author:</strong> {commitAuthor}</div>
      <div><strong>Message:</strong> {commitMessage}</div>
      <div><strong>Built:</strong> {buildTimestamp}</div>
      <div className="text-muted small">Available for deployment</div>
    </div>
  )
}

export default function DeploymentStatus({ deployments, prodBuildStatuses = {} }) {
  // Track deployment progress state
  const [deploymentInProgress, setDeploymentInProgress] = useState(new Set())
  // Track deployment failures by build ID: Map<deploymentKey, {buildId, timestamp}>
  const [deploymentFailures, setDeploymentFailures] = useState(new Map())
  // Track recently completed successful deployments to prevent double-clicks
  const [recentlyCompleted, setRecentlyCompleted] = useState(new Set())
  // Track which specific deployment action is running: Map<deploymentKey, actionType>
  const [runningActions, setRunningActions] = useState(new Map())

  // Clear runningActions when deployments complete
  useEffect(() => {
    runningActions.forEach((actionType, deploymentKey) => {
      if (!deploymentInProgress.has(deploymentKey) && !recentlyCompleted.has(deploymentKey)) {
        setRunningActions(prev => {
          const newMap = new Map(prev)
          newMap.delete(deploymentKey)
          return newMap
        })
      }
    })
  }, [deploymentInProgress, recentlyCompleted, runningActions])

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
    const deploymentKey = `${deployment.environment}-all`

    try {
      // Mark specific action as running and deployment as in progress
      setRunningActions(prev => new Map([...prev, [deploymentKey, 'deploy-all']]))
      setDeploymentInProgress(prev => new Set([...prev, deploymentKey]))
      setRecentlyCompleted(prev => {
        const newSet = new Set(prev)
        newSet.delete(deploymentKey)
        return newSet
      })

      console.log(`Deploying all updates for ${deployment.environment}...`)

      const backendUpdate = deployment.availableUpdates?.backend?.[0]
      const frontendUpdate = deployment.availableUpdates?.frontend?.[0]

      if (!backendUpdate || !frontendUpdate) {
        console.error('Both frontend and backend updates are required for bulk deployment')
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
      } else {
        console.error('Some deployments failed:', results)
      }

      // Refresh the page to show updated deployment status
      setTimeout(() => {
        window.location.reload()
      }, 2000)

    } catch (error) {
      console.error('Error deploying all updates:', error)

      // Clear running action on error
      setRunningActions(prev => {
        const newMap = new Map(prev)
        newMap.delete(deploymentKey)
        return newMap
      })
    } finally {
      // Always clear the in-progress state
      setDeploymentInProgress(prev => {
        const newSet = new Set(prev)
        newSet.delete(deploymentKey)
        return newSet
      })
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
        console.log(`Successfully triggered frontend deployment to ${deployment.environment}`, result.deployment)
      } else {
        console.error(`Failed to deploy frontend: ${result.message}`)
      }
    } catch (error) {
      console.error('Deploy error:', error)
    }
  }

  const handleCoordinatedDeploy = async (deployment) => {
    try {
      const backendUpdate = deployment.availableUpdates?.backend?.[0]
      const frontendUpdate = deployment.availableUpdates?.frontend?.[0]

      if (!backendUpdate || !frontendUpdate) {
        console.error('Missing builds for coordinated deployment')
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
        console.log(`Successfully triggered coordinated deployment to ${deployment.environment}`, {
          deploymentId: result.deploymentId,
          backend: backendUpdate.buildId,
          frontend: frontendUpdate.buildId
        })
      } else {
        console.error(`Failed to deploy coordinated: ${result.message}`)
      }
    } catch (error) {
      console.error('Coordinated deploy error:', error)
    }
  }

  const startPollingDeploymentStatus = (pipelineExecutionId, deploymentKey) => {
    const pollInterval = 15000 // Poll every 15 seconds
    const maxPolls = 40 // Maximum 10 minutes of polling (40 * 15 seconds)
    let pollCount = 0

    const poll = async () => {
      try {
        pollCount++

        const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/deployment-status/${pipelineExecutionId}`)

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const result = await response.json()

        console.log(`Polling deployment ${pipelineExecutionId}: ${result.status} (poll ${pollCount}/${maxPolls})`)

        // Check if deployment is complete
        if (result.isComplete) {
          // Clear deployment progress
          setDeploymentInProgress(prev => {
            const newSet = new Set(prev)
            newSet.delete(deploymentKey)
            return newSet
          })

          // Handle final status
          if (result.status === 'Succeeded') {
            console.log(`✅ Deployment ${pipelineExecutionId} completed successfully`)

            // Add to recently completed to prevent double-clicks
            setRecentlyCompleted(prev => new Set([...prev, deploymentKey]))

            // Clear recently completed after 10 seconds (should be enough for dashboard to refresh)
            setTimeout(() => {
              setRecentlyCompleted(prev => {
                const newSet = new Set(prev)
                newSet.delete(deploymentKey)
                return newSet
              })
            }, 10000)
          } else {
            console.log(`❌ Deployment ${pipelineExecutionId} failed with status: ${result.status}`)
            // Record failure
            setDeploymentFailures(prev => {
              const newMap = new Map(prev)
              newMap.set(deploymentKey, {
                buildId: 'unknown', // We don't have build ID in polling context
                timestamp: Date.now(),
                reason: `Pipeline ${result.status.toLowerCase()}`
              })
              return newMap
            })
          }

          return // Stop polling
        }

        // Continue polling if not complete and haven't exceeded max polls
        if (pollCount < maxPolls) {
          setTimeout(poll, pollInterval)
        } else {
          // Timeout - clear progress and record failure
          console.log(`⏰ Deployment polling timeout for ${pipelineExecutionId}`)
          setDeploymentInProgress(prev => {
            const newSet = new Set(prev)
            newSet.delete(deploymentKey)
            return newSet
          })
          setDeploymentFailures(prev => {
            const newMap = new Map(prev)
            newMap.set(deploymentKey, {
              buildId: 'unknown',
              timestamp: Date.now(),
              reason: 'Deployment polling timeout'
            })
            return newMap
          })
        }

      } catch (error) {
        console.error(`Error polling deployment status for ${pipelineExecutionId}:`, error)

        // On error, retry a few times, then give up
        if (pollCount < 5) {
          setTimeout(poll, pollInterval)
        } else {
          // Clear progress on repeated errors
          setDeploymentInProgress(prev => {
            const newSet = new Set(prev)
            newSet.delete(deploymentKey)
            return newSet
          })
        }
      }
    }

    // Start polling after a short delay to allow AWS to process the deployment
    setTimeout(poll, 5000)
  }

  const handleIndependentDeploy = async (deployment, componentType) => {
    const deploymentKey = `${deployment.environment}-${componentType}`

    try {
      // Mark specific action as running and deployment as in progress
      setRunningActions(prev => new Map([...prev, [deploymentKey, `deploy-${componentType}`]]))
      setDeploymentInProgress(prev => new Set([...prev, deploymentKey]))
      setRecentlyCompleted(prev => {
        const newSet = new Set(prev)
        newSet.delete(deploymentKey)
        return newSet
      })

      const update = deployment.availableUpdates?.[componentType]?.[0]

      if (!update) {
        console.error(`No ${componentType} build available for deployment`)
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
        console.log(`Successfully triggered independent ${componentType} deployment to ${deployment.environment}`, {
          deploymentId: result.deployment.deploymentId,
          buildId: update.buildId
        })

        // Clear any previous failure for this deployment
        setDeploymentFailures(prev => {
          const newMap = new Map(prev)
          newMap.delete(deploymentKey)
          return newMap
        })

        // Start polling for deployment status
        startPollingDeploymentStatus(result.deployment.pipelineExecutionId, deploymentKey)
      } else {
        console.error(`Failed to deploy ${componentType}: ${result.message}`)
        // Record failure for this specific build ID
        setDeploymentFailures(prev => {
          const newMap = new Map(prev)
          newMap.set(deploymentKey, {
            buildId: update.buildId,
            timestamp: Date.now(),
            reason: result.message
          })
          return newMap
        })
        // Clear progress and running action immediately on failure
        setDeploymentInProgress(prev => {
          const newSet = new Set(prev)
          newSet.delete(deploymentKey)
          return newSet
        })
        setRunningActions(prev => {
          const newMap = new Map(prev)
          newMap.delete(deploymentKey)
          return newMap
        })
      }
    } catch (error) {
      console.error(`Independent ${componentType} deploy error:`, error)
      // Record failure for this specific build ID
      setDeploymentFailures(prev => {
        const newMap = new Map(prev)
        newMap.set(deploymentKey, {
          buildId: update.buildId,
          timestamp: Date.now(),
          reason: 'Network error'
        })
        return newMap
      })
      // Clear progress and running action immediately on error
      setDeploymentInProgress(prev => {
        const newSet = new Set(prev)
        newSet.delete(deploymentKey)
        return newSet
      })
      setRunningActions(prev => {
        const newMap = new Map(prev)
        newMap.delete(deploymentKey)
        return newMap
      })
    }
  }

  const SmartDeploymentButtons = ({ deployment, component }) => {
    const coordination = deployment.deploymentCoordination

    // Helper function to get button state for a specific component
    const getButtonState = (targetComponent) => {
      const deploymentKey = `${deployment.environment}-${targetComponent}`
      const isDeploying = deploymentInProgress.has(deploymentKey)
      const isRecentlyCompleted = recentlyCompleted.has(deploymentKey)
      const runningAction = runningActions.get(deploymentKey)

      // Check for server-side deployment status (equivalent to build.status === 'IN_PROGRESS')
      const componentDeployment = deployment.currentDeployment?.[targetComponent]
      const isServerDeploying = componentDeployment?.deploymentStatus === 'DEPLOYING' && !runningAction

      const effectiveDeploying = isDeploying || isServerDeploying

      return {
        deploymentKey,
        isDeploying,
        isRecentlyCompleted,
        runningAction,
        isServerDeploying,
        effectiveDeploying,
        disabled: runningActions.size > 0 || effectiveDeploying || isRecentlyCompleted,
        variant: runningAction || isServerDeploying ? 'primary' :
                isRecentlyCompleted ? 'success' :
                (runningActions.size > 0 || effectiveDeploying) ? 'outline-secondary' :
                (targetComponent === 'backend' ? 'outline-info' : 'outline-warning')
      }
    }

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
          const buttonState = getButtonState(component)
          const currentBuild = deployment.availableUpdates[component][0]

          // Check if current build has failure status, auto-clear if build ID changed
          const failureInfo = deploymentFailures.get(buttonState.deploymentKey)
          const hasFailure = failureInfo && failureInfo.buildId === currentBuild.buildId

          // Auto-clear failure if build ID has changed (new build available)
          if (failureInfo && failureInfo.buildId !== currentBuild.buildId) {
            setDeploymentFailures(prev => {
              const newMap = new Map(prev)
              newMap.delete(buttonState.deploymentKey)
              return newMap
            })
          }

          return (
            <div className="ms-3 d-flex flex-column align-items-end">
              <Button
                variant={buttonState.variant}
                size="sm"
                onClick={() => handleIndependentDeploy(deployment, component)}
                disabled={buttonState.disabled}
                title={buttonState.runningAction ? `Deploying ${component}...` : buttonState.isRecentlyCompleted ? 'Deployment completed, waiting for refresh...' : `Deploy ${component} update`}
              >
                {buttonState.runningAction || buttonState.isServerDeploying ? (
                  <>
                    <Spinner size="sm" className="me-1" />
                    Deploying...
                  </>
                ) : buttonState.isRecentlyCompleted ? (
                  <>
                    ✅ Deployed
                  </>
                ) : (
                  <>
                    <Rocket size={14} className="me-1" />
                    Deploy
                  </>
                )}
              </Button>
              {hasFailure && !buttonState.runningAction && !buttonState.isServerDeploying && (
                <Badge bg="danger" className="mt-1" style={{ fontSize: '0.65rem' }} title={`Last deployment failed: ${failureInfo.reason}`}>
                  <XCircle size={10} className="me-1" />
                  Deploy Failed
                </Badge>
              )}
            </div>
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
        const coordinatedButtonState = getButtonState(component)
        return (
          <div className="ms-3 d-flex gap-1">
            <Button
              variant={coordinatedButtonState.variant}
              size="sm"
              onClick={() => handleIndependentDeploy(deployment, component)}
              disabled={coordinatedButtonState.disabled}
              title={coordinatedButtonState.runningAction ? `Deploying ${component}...` : `Deploy only ${component}`}
            >
              {coordinatedButtonState.runningAction || coordinatedButtonState.isServerDeploying ? (
                <>
                  <Spinner size="sm" className="me-1" />
                  Deploying...
                </>
              ) : coordinatedButtonState.isRecentlyCompleted ? (
                <>
                  ✅ Deployed
                </>
              ) : (
                component === 'backend' ? 'Deploy Backend' : 'Deploy Frontend'
              )}
            </Button>
          </div>
        )

      case 'BOTH_READY_INDEPENDENT':
        const independentButtonState = getButtonState(component)
        return (
          <div className="ms-3 d-flex gap-1">
            <Button
              variant={independentButtonState.variant}
              size="sm"
              onClick={() => handleIndependentDeploy(deployment, component)}
              disabled={independentButtonState.disabled}
              title={independentButtonState.runningAction ? `Deploying ${component}...` : `Deploy ${component} independently (recommended)`}
            >
              {independentButtonState.runningAction || independentButtonState.isServerDeploying ? (
                <>
                  <Spinner size="sm" className="me-1" />
                  Deploying...
                </>
              ) : independentButtonState.isRecentlyCompleted ? (
                <>
                  ✅ Deployed
                </>
              ) : (
                component === 'backend' ? 'Deploy Backend' : 'Deploy Frontend'
              )}
            </Button>
          </div>
        )

      case 'BACKEND_ONLY_READY':
        const backendOnlyButtonState = getButtonState('backend')
        return (
          <Button
            variant={backendOnlyButtonState.variant}
            size="sm"
            className="ms-3"
            onClick={() => handleIndependentDeploy(deployment, 'backend')}
            disabled={backendOnlyButtonState.disabled}
            title={backendOnlyButtonState.runningAction ? 'Deploying backend...' : coordination.reason}
          >
            {backendOnlyButtonState.runningAction || backendOnlyButtonState.isServerDeploying ? (
              <>
                <Spinner size="sm" className="me-1" />
                Deploying...
              </>
            ) : backendOnlyButtonState.isRecentlyCompleted ? (
              <>
                ✅ Deployed
              </>
            ) : (
              <>
                <Rocket size={14} className="me-1" />
                Deploy Backend
              </>
            )}
          </Button>
        )

      case 'FRONTEND_ONLY_READY':
        const frontendOnlyButtonState = getButtonState('frontend')
        return (
          <Button
            variant={frontendOnlyButtonState.variant}
            size="sm"
            className="ms-3"
            onClick={() => handleIndependentDeploy(deployment, 'frontend')}
            disabled={frontendOnlyButtonState.disabled}
            title={frontendOnlyButtonState.runningAction ? 'Deploying frontend...' : coordination.reason}
          >
            {frontendOnlyButtonState.runningAction || frontendOnlyButtonState.isServerDeploying ? (
              <>
                <Spinner size="sm" className="me-1" />
                Deploying...
              </>
            ) : frontendOnlyButtonState.isRecentlyCompleted ? (
              <>
                ✅ Deployed
              </>
            ) : (
              <>
                <Rocket size={14} className="me-1" />
                Deploy Frontend
              </>
            )}
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
    
    // No update available for this component
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
                      const deploymentKey = `${deployment.environment}-all`
                      const isDeploying = deploymentInProgress.has(deploymentKey)
                      const isRecentlyCompleted = recentlyCompleted.has(deploymentKey)
                      const runningAction = runningActions.get(deploymentKey)
                      const isServerDeploying = isDeploying && !runningAction // Server-detected deployment without local action

                      return (
                        <Button
                          size="sm"
                          variant={isBlocked ? "outline-secondary" :
                                  runningAction || isServerDeploying ? "primary" :
                                  isRecentlyCompleted ? "success" :
                                  (runningActions.size > 0 || isDeploying) ? "outline-secondary" :
                                  "outline-primary"}
                          onClick={isBlocked || runningActions.size > 0 || isRecentlyCompleted ? undefined : () => handleDeployAll(deployment)}
                          disabled={isBlocked || runningActions.size > 0 || isDeploying || isRecentlyCompleted}
                          title={isBlocked
                            ? `Cannot deploy: ${deployment.deploymentCoordination?.reason}`
                            : runningAction
                            ? 'Deploying both components...'
                            : isRecentlyCompleted
                            ? 'Deployment completed, waiting for refresh...'
                            : `Deploy both frontend and backend updates to ${deployment.environment}`}
                        >
                          {runningAction || isServerDeploying ? (
                            <>
                              <Spinner size="sm" className="me-1" />
                              Deploying All...
                            </>
                          ) : isRecentlyCompleted ? (
                            <>
                              ✅ All Deployed
                            </>
                          ) : (
                            <>
                              <Rocket size={14} className="me-1" />
                              Deploy Frontend and Backend{isBlocked ? ' (Blocked)' : ''}
                            </>
                          )}
                        </Button>
                      )
                    })()
                  )}
                </div>
                <Table variant="dark" striped bordered hover className="mb-0">
                  <thead>
                    <tr>
                      <th width="18%">Component</th>
                      <th width="31%">Currently Deployed</th>
                      <th width="31%">Available Updates</th>
                      <th width="15%">Actions</th>
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
                        <>
                          <BuildDisplay
                            build={deployment.currentDeployment.backend}
                            showRedIndicator={false}
                          />
                          {deployment.currentDeployment.backend.buildTimestamp && (
                            <span className="small text-muted ms-2">
                              {formatDateTime(deployment.currentDeployment.backend.buildTimestamp)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-secondary">No current deployment</span>
                      )}
                    </td>
                    <td className="align-middle">
                      {deployment.availableUpdates?.backend?.length > 0 ? (
                        <>
                          <BuildDisplay
                            build={deployment.availableUpdates.backend[0]}
                            showRedIndicator={true}
                            isOutOfDate={(() => {
                              const isBackendDemoBuild = deployment.availableUpdates.backend[0].projectName?.includes('backend') && deployment.availableUpdates.backend[0].projectName?.includes('demo');
                              const isProdBuild = deployment.availableUpdates.backend[0].projectName?.includes('backend') && deployment.availableUpdates.backend[0].projectName?.includes('prod');
                              if (isProdBuild) {
                                return prodBuildStatuses['backend']?.needsBuild === true;
                              } else if (isBackendDemoBuild) {
                                return prodBuildStatuses['backend-demo']?.needsBuild === true;
                              }
                              return false;
                            })()}
                          />
                          {deployment.availableUpdates.backend[0].buildTimestamp && (
                            <span className="small text-muted ms-2">
                              {formatDateTime(deployment.availableUpdates.backend[0].buildTimestamp)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-secondary">No update available</span>
                      )}
                    </td>
                    <td className="align-middle">
                      {deployment.availableUpdates?.backend?.length > 0 ? (
                        <SmartDeploymentButtons deployment={deployment} component="backend" />
                      ) : null}
                    </td>
                  </tr>

                  {/* Frontend Row */}
                  <tr>
                    <td className="align-middle">
                      <span className="fw-bold text-warning">Frontend</span>
                    </td>
                    <td className="align-middle">
                      {deployment.currentDeployment?.frontend ? (
                        <>
                          <BuildDisplay
                            build={deployment.currentDeployment.frontend}
                            showRedIndicator={false}
                          />
                          {deployment.currentDeployment.frontend.buildTimestamp && (
                            <span className="small text-muted ms-2">
                              {formatDateTime(deployment.currentDeployment.frontend.buildTimestamp)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-secondary">No current deployment</span>
                      )}
                    </td>
                    <td className="align-middle">
                      {deployment.availableUpdates?.frontend?.length > 0 ? (
                        <>
                          <BuildDisplay
                            build={deployment.availableUpdates.frontend[0]}
                            showRedIndicator={true}
                            isOutOfDate={(() => {
                              const isProdBuild = deployment.availableUpdates.frontend[0].projectName?.includes('frontend') && deployment.availableUpdates.frontend[0].projectName?.includes('prod');
                              return isProdBuild && prodBuildStatuses['frontend']?.needsBuild === true;
                            })()}
                          />
                          {deployment.availableUpdates.frontend[0].buildTimestamp && (
                            <span className="small text-muted ms-2">
                              {formatDateTime(deployment.availableUpdates.frontend[0].buildTimestamp)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-secondary">No update available</span>
                      )}
                    </td>
                    <td className="align-middle">
                      {deployment.availableUpdates?.frontend?.length > 0 ? (
                        <SmartDeploymentButtons deployment={deployment} component="frontend" />
                      ) : null}
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