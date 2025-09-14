import { useState, useEffect } from 'react'
import { Play, RotateCcw, AlertTriangle } from 'lucide-react'
import { Badge, Button, Spinner, OverlayTrigger, Tooltip } from 'react-bootstrap'

const statusVariants = {
  SUCCESS: 'success',
  SUCCEEDED: 'success', 
  FAILED: 'danger',
  IN_PROGRESS: 'warning',
  RUNNING: 'warning'
}

const formatDuration = (seconds) => {
  if (!seconds) return '--'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs}s`
}

const formatTime = (timestamp) => {
  if (!timestamp) return '--'
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric', 
    hour: '2-digit',
    minute: '2-digit'
  })
}

const formatCompletedTime = (build) => {
  // Show "--" for in-progress builds like we do for duration
  if (build.status === 'IN_PROGRESS' || build.status === 'RUNNING') {
    return '--'
  }
  // Use endTime if available, otherwise fall back to startTime
  const timestamp = build.endTime || build.startTime
  return formatTime(timestamp)
}

const getHashDisplay = (build) => {
  // Prioritize git commit for deployment correlation, then fall back to artifact hashes
  if (build.commit) {
    return build.commit.substring(0, 7)
  }
  if (build.artifacts?.sha256Hash) {
    return build.artifacts.sha256Hash.substring(0, 8)
  }
  if (build.artifacts?.md5Hash) {
    return build.artifacts.md5Hash.substring(0, 8)
  }
  return '--'
}

const formatHotfixTooltip = (hotfixDetails) => {
  if (!hotfixDetails) return null

  const message = hotfixDetails.message.split('\n')[0] // First line only
  const date = hotfixDetails.date ? new Date(hotfixDetails.date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }) : 'Unknown date'

  return (
    <div className="text-start">
      <div><strong>Commit:</strong> {hotfixDetails.sha?.substring(0, 7) || 'unknown'}</div>
      <div><strong>Author:</strong> {hotfixDetails.author?.name || 'Unknown'}</div>
      <div><strong>Message:</strong> {message}</div>
      <div><strong>Date:</strong> {date}</div>
      <div className="text-muted small">Direct commit (no PR)</div>
    </div>
  )
}

const formatPRTooltip = (build) => {
  if (!build.prNumber) return null

  const startTime = build.startTime ? new Date(build.startTime).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }) : 'Unknown date'

  // Get commit author (server now provides this for PR builds)
  const author = build.commitAuthor || 'Not available'

  // Get commit message (server now provides this for PR builds, first line only)
  const message = build.commitMessage ? build.commitMessage.split('\n')[0] : 'Not available'

  return (
    <div className="text-start">
      <div><strong>PR:</strong> #{build.prNumber}</div>
      <div><strong>Commit:</strong> {getHashDisplay(build)}</div>
      <div><strong>Author:</strong> {author}</div>
      <div><strong>Message:</strong> {message}</div>
      <div><strong>Started:</strong> {startTime}</div>
      <div className="text-muted small">Pull request build</div>
    </div>
  )
}

export default function BuildRow({
  build,
  allBuilds,
  onTriggerProdBuilds,
  prodBuildStatuses = {},
  buildsInProgress,
  setBuildsInProgress,
  buildFailures,
  setBuildFailures,
  recentlyCompleted,
  setRecentlyCompleted,
  startPollingBuildStatus,
  deployments = []
}) {
  const [runningAction, setRunningAction] = useState(null) // Track which action is running: 'run' or 'retry'

  const statusVariant = statusVariants[build.status] || 'secondary'

  // Create build key for global state tracking
  const buildKey = `${build.projectName}-${build.buildId}`

  // Function to get deployed information for this build's project
  const getDeployedInfo = () => {
    if (!deployments || deployments.length === 0) return '--'

    // Determine if this is a backend or frontend project
    const isBackend = build.projectName.includes('backend')
    const isFrontend = build.projectName.includes('frontend')

    // Look through all environments to find where this build's project type is deployed
    for (const env of deployments) {
      const componentDeployment = isBackend ? env.currentDeployment?.backend :
                                  isFrontend ? env.currentDeployment?.frontend : null

      if (componentDeployment?.prNumber) {
        return `${env.environment}: PR${componentDeployment.prNumber}`
      } else if (componentDeployment?.gitCommit) {
        return `${env.environment}: ${componentDeployment.gitCommit.substring(0, 7)}`
      }
    }

    return '--'
  }

  // Get build states from global state
  const isLocallyTriggered = buildsInProgress?.has(buildKey) || false
  const isServerRunning = build.status === 'IN_PROGRESS' || build.status === 'RUNNING'
  const isRunningBuild = isLocallyTriggered || isServerRunning
  const isRecentlyCompleted = recentlyCompleted?.has(buildKey) || false
  const buildFailure = buildFailures?.get(buildKey)

  // Override build status for immediate UI feedback
  const effectiveStatus = isLocallyTriggered ? 'IN_PROGRESS' : build.status

  // Debug logging for troubleshooting
  if (build.projectName?.includes('eval-frontend-sandbox')) {
    console.log(`[${build.projectName}] Build state:`, {
      buildStatus: build.status,
      effectiveStatus,
      isLocallyTriggered,
      isServerRunning,
      isRunningBuild,
      runningAction,
      buildsInProgressSize: buildsInProgress?.size
    })
  }

  // Clear runningAction when build completes or fails
  useEffect(() => {
    if (runningAction && (!isLocallyTriggered && !isServerRunning)) {
      // Build has completed, clear the running action
      setRunningAction(null)
    }
  }, [isLocallyTriggered, isServerRunning, runningAction])


  // Determine component type for button styling
  const isBackendComponent = build.projectName.includes('backend')
  const isFrontendComponent = build.projectName.includes('frontend')
  const componentButtonVariant = isBackendComponent ? 'outline-info' :
                                 isFrontendComponent ? 'outline-warning' :
                                 'outline-primary'

  // Check if this is a deployment build that can be triggered/re-triggered
  // Show button on all deployment builds (prod, demo, sandbox) so they can be re-run if needed
  const isProdBuild = build.projectName.includes('prod')
  const isBackendDemoBuild = build.projectName.includes('backend') && build.projectName.includes('demo')
  const canRunProdBuild = build.type === 'production' || build.isDeployable || build.type === 'dev-test'

  // Check if this specific build is out of date
  let isOutOfDate = false

  if (isProdBuild) {
    // For production builds, check against backend/frontend keys
    const componentType = build.projectName.includes('backend') ? 'backend' :
                         build.projectName.includes('frontend') ? 'frontend' : null
    isOutOfDate = componentType && prodBuildStatuses[componentType]?.needsBuild === true
  } else if (isBackendDemoBuild) {
    // For backend demo builds, check against backend-demo key
    isOutOfDate = prodBuildStatuses['backend-demo']?.needsBuild === true
  }
  
  
  const handleTriggerProd = async () => {
    try {
      // Mark which action is running and build as in progress
      setRunningAction('run')
      setBuildsInProgress(prev => new Set([...prev, buildKey]))
      setRecentlyCompleted(prev => {
        const newSet = new Set(prev)
        newSet.delete(buildKey)
        return newSet
      })

      // For dev builds, always trigger fresh build from latest dev branch
      if (build.type === 'dev-test') {
        console.log(`Triggering new dev build for ${build.projectName} from latest dev branch...`)

        const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/trigger-single-build`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            projectName: build.projectName,
            sourceBranch: 'dev'
          })
        })

        if (!response.ok) {
          throw new Error(`Failed to trigger dev build: ${response.status}`)
        }

        const result = await response.json()
        console.log('Dev build triggered successfully:', result)

        // Start polling if we got a build ID back
        if (result.buildId || result.build?.id) {
          const buildId = result.buildId || result.build.id
          startPollingBuildStatus(buildId, build.projectName)
        }
      } else {
        // For production builds, find the latest PR number from main branch builds
        // Look for builds with the same component type (backend/frontend) that are dev→main
        const componentType = build.projectName.includes('backend') ? 'backend' :
                             build.projectName.includes('frontend') ? 'frontend' : null

        if (!componentType) {
          alert('Cannot determine component type for production build')
          return
        }

        // Detect if this should be a dev→dev build (direct commit to dev branch)
        const isDevToDevBuild = build.type === 'dev-test' &&
                               (build.sourceVersion === 'dev' || build.sourceVersion === 'refs/heads/dev') &&
                               !build.prNumber;

        // All manual builds should get latest changes, never use PR numbers
        const requestBody = isDevToDevBuild ?
          { projectName: build.projectName, sourceBranch: 'dev' } : // Dev→dev builds from dev branch
          { projectName: build.projectName }; // All other builds (prod, demo, sandbox) build from latest main

        console.log(`Triggering ${isDevToDevBuild ? 'dev→dev' : 'main branch'} build for ${build.projectName}${isDevToDevBuild ? ' from dev branch' : ' from latest main'}...`)

        const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/trigger-single-build`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody)
        })

        if (!response.ok) {
          throw new Error(`Failed to trigger build: ${response.status}`)
        }

        const result = await response.json()
        console.log('Build triggered successfully:', result)

        // Start polling if we got a build ID back
        if (result.buildId || result.build?.id) {
          const buildId = result.buildId || result.build.id
          startPollingBuildStatus(buildId, build.projectName)
        }
      }

    } catch (error) {
      console.error('Error triggering build:', error)
      alert(`Failed to trigger build: ${error.message}`)

      // Clear progress and record failure on error
      setBuildsInProgress(prev => {
        const newSet = new Set(prev)
        newSet.delete(buildKey)
        return newSet
      })
      setBuildFailures(prev => {
        const newMap = new Map(prev)
        newMap.set(buildKey, {
          buildId: build.buildId,
          timestamp: Date.now(),
          reason: error.message
        })
        return newMap
      })

      // Only clear running action on error - let polling system clear it on success
      setRunningAction(null)
    }
  }

  const handleRetryBuild = async () => {
    try {
      // Mark which action is running and build as in progress
      setRunningAction('retry')
      setBuildsInProgress(prev => new Set([...prev, buildKey]))
      setRecentlyCompleted(prev => {
        const newSet = new Set(prev)
        newSet.delete(buildKey)
        return newSet
      })

      console.log(`Retrying build ${build.buildId} for ${build.projectName}...`)

      const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/retry-build`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          buildId: build.buildId,
          projectName: build.projectName,
          prNumber: build.prNumber
        })
      })

      if (!response.ok) {
        throw new Error(`Failed to retry build: ${response.status}`)
      }

      const result = await response.json()
      console.log('Build retried successfully:', result)

      // Start polling if we got a build ID back
      if (result.buildId || result.build?.id) {
        const buildId = result.buildId || result.build.id
        startPollingBuildStatus(buildId, build.projectName)
      }

    } catch (error) {
      console.error('Error retrying build:', error)
      alert(`Failed to retry build: ${error.message}`)

      // Clear progress and record failure on error
      setBuildsInProgress(prev => {
        const newSet = new Set(prev)
        newSet.delete(buildKey)
        return newSet
      })
      setBuildFailures(prev => {
        const newMap = new Map(prev)
        newMap.set(buildKey, {
          buildId: build.buildId,
          timestamp: Date.now(),
          reason: error.message
        })
        return newMap
      })

      // Only clear running action on error - let polling system clear it on success
      setRunningAction(null)
    }
  }
  
  return (
    <tr>
      <td className="fw-medium">
        <div className="d-flex align-items-center">
          <span>{build.projectName}</span>
          {isOutOfDate && (
            <Badge bg="warning" text="dark" className="ms-2 d-flex align-items-center" title="Production build is out of date - newer code available in sandbox/demo">
              <AlertTriangle size={12} className="me-1" />
              Build Needed
            </Badge>
          )}
        </div>
      </td>
      <td className="text-center">
        <span className="text-light font-monospace small">
          {getDeployedInfo()}
        </span>
      </td>
      <td>
        <Badge bg={statusVariants[effectiveStatus] || 'secondary'}>{effectiveStatus}</Badge>
      </td>
      <td className="text-center">
        <span className="text-light">
          {isRunningBuild ? '--' :
           build.prNumber && build.type === 'dev-test' ?
            (build.sourceBranch ? `${build.sourceBranch}→dev` : 'feature→dev') :
           (build.sourceVersion === 'dev' || build.sourceVersion === 'refs/heads/dev') && !build.prNumber ? 'dev→dev' :
           (build.sourceVersion === 'main' || build.sourceVersion === 'refs/heads/main') && !build.prNumber ? 'main→main' :
           build.prNumber ? 'dev→main' :
           build.hotfixDetails?.isHotfix && build.sourceBranch === 'dev' ? 'hotfix→dev' :
           build.hotfixDetails?.isHotfix ? 'hotfix→main' :
           '--'}
        </span>
      </td>
      <td className="text-center">
        <div className="d-flex flex-column align-items-center justify-content-center">
          {isRunningBuild ? (
            <span className="text-light">--</span>
          ) : build.prNumber ? (
            <div className="d-flex align-items-center">
              <OverlayTrigger
                placement="top"
                overlay={<Tooltip id={`pr-tooltip-${build.buildId}`}>{formatPRTooltip(build)}</Tooltip>}
              >
                <span className="text-light" style={{ cursor: 'help' }}>
                  #{build.prNumber}
                </span>
              </OverlayTrigger>
              <span className="text-secondary small font-monospace ms-1">({getHashDisplay(build)})</span>
            </div>
          ) : build.hotfixDetails?.isHotfix ? (
            <div className="d-flex align-items-center">
              <OverlayTrigger
                placement="top"
                overlay={<Tooltip id={`hotfix-tooltip-${build.buildId}`}>{formatHotfixTooltip(build.hotfixDetails)}</Tooltip>}
              >
                <Badge
                  bg={build.sourceBranch === 'dev' ? "info" : "warning"}
                  text="dark"
                  className="me-1"
                  style={{ cursor: 'help' }}
                >
                  hotfix
                </Badge>
              </OverlayTrigger>
              <span className="text-secondary small font-monospace">({getHashDisplay(build)})</span>
            </div>
          ) : build.sourceVersion === 'dev' || build.sourceVersion === 'refs/heads/dev' ? (
            <span className="text-light">
              dev <span className="text-secondary small font-monospace">({getHashDisplay(build)})</span>
            </span>
          ) : build.sourceVersion === 'main' || build.sourceVersion === 'refs/heads/main' ? (
            <span className="text-light">
              main <span className="text-secondary small font-monospace">({getHashDisplay(build)})</span>
            </span>
          ) : (
            <span className="text-light">
              -- <span className="text-secondary small font-monospace">({getHashDisplay(build)})</span>
            </span>
          )}
        </div>
      </td>
      <td className="text-light">
        {isRunningBuild ? '--' : build.runMode}
      </td>
      <td className="text-light font-monospace">{isLocallyTriggered ? '--' : formatDuration(build.duration)}</td>
      <td className="font-monospace text-light">
        {isLocallyTriggered ? '--' : formatCompletedTime(build)}
      </td>
      <td>
        {canRunProdBuild && onTriggerProdBuilds && (
          <div className="d-flex gap-1">
            {/* Show Run Build button for all builds */}
            <Button
              size="sm"
              variant={runningAction === 'run' || isServerRunning ? 'primary' :
                      isRecentlyCompleted ? 'success' :
                      (runningAction !== null || isRunningBuild) ? 'outline-secondary' :
                      componentButtonVariant}
              onClick={handleTriggerProd}
              disabled={runningAction !== null || isRunningBuild || isRecentlyCompleted}
              title={build.type === 'dev-test' ?
                `Run new build for ${build.projectName}` :
                `Run new build for ${build.projectName}`}
            >
              {runningAction === 'run' || (isServerRunning && !runningAction) ? (
                <>
                  <Spinner as="span" animation="border" size="sm" className="me-1" />
                  Building...
                </>
              ) : isRecentlyCompleted ? (
                <>
                  ✅ Built
                </>
              ) : (
                <>
                  <Play size={12} className="me-1" />
                  Run Build
                </>
              )}
            </Button>

            {/* Show Retry button for all builds */}
            <Button
              size="sm"
              variant={runningAction === 'retry' ? 'primary' :
                      isRecentlyCompleted ? 'success' :
                      (runningAction !== null || isRunningBuild) ? 'outline-secondary' :
                      componentButtonVariant}
              onClick={handleRetryBuild}
              disabled={runningAction !== null || isRunningBuild || isRecentlyCompleted}
              title={`Retry build ${build.buildId}`}
            >
              {runningAction === 'retry' ? (
                <>
                  <Spinner as="span" animation="border" size="sm" className="me-1" />
                  Retrying...
                </>
              ) : isRecentlyCompleted ? (
                <>
                  ✅ Built
                </>
              ) : (
                <>
                  <RotateCcw size={12} className="me-1" />
                  Retry
                </>
              )}
            </Button>
          </div>
        )}
      </td>
    </tr>
  )
}


