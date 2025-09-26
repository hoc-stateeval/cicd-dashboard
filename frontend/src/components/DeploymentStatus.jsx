import { useState, useEffect } from 'react'
import { Card, Row, Col, Badge, Button, Table, Spinner, OverlayTrigger, Tooltip } from 'react-bootstrap'
import { Clock, GitBranch, AlertTriangle, Rocket, XCircle } from 'lucide-react'
import BuildDisplay from './BuildDisplay'
import { formatBuildSource, getHashDisplay, createDeploymentTooltipFields, isBuildOutOfDate } from '../utils/buildFormatting.jsx'
import { useLatestMerges } from '../hooks/useLatestMerge'
// Force reload to clear cache - v2 with debug logs


export default function DeploymentStatus({ deployments, refetch, deploymentBuilds = [] }) {
  // Use React Query for latest merge data
  const latestMergeQuery = useLatestMerges()
  const latestMerges = {
    backend: latestMergeQuery.backend.data,
    frontend: latestMergeQuery.frontend.data,
    backendDev: latestMergeQuery.backendDev.data,
    frontendDev: latestMergeQuery.frontendDev.data
  }

  // Helper function to get full build object from deploymentBuilds cache
  const getFullBuildFromCache = (buildId) => {
    if (!buildId || !deploymentBuilds || deploymentBuilds.length === 0) return null
    return deploymentBuilds.find(build => build.buildId === buildId) || null
  }


  // Helper function to check if there's an out-of-date deployment build for a component
  const isComponentOutOfDate = (componentType, environment) => {
    // Map environment names to project name suffixes
    const envSuffix = environment === 'production' ? 'prod' : environment

    // Find the latest deployment build for this component in the specified environment
    const componentBuilds = deploymentBuilds.filter(build => {
      const projectName = build.projectName || ''

      // Match builds for the specific environment (prod, demo, sandbox)
      const isEnvironmentBuild = projectName.endsWith(`-${componentType}-${envSuffix}`)

      return isEnvironmentBuild
    })

    if (componentBuilds.length === 0) {
      // If no builds exist but git commits do, we consider it "out of date" (needs first build)
      return latestMerges[componentType] ? true : false
    }

    // Get the most recent build (deploymentBuilds should already be sorted by date)
    const latestBuild = componentBuilds[0]

    // Check if we have the necessary commit data for comparison
    const hasCommitData = latestMerges[componentType] || latestMerges[`${componentType}Dev`]
    if (!hasCommitData) {
      return false // Don't show red indicator if we can't compare
    }

    // Use the same logic as BuildDisplay to check if this build is out of date
    return isBuildOutOfDate(latestBuild, latestMerges, componentType)
  }


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
      } else {
        console.error(`Failed to deploy coordinated: ${result.message}`)
      }
    } catch (error) {
      console.error('Coordinated deploy error:', error)
    }
  }

  const startPollingDeploymentStatus = (pipelineExecutionId, deploymentKey) => {
    const pollInterval = 15000 // Poll every 15 seconds
    const maxPolls = 100 // Maximum 25 minutes of polling (100 × 15s = 1500s = 25 min)
    let pollCount = 0

    const poll = async () => {
      try {
        pollCount++

        const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/deployment-status/${pipelineExecutionId}`)

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const result = await response.json()


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

            // Refresh the deployment data to show updated status
            setTimeout(() => {
              if (refetch) {
                refetch()
              }
            }, 2000)
          } else {
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
        const errorMessage = `No ${componentType} build available for deployment`
        console.error(errorMessage)
        alert(`❌ Deployment Failed\n\n${errorMessage}\n\nPlease ensure there are available ${componentType} builds to deploy.`)
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

        // Clear any previous failure for this deployment
        setDeploymentFailures(prev => {
          const newMap = new Map(prev)
          newMap.delete(deploymentKey)
          return newMap
        })

        // Start polling for deployment status
        startPollingDeploymentStatus(result.deployment.pipelineExecutionId, deploymentKey)
      } else {
        const errorMessage = result.message || 'Unknown server error'
        console.error(`Failed to deploy ${componentType}: ${errorMessage}`)

        // Show user-friendly error alert
        alert(`❌ Deployment Failed\n\nServer error deploying ${componentType} to ${deployment.environment}:\n${errorMessage}`)

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

      // Show user-friendly error alert
      const errorMessage = error.message || 'Unknown error occurred'
      alert(`❌ Deployment Failed\n\nFailed to deploy ${componentType} to ${deployment.environment}:\n${errorMessage}\n\nPlease check your connection and try again.`)

      // Record failure for this specific build ID
      setDeploymentFailures(prev => {
        const newMap = new Map(prev)
        newMap.set(deploymentKey, {
          buildId: update?.buildId || 'unknown',
          timestamp: Date.now(),
          reason: errorMessage
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
        disabled: effectiveDeploying || isRecentlyCompleted,
        variant: runningAction || isServerDeploying ? 'primary' :
                isRecentlyCompleted ? 'success' :
                effectiveDeploying ? 'outline-secondary' :
                (targetComponent === 'backend' ? 'outline-info' : 'outline-warning')
      }
    }

    if (!coordination) {
      // Fallback to simple deploy button if no coordination data
      const buttonState = getButtonState(component)
      return (
        <Button
          variant={buttonState.variant}
          size="sm"
          className="ms-3"
          onClick={() => handleIndependentDeploy(deployment, component)}
          disabled={buttonState.disabled}
        >
          <Rocket size={14} className="me-1" />
          {buttonState.runningAction ? 'Deploying...' : 'Deploy'}
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
            <OverlayTrigger
              placement="top"
              overlay={
                <Tooltip id={`blocked-deploy-tooltip-${deployment.environment}-${component}`}>
                  <div className="text-start">
                    <div><strong>Production deployment blocked</strong></div>
                    <div>{coordination.reason}</div>
                    <div className="mt-1 text-warning-emphasis">New builds with latest commits are required before deploying to production.</div>
                  </div>
                </Tooltip>
              }
            >
              <span className="ms-3 d-inline-block">
                <Button
                  variant="outline-secondary"
                  size="sm"
                  disabled
                  style={{ pointerEvents: 'none' }}
                >
                  <Rocket size={14} className="me-1" />
                  Deploy (Blocked)
                </Button>
              </span>
            </OverlayTrigger>
          )
        }

        // For other non-demo/sandbox environments, show "Build Required"
        return (
          <div className="ms-3 d-flex flex-column align-items-end">
            <OverlayTrigger
              placement="top"
              overlay={
                <Tooltip id={`build-required-tooltip-${deployment.environment}-${component}`}>
                  <div className="text-start">
                    <div><strong>Production deployment blocked</strong></div>
                    <div>{coordination.reason}</div>
                    <div className="mt-1 text-warning-emphasis">Trigger new builds to create up-to-date builds for deployment.</div>
                  </div>
                </Tooltip>
              }
            >
              <span className="d-inline-block">
                <Button variant="outline-secondary" size="sm" disabled style={{ pointerEvents: 'none' }}>
                  <AlertTriangle size={14} className="me-1" />
                  Build Required
                </Button>
              </span>
            </OverlayTrigger>
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
                  <div className="d-flex align-items-center gap-2">
                    <h6 className="mb-0 text-light">
                      🚀 {deployment.environment.charAt(0).toUpperCase() + deployment.environment.slice(1)} Deployments
                    </h6>
                    {(() => {
                      const frontendBuild = deployment.currentDeployment?.frontend?.buildNumber
                      const backendBuild = deployment.currentDeployment?.backend?.buildNumber
                      if (frontendBuild && backendBuild) {
                        return (
                          <Badge bg="secondary" className="ms-2">
                            v3.{frontendBuild}.{backendBuild}
                          </Badge>
                        )
                      }
                      return null
                    })()}
                  </div>
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

                      // Check if any individual component deployments are running for this environment
                      const backendKey = `${deployment.environment}-backend`
                      const frontendKey = `${deployment.environment}-frontend`
                      const hasIndividualDeployments = runningActions.has(backendKey) || runningActions.has(frontendKey)
                      const isServerDeploying = isDeploying && !runningAction // Server-detected deployment without local action

                      return isBlocked ? (
                        <OverlayTrigger
                          placement="top"
                          overlay={
                            <Tooltip id={`blocked-deploy-all-tooltip-${deployment.environment}`}>
                              <div className="text-start">
                                <div><strong>Production deployment blocked</strong></div>
                                <div>{deployment.deploymentCoordination?.reason}</div>
                                <div className="mt-1 text-warning-emphasis">New builds with latest commits are required before deploying to production.</div>
                              </div>
                            </Tooltip>
                          }
                        >
                          <span className="d-inline-block">
                            <Button
                              size="sm"
                              variant="outline-secondary"
                              disabled
                              style={{ pointerEvents: 'none' }}
                            >
                              <Rocket size={14} className="me-1" />
                              Deploy Frontend and Backend (Blocked)
                            </Button>
                          </span>
                        </OverlayTrigger>
                      ) : (
                        <Button
                          size="sm"
                          variant={runningAction || isServerDeploying ? "primary" :
                                  isRecentlyCompleted ? "success" :
                                  (hasIndividualDeployments || isDeploying) ? "outline-secondary" :
                                  "outline-primary"}
                          onClick={hasIndividualDeployments || isRecentlyCompleted ? undefined : () => handleDeployAll(deployment)}
                          disabled={hasIndividualDeployments || isDeploying || isRecentlyCompleted}
                          title={runningAction
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
                              Deploy Frontend and Backend
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
                        (() => {
                          const additionalTooltipFields = createDeploymentTooltipFields(deployment.currentDeployment.backend)
                          return (
                            <BuildDisplay
                              build={deployment.currentDeployment.backend}
                              additionalTooltipFields={additionalTooltipFields}
                              latestMerges={latestMerges}
                              showOutOfDateIndicator={true}
                              componentType="backend"
                              availableBuild={getFullBuildFromCache(deployment.availableUpdates?.backend?.[0]?.buildId)}
                            />
                          )
                        })()
                      ) : (
                        <BuildDisplay
                          build={null}
                          latestMerges={latestMerges}
                          componentType="backend"
                          deploymentMode="no-deployment"
                        />
                      )}
                    </td>
                    <td className="align-middle">
                      {deployment.availableUpdates?.backend?.length > 0 ? (
                        <>
                          <BuildDisplay
                            build={getFullBuildFromCache(deployment.availableUpdates.backend[0]?.buildId) || deployment.availableUpdates.backend[0]}
                            latestMerges={latestMerges}
                            showOutOfDateIndicator={true}
                            componentType="backend"
                          />
                        </>
                      ) : (
                        <BuildDisplay
                          build={null}
                          latestMerges={latestMerges}
                          componentType="backend"
                          deploymentMode={isComponentOutOfDate('backend', deployment.environment) ? "no-updates" : "no-updates-current"}
                        />
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
                        (() => {
                          const additionalTooltipFields = createDeploymentTooltipFields(deployment.currentDeployment.frontend)
                          return (
                            <BuildDisplay
                              build={deployment.currentDeployment.frontend}
                              additionalTooltipFields={additionalTooltipFields}
                              latestMerges={latestMerges}
                              showOutOfDateIndicator={true}
                              componentType="frontend"
                              availableBuild={getFullBuildFromCache(deployment.availableUpdates?.frontend?.[0]?.buildId)}
                            />
                          )
                        })()
                      ) : (
                        <BuildDisplay
                          build={null}
                          latestMerges={latestMerges}
                          componentType="frontend"
                          deploymentMode="no-deployment"
                        />
                      )}
                    </td>
                    <td className="align-middle">
                      {deployment.availableUpdates?.frontend?.length > 0 ? (
                        <>
                          <BuildDisplay
                            build={getFullBuildFromCache(deployment.availableUpdates.frontend[0]?.buildId) || deployment.availableUpdates.frontend[0]}
                            latestMerges={latestMerges}
                            showOutOfDateIndicator={true}
                            componentType="frontend"
                          />
                        </>
                      ) : (
                        <BuildDisplay
                          build={null}
                          latestMerges={latestMerges}
                          componentType="frontend"
                          deploymentMode={isComponentOutOfDate('frontend', deployment.environment) ? "no-updates" : "no-updates-current"}
                        />
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