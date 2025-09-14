import { useState } from 'react'
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

export default function BuildRow({ build, allBuilds, onTriggerProdBuilds, prodBuildStatuses = {} }) {
  const statusVariant = statusVariants[build.status] || 'secondary'

  // State for tracking build operations
  const [buildInProgress, setBuildInProgress] = useState(false)
  const [buildPollingId, setBuildPollingId] = useState(null)

  // Build status polling function (similar to deployment polling)
  const startPollingBuildStatus = (buildId, projectName) => {
    console.log(`Starting build status polling for ${buildId}...`)
    setBuildInProgress(true)
    setBuildPollingId(buildId)

    const pollBuildStatus = async () => {
      try {
        const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/build-status/${buildId}`)

        if (!response.ok) {
          console.error('Build status polling failed:', response.status)
          return
        }

        const result = await response.json()
        console.log(`Build ${buildId} status:`, result.status)

        // Check if build is complete
        if (result.status && ['SUCCEEDED', 'FAILED', 'STOPPED', 'TIMEOUT'].includes(result.status)) {
          console.log(`Build ${buildId} completed with status: ${result.status}`)
          setBuildInProgress(false)
          setBuildPollingId(null)

          // Refresh the page to show updated build data
          setTimeout(() => {
            window.location.reload()
          }, 2000)
          return
        }

        // Continue polling if still in progress
        if (result.status && ['IN_PROGRESS', 'PENDING'].includes(result.status)) {
          setTimeout(pollBuildStatus, 15000) // Poll every 15 seconds
        } else {
          // Unknown status or polling limit reached
          console.log(`Build polling stopped for ${buildId}`)
          setBuildInProgress(false)
          setBuildPollingId(null)
        }
      } catch (error) {
        console.error('Error polling build status:', error)
        setBuildInProgress(false)
        setBuildPollingId(null)
      }
    }

    // Start initial poll after a short delay
    setTimeout(pollBuildStatus, 3000)

    // Set maximum polling time (10 minutes)
    setTimeout(() => {
      if (buildPollingId === buildId) {
        console.log(`Build polling timeout reached for ${buildId}`)
        setBuildInProgress(false)
        setBuildPollingId(null)
      }
    }, 10 * 60 * 1000)
  }

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
  const canRunProdBuild = build.type === 'production' || build.isDeployable || (build.type === 'dev-test' && build.prNumber)

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
      // For dev builds, retry the exact same build
      if (build.type === 'dev-test') {
        const prNumber = build.prNumber
        if (!prNumber) {
          alert('No PR number available to retry build')
          return
        }

        console.log(`Re-running build ${build.buildId} for ${build.projectName}...`)

        const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/retry-build`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            buildId: build.buildId,
            projectName: build.projectName,
            prNumber
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
      } else {
        // For production builds, find the latest PR number from main branch builds
        // Look for builds with the same component type (backend/frontend) that are dev→main
        const componentType = build.projectName.includes('backend') ? 'backend' :
                             build.projectName.includes('frontend') ? 'frontend' : null

        if (!componentType) {
          alert('Cannot determine component type for production build')
          return
        }

        // Find the latest dev→main build for this component type
        const demoBuilds = allBuilds
          .filter(b => b.projectName.includes(componentType) &&
                      b.projectName.includes('demo')) // demo builds represent dev→main

        console.log(`Debug: Found ${demoBuilds.length} ${componentType} demo builds:`,
                    demoBuilds.slice(0, 5).map(b => ({
                      projectName: b.projectName,
                      prNumber: b.prNumber,
                      status: b.status,
                      startTime: b.startTime
                    })))

        const mainBranchBuilds = demoBuilds
          .filter(b => b.prNumber &&
                      (b.status === 'SUCCESS' || b.status === 'SUCCEEDED'))
          .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))

        console.log(`Debug: Found ${mainBranchBuilds.length} successful ${componentType} demo builds:`,
                    mainBranchBuilds.slice(0, 3).map(b => ({
                      projectName: b.projectName,
                      prNumber: b.prNumber,
                      status: b.status,
                      startTime: b.startTime
                    })))

        const latestMainBuild = mainBranchBuilds[0]
        const prNumber = latestMainBuild?.prNumber

        if (!prNumber) {
          alert(`No recent successful ${componentType} demo build found to determine PR number`)
          return
        }

        // For all main branch builds (prod, sandbox), don't specify PR number to allow hotfix detection
        // Only demo builds should use PR numbers (they represent dev->main merges)
        const isDemoBuild = build.projectName.includes('demo');
        const requestBody = isDemoBuild ?
          { projectName: build.projectName, prNumber } : // Demo builds use PR number (dev->main)
          { projectName: build.projectName }; // All other builds (prod, sandbox) build from latest main

        console.log(`Triggering ${isDemoBuild ? 'demo' : 'main branch'} build for ${build.projectName}${isDemoBuild && prNumber ? ` using PR #${prNumber}` : ' from latest main'}...`)

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
      
      // Refresh the builds data to show the new build
      setTimeout(() => {
        if (onTriggerProdBuilds) {
          // Use existing refetch mechanism
          window.location.reload()
        }
      }, 2000)
      
    } catch (error) {
      console.error('Error triggering build:', error)
      alert(`Failed to trigger build: ${error.message}`)
    }
  }

  const handleRetryBuild = async () => {
    try {
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

      // Refresh the builds data to show the new build
      setTimeout(() => {
        if (onTriggerProdBuilds) {
          // Use existing refetch mechanism
          window.location.reload()
        }
      }, 2000)
      
    } catch (error) {
      console.error('Error retrying build:', error)
      alert(`Failed to retry build: ${error.message}`)
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
      <td>
        <Badge bg={statusVariant}>{build.status}</Badge>
      </td>
      <td className="text-center">
        <span className="text-light">
          {build.prNumber && build.type === 'dev-test' ?
            (build.sourceBranch ? `${build.sourceBranch}→dev` : 'feature→dev') :
           (build.sourceVersion === 'main' || build.sourceVersion === 'refs/heads/main') ? 'main→main' :
           build.prNumber ? 'dev→main' :
           build.hotfixDetails?.isHotfix ? 'hotfix→main' :
           '--'}
        </span>
      </td>
      <td className="text-center">
        <div className="d-flex flex-column align-items-center justify-content-center">
          {build.prNumber ? (
            <span className="text-light">
              #{build.prNumber} <span className="text-secondary small font-monospace">({getHashDisplay(build)})</span>
            </span>
          ) : build.hotfixDetails?.isHotfix ? (
            <div className="d-flex align-items-center">
              <OverlayTrigger
                placement="top"
                overlay={<Tooltip id={`hotfix-tooltip-${build.buildId}`}>{formatHotfixTooltip(build.hotfixDetails)}</Tooltip>}
              >
                <Badge bg="warning" text="dark" className="me-1" style={{ cursor: 'help' }}>
                  hotfix
                </Badge>
              </OverlayTrigger>
              <span className="text-secondary small font-monospace">({getHashDisplay(build)})</span>
            </div>
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
        {build.runMode}
      </td>
      <td className="text-light font-monospace">{formatDuration(build.duration)}</td>
      <td className="font-monospace text-light">
        {formatCompletedTime(build)}
      </td>
      <td>
        {canRunProdBuild && onTriggerProdBuilds && (
          <div className="d-flex gap-1">
            {/* Show Run Build button for all builds */}
            <Button
              size="sm"
              variant={buildInProgress ? 'primary' : componentButtonVariant}
              onClick={handleTriggerProd}
              disabled={buildInProgress}
              title={build.type === 'dev-test' ?
                `Run new build for ${build.projectName}` :
                `Run new build for ${build.projectName}`}
            >
              {buildInProgress ? (
                <>
                  <Spinner as="span" animation="border" size="sm" className="me-1" />
                  Building...
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
              variant={buildInProgress ? 'primary' : componentButtonVariant}
              onClick={handleRetryBuild}
              disabled={buildInProgress}
              title={`Retry build ${build.buildId}`}
            >
              {buildInProgress ? (
                <>
                  <Spinner as="span" animation="border" size="sm" className="me-1" />
                  Retrying...
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


