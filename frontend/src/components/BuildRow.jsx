import { Play, RotateCcw, AlertTriangle } from 'lucide-react'
import { Badge, Button } from 'react-bootstrap'

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

export default function BuildRow({ build, allBuilds, onTriggerProdBuilds, prodBuildStatuses = {} }) {
  const statusVariant = statusVariants[build.status] || 'secondary'

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
      const prNumber = build.prNumber
      if (!prNumber) {
        alert('No PR number available to trigger build')
        return
      }
      
      // For dev builds, retry the exact same build; for deployment builds, trigger production version
      if (build.type === 'dev-test') {
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
      } else {
        // For deployment builds, trigger production builds as before
        console.log(`Triggering production builds for PR #${prNumber}...`)
        
        const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/trigger-single-build`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ projectName: build.projectName, prNumber })
        })
        
        if (!response.ok) {
          throw new Error(`Failed to trigger build: ${response.status}`)
        }
        
        const result = await response.json()
        console.log('Build triggered successfully:', result)
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
           build.prNumber ? 'dev→main' : 
           (build.sourceVersion === 'main' || build.sourceVersion === 'refs/heads/main') ? 'main→main' : 
           '--'}
        </span>
      </td>
      <td className="text-center">
        <div className="d-flex flex-column align-items-center justify-content-center">
          {build.prNumber ? (
            <span className="text-light">
              #{build.prNumber} <span className="text-secondary small font-monospace">({getHashDisplay(build)})</span>
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
        {build.runMode}
      </td>
      <td className="text-light font-monospace">{formatDuration(build.duration)}</td>
      <td className="font-monospace text-light">
        {formatCompletedTime(build)}
      </td>
      <td>
        {canRunProdBuild && onTriggerProdBuilds && (
          <div className="d-flex gap-1">
            {/* For dev builds, show only Retry button */}
            {build.type === 'dev-test' ? (
              <Button
                size="sm"
                variant={componentButtonVariant}
                onClick={handleTriggerProd}
                title={`Retry ${build.projectName} for PR #${build.prNumber}`}
              >
                <RotateCcw size={12} className="me-1" />
                Retry
              </Button>
            ) : (
              /* For deployment builds, show Run Build for prod and backend demo projects (manual), Retry for all */
              <>
                {(isProdBuild || isBackendDemoBuild) && (
                  <Button
                    size="sm"
                    variant={componentButtonVariant}
                    onClick={handleTriggerProd}
                    title={`Run new build for ${build.projectName}`}
                  >
                    <Play size={12} className="me-1" />
                    Run Build
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={componentButtonVariant}
                  onClick={handleRetryBuild}
                  title={`Retry failed build ${build.buildId}`}
                >
                  <RotateCcw size={12} className="me-1" />
                  Retry
                </Button>
              </>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}


