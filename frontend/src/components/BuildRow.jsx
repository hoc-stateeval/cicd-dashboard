import { Play, RotateCcw } from 'lucide-react'
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
  // Use endTime if available, otherwise fall back to startTime
  const timestamp = build.endTime || build.startTime
  return formatTime(timestamp)
}

export default function BuildRow({ build, allBuilds, onTriggerProdBuilds }) {
  const statusVariant = statusVariants[build.status] || 'secondary'
  
  // Check if this is a deployment build that can be triggered/re-triggered
  // Show button on all deployment builds (prod, demo, sandbox) so they can be re-run if needed
  const isProdBuild = build.projectName.includes('prod')
  const hasNewerBuilds = isProdBuild && allBuilds && hasNewerSuccessfulDemoSandboxBuilds(build, allBuilds)
  const canRunProdBuild = build.type === 'production' || build.isDeployable || (build.type === 'dev-test' && build.prNumber)
  
  
  const handleTriggerProd = async () => {
    try {
      const prNumber = build.prNumber || getLatestSuccessfulPRNumber(build, allBuilds)
      if (!prNumber) {
        alert('No PR number available to trigger build')
        return
      }
      
      // For dev builds, retry the exact same build; for deployment builds, trigger production version
      if (build.type === 'dev-test') {
        console.log(`Re-running build ${build.buildId} for ${build.projectName}...`)
        
        const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3011'}/retry-build`, {
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
        
        const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3011'}/trigger-single-build`, {
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
      
      const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3011'}/retry-build`, {
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
      <td className="fw-medium">{build.projectName}</td>
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
        <div className="d-flex align-items-center justify-content-center">
          {build.prNumber ? (
            <span className="text-light">#{build.prNumber}</span>
          ) : build.sourceVersion === 'main' || build.sourceVersion === 'refs/heads/main' ? (
            <span className="text-light">main</span>
          ) : (
            <span className="text-light">--</span>
          )}
        </div>
      </td>
      <td className="text-light">
        {build.runMode}
      </td>
      <td className="text-light font-monospace">{formatDuration(build.duration)}</td>
      <td className={`font-monospace ${hasNewerBuilds ? 'text-warning' : 'text-light'}`}>
        {formatCompletedTime(build)}
        {hasNewerBuilds && (
          <span className="ms-2" title="Build is outdated - newer builds available">
            ⚠️
          </span>
        )}
      </td>
      <td>
        {canRunProdBuild && onTriggerProdBuilds && (
          <div className="d-flex gap-1">
            {/* For dev builds, show only Retry button */}
            {build.type === 'dev-test' ? (
              <Button 
                size="sm" 
                variant="outline-primary" 
                onClick={handleTriggerProd}
                title={`Retry ${build.projectName} for PR #${build.prNumber}`}
              >
                <RotateCcw size={12} className="me-1" />
                Retry
              </Button>
            ) : (
              /* For deployment builds, show Run Build only for prod projects (manual), Retry for all */
              <>
                {isProdBuild && (
                  <Button 
                    size="sm" 
                    variant="outline-primary" 
                    onClick={handleTriggerProd}
                    title={`Run new build for ${build.projectName}`}
                  >
                    <Play size={12} className="me-1" />
                    Run Build
                  </Button>
                )}
                <Button 
                  size="sm" 
                  variant="outline-secondary" 
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

// Helper function to check if there are newer successful demo/sandbox builds for the same component
function hasNewerSuccessfulDemoSandboxBuilds(prodBuild, allBuilds) {
  // Extract component type from prod build name (backend or frontend)
  const componentType = prodBuild.projectName.includes('backend') ? 'backend' : 'frontend'
  
  // Get completion time for prod build (endTime if available, otherwise startTime)
  const prodCompletionTime = prodBuild.endTime || prodBuild.startTime
  
  return allBuilds.some(build => {
    // Check if this is a demo/sandbox build for the same component
    const isSameComponent = build.projectName.includes(componentType) && 
      (build.projectName.includes('sandbox') || build.projectName.includes('demo'))
    
    // Get completion time for this build (endTime if available, otherwise startTime)
    const buildCompletionTime = build.endTime || build.startTime
    
    // Check if it's successful, has PR number, and completed after the prod build
    return isSameComponent &&
      build.status === 'SUCCEEDED' &&
      build.prNumber &&
      new Date(buildCompletionTime) > new Date(prodCompletionTime)
  })
}

// Helper function to get the most recent successful PR number from demo/sandbox builds for the same component
function getLatestSuccessfulPRNumber(prodBuild, allBuilds) {
  // Extract component type from prod build name (backend or frontend)
  const componentType = prodBuild.projectName.includes('backend') ? 'backend' : 'frontend'
  
  // Get completion time for prod build (endTime if available, otherwise startTime)
  const prodCompletionTime = prodBuild.endTime || prodBuild.startTime
  
  const successfulBuilds = allBuilds.filter(build => {
    // Check if this is a demo/sandbox build for the same component
    const isSameComponent = build.projectName.includes(componentType) && 
      (build.projectName.includes('sandbox') || build.projectName.includes('demo'))
    
    // Get completion time for this build (endTime if available, otherwise startTime)
    const buildCompletionTime = build.endTime || build.startTime
    
    return isSameComponent &&
      build.status === 'SUCCEEDED' &&
      build.prNumber &&
      new Date(buildCompletionTime) > new Date(prodCompletionTime) // Only newer builds
  })
  
  if (successfulBuilds.length === 0) return null
  
  // Sort by completion time (most recent first) and return the PR number
  successfulBuilds.sort((a, b) => {
    const aCompletionTime = a.endTime || a.startTime
    const bCompletionTime = b.endTime || b.startTime
    return new Date(bCompletionTime) - new Date(aCompletionTime)
  })
  return successfulBuilds[0].prNumber
}

