import { AlertCircle, Loader2 } from 'lucide-react'
import { Container, Row, Col, Alert, Button, Spinner } from 'react-bootstrap'
import { useState, useEffect } from 'react'
import { useBuilds } from './hooks/useBuilds'
import SummaryCard from './components/SummaryCard'
import BuildSection from './components/BuildSection'
import DeploymentStatus from './components/DeploymentStatus'

function App() {
  const { data: buildData, isLoading, error, refetch } = useBuilds()

  // Debug logging for unknown builds
  useEffect(() => {
    if (buildData) {
    }
  }, [buildData])

  // Global build state management - similar to deployment state
  const [buildsInProgress, setBuildsInProgress] = useState(new Set())
  const [buildFailures, setBuildFailures] = useState(new Map())
  const [recentlyCompleted, setRecentlyCompleted] = useState(new Set())

  // Build status polling function
  const startPollingBuildStatus = (buildId, projectName) => {

    const pollInterval = 15000 // Poll every 15 seconds
    const maxPolls = 100 // Maximum 25 minutes of polling (100 × 15s = 1500s = 25 min)
    let pollCount = 0

    // Ensure buildId includes project name format (project:uuid) for AWS API
    const fullBuildId = buildId.includes(':') ? buildId : `${projectName}:${buildId}`
    // Extract just the UUID part for consistent buildKey format
    const cleanBuildId = buildId.includes(':') ? buildId.split(':')[1] : buildId
    const buildKey = `${projectName}-${cleanBuildId}`


    const poll = async () => {
      try {
        pollCount++

        const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/build-status/${encodeURIComponent(fullBuildId)}`)

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const result = await response.json()


        // Check if build is complete
        if (result.status && ['SUCCEEDED', 'FAILED', 'STOPPED', 'TIMEOUT'].includes(result.status)) {
          // Clear build progress
          setBuildsInProgress(prev => {
            const newSet = new Set(prev)
            newSet.delete(buildKey)
            return newSet
          })

          // Handle final status
          if (result.status === 'SUCCEEDED') {

            // Add to recently completed to prevent double-clicks
            setRecentlyCompleted(prev => new Set([...prev, buildKey]))

            // Clear recently completed after 10 seconds
            setTimeout(() => {
              setRecentlyCompleted(prev => {
                const newSet = new Set(prev)
                newSet.delete(buildKey)
                return newSet
              })
            }, 10000)

            // Refresh the builds data to show updated status
            setTimeout(() => {
              refetch()
            }, 2000)
          } else {
            // Record failure
            setBuildFailures(prev => {
              const newMap = new Map(prev)
              newMap.set(buildKey, {
                buildId,
                timestamp: Date.now(),
                reason: `Build ${result.status.toLowerCase()}`
              })
              return newMap
            })
          }

          return // Stop polling
        }

        // Continue polling if not complete and haven't exceeded max polls
        if (pollCount < maxPolls && result.status && ['IN_PROGRESS', 'PENDING'].includes(result.status)) {
          setTimeout(poll, pollInterval)
        } else {
          // Timeout or unknown status - clear progress and record failure
          setBuildsInProgress(prev => {
            const newSet = new Set(prev)
            newSet.delete(buildKey)
            return newSet
          })
          setBuildFailures(prev => {
            const newMap = new Map(prev)
            newMap.set(buildKey, {
              buildId,
              timestamp: Date.now(),
              reason: 'Build polling timeout'
            })
            return newMap
          })
        }

      } catch (error) {
        console.error(`Error polling build status for ${fullBuildId}:`, error)

        // On error, retry a few times, then give up
        if (pollCount < 5) {
          setTimeout(poll, pollInterval)
        } else {
          // Clear progress on repeated errors
          setBuildsInProgress(prev => {
            const newSet = new Set(prev)
            newSet.delete(buildKey)
            return newSet
          })
        }
      }
    }

    // Start polling after a short delay
    setTimeout(poll, 3000)
  }


  if (isLoading) {
    return (
      <div className="min-vh-100 bg-dark d-flex align-items-center justify-content-center">
        <div className="d-flex align-items-center text-white">
          <Spinner animation="border" role="status" className="me-3" />
          <span>Loading build data...</span>
        </div>
      </div>
    )
  }

  if (error) {
    const isRateLimit = error.message && (
      error.message.includes('Rate exceeded') ||
      error.message.includes('rate limit') ||
      error.message.includes('429')
    )

    return (
      <div className="min-vh-100 bg-dark d-flex align-items-center justify-content-center p-4">
        <Alert variant={isRateLimit ? "warning" : "danger"} className="w-100" style={{ maxWidth: '500px' }}>
          <Alert.Heading className="d-flex align-items-center">
            <AlertCircle className="me-2" size={24} />
            {isRateLimit ? 'API Rate Limit Exceeded' : 'Connection Error'}
          </Alert.Heading>
          {isRateLimit ? (
            <>
              <p>The server is temporarily experiencing API rate limits due to high data volume. This may cause temporary service errors.</p>
              <ul className="small mb-3">
                <li>The system is making many API requests simultaneously</li>
                <li>External APIs limit request rates to prevent service overload</li>
                <li>Data may be incomplete or stale until rate limits reset</li>
              </ul>
              <p className="small text-muted">Try refreshing in a few minutes, or contact your administrator to implement rate limiting controls.</p>
            </>
          ) : (
            <p>{error.message || 'Failed to load build data'}</p>
          )}
        </Alert>
      </div>
    )
  }

  const { devBuilds = [], deploymentBuilds = [], mainTestBuilds = [], unknownBuilds = [], summary, deployments = [] } = buildData || {}

  return (
    <div className="min-vh-100 bg-dark">
      <Container fluid className="py-4">
        {/* Header */}
        <Row className="text-center py-5">
          <Col>
            <h1 className="display-4 fw-bold text-white mb-3">CI/CD Dashboard</h1>
            <p className="text-muted">
              Branch-focused build status for {summary?.totalBuilds || 0} recent builds
            </p>
          </Col>
        </Row>



        {/* Main Deployment Targets Section */}
        <Row className="mb-5">
          <Col>
            <DeploymentStatus deployments={deployments} refetch={refetch} deploymentBuilds={deploymentBuilds} />
          </Col>
        </Row>

        {/* Deployment Builds Section */}
        <Row className="mb-5">
          <Col>
            <BuildSection
              title="🚀 Main Branch Builds - For Deployment"
              builds={deploymentBuilds}
              emptyMessage="No recent deployment builds found. These are builds that create deployable artifacts."
              allBuilds={[...deploymentBuilds, ...devBuilds]}
              buildsInProgress={buildsInProgress}
              setBuildsInProgress={setBuildsInProgress}
              buildFailures={buildFailures}
              setBuildFailures={setBuildFailures}
              recentlyCompleted={recentlyCompleted}
              setRecentlyCompleted={setRecentlyCompleted}
              startPollingBuildStatus={startPollingBuildStatus}
              deployments={deployments}
            />
          </Col>
        </Row>

        {/* Main Test Builds Section */}
        <Row className="mb-5">
          <Col>
            <BuildSection
              title="🧪 Main Branch Builds - Test Only"
              builds={mainTestBuilds}
              emptyMessage="No recent main branch test builds found. These are test-only builds that run on main branch but are not deployable."
              allBuilds={[...deploymentBuilds, ...mainTestBuilds, ...devBuilds]}
              buildsInProgress={buildsInProgress}
              setBuildsInProgress={setBuildsInProgress}
              buildFailures={buildFailures}
              setBuildFailures={setBuildFailures}
              recentlyCompleted={recentlyCompleted}
              setRecentlyCompleted={setRecentlyCompleted}
              startPollingBuildStatus={startPollingBuildStatus}
            />
          </Col>
        </Row>

        {/* Dev Builds Section */}
        <Row className="mb-5">
          <Col>
            <BuildSection
              title="🧪 Dev Branch Builds - Test Only"
              builds={devBuilds}
              emptyMessage="No recent dev builds found. Dev builds are created when feature branches are merged to dev."
              allBuilds={[...deploymentBuilds, ...devBuilds]}
              buildsInProgress={buildsInProgress}
              setBuildsInProgress={setBuildsInProgress}
              buildFailures={buildFailures}
              setBuildFailures={setBuildFailures}
              recentlyCompleted={recentlyCompleted}
              setRecentlyCompleted={setRecentlyCompleted}
              startPollingBuildStatus={startPollingBuildStatus}
            />
          </Col>
        </Row>

        {/* Unknown Builds Section */}
        {unknownBuilds.length > 0 && (
          <Row className="mb-5">
            <Col>
              <BuildSection
                title="❓ Unknown Builds - Unable to Classify"
                builds={unknownBuilds}
                emptyMessage="No unknown builds found."
                allBuilds={[...deploymentBuilds, ...mainTestBuilds, ...devBuilds, ...unknownBuilds]}
                buildsInProgress={buildsInProgress}
                setBuildsInProgress={setBuildsInProgress}
                buildFailures={buildFailures}
                setBuildFailures={setBuildFailures}
                recentlyCompleted={recentlyCompleted}
                setRecentlyCompleted={setRecentlyCompleted}
                startPollingBuildStatus={startPollingBuildStatus}
              />
            </Col>
          </Row>
        )}

        {/* Footer */}
        <Row className="text-center py-4">
          <Col>
            <p className="text-muted small">
              Auto-refreshes every 30 seconds • Last update: {summary?.lastUpdated ? 
                new Date(summary.lastUpdated).toLocaleTimeString() : 'Never'}
            </p>
          </Col>
        </Row>
      </Container>
    </div>
  )
}

export default App