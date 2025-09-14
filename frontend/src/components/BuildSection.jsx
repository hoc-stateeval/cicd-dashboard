import { useState, useEffect } from 'react'
import { Card, Table, Alert, OverlayTrigger, Tooltip } from 'react-bootstrap'
import BuildRow from './BuildRow'


export default function BuildSection({
  title,
  builds,
  emptyMessage,
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
  // State for latest merge information
  const [latestMerges, setLatestMerges] = useState({
    backend: null,
    frontend: null
  })

  // State for commit comparison
  const [commitComparisons, setCommitComparisons] = useState({
    backend: null,
    frontend: null
  })

  // Group builds by frontend and backend for Main Branch Builds
  const shouldGroupByComponent = title.includes('Main Branch')

  // Fetch latest merge information when component mounts and for Main Branch Builds
  useEffect(() => {
    if (shouldGroupByComponent) {
      const fetchLatestMerges = async () => {
        try {
          const [backendResponse, frontendResponse] = await Promise.all([
            fetch('/api/latest-merge/backend'),
            fetch('/api/latest-merge/frontend')
          ])

          const [backendData, frontendData] = await Promise.all([
            backendResponse.ok ? backendResponse.json() : null,
            frontendResponse.ok ? frontendResponse.json() : null
          ])

          setLatestMerges({
            backend: backendData,
            frontend: frontendData
          })
        } catch (error) {
          console.error('Error fetching latest merge information:', error)
        }
      }

      const fetchCommitComparisons = async () => {
        try {
          console.log('🔍 Fetching commit comparisons...')
          const [backendResponse, frontendResponse] = await Promise.all([
            fetch('/api/commit-comparison/backend'),
            fetch('/api/commit-comparison/frontend')
          ])

          const [backendData, frontendData] = await Promise.all([
            backendResponse.ok ? backendResponse.json() : null,
            frontendResponse.ok ? frontendResponse.json() : null
          ])

          console.log('📊 Commit comparison data:', { backend: backendData, frontend: frontendData })

          setCommitComparisons({
            backend: backendData,
            frontend: frontendData
          })
        } catch (error) {
          console.error('Error fetching commit comparison:', error)
        }
      }

      // Initial fetch
      fetchLatestMerges()
      fetchCommitComparisons()

      // Set up polling every 30 seconds
      const interval = setInterval(() => {
        fetchLatestMerges()
        fetchCommitComparisons()
      }, 30000)

      // Cleanup interval on unmount
      return () => clearInterval(interval)
    }
  }, [shouldGroupByComponent])

  // Format latest merge tooltip
  const formatMergeTooltip = (mergeData) => {
    if (!mergeData) return null

    const date = new Date(mergeData.date).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })

    return (
      <div className="text-start">
        <div><strong>Latest:</strong> {mergeData.sha}</div>
        <div><strong>Author:</strong> {mergeData.author}</div>
        <div><strong>Message:</strong> {mergeData.message}</div>
        <div><strong>Date:</strong> {date}</div>
        <div className="text-muted small">Click to view on GitHub</div>
      </div>
    )
  }

  let groupedBuilds = {}
  if (shouldGroupByComponent && builds?.length) {
    builds.forEach(build => {
      const componentType = build.projectName.includes('backend') ? 'backend' :
                           build.projectName.includes('frontend') ? 'frontend' : 'other'
      if (!groupedBuilds[componentType]) {
        groupedBuilds[componentType] = []
      }
      groupedBuilds[componentType].push(build)
    })
  }

  const renderBuildTable = (sectionBuilds, sectionTitle = null) => (
    <div>
      {sectionTitle && (
        <div className="px-3 py-2 bg-secondary bg-opacity-25">
          <h6 className="mb-0 d-flex align-items-center justify-content-between">
            <span>
              {sectionTitle === 'backend' ? <span className="text-info">Backend Builds</span> :
               sectionTitle === 'frontend' ? <span className="text-warning">Frontend Builds</span> :
               <span className="text-light">Other Builds</span>}
            </span>
            <div className="d-flex gap-2">
              {latestMerges[sectionTitle] && (
                <OverlayTrigger
                  placement="top"
                  overlay={<Tooltip id={`merge-tooltip-${sectionTitle}`}>{formatMergeTooltip(latestMerges[sectionTitle])}</Tooltip>}
                >
                  <a
                    href={latestMerges[sectionTitle].url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-decoration-none"
                    style={{ cursor: 'help' }}
                  >
                    <span className="badge bg-secondary text-light">
                      Latest: {latestMerges[sectionTitle].sha}
                    </span>
                  </a>
                </OverlayTrigger>
              )}
              {commitComparisons[sectionTitle] && (
                <span className={`badge ${commitComparisons[sectionTitle].commitsAhead > 0 ? 'bg-warning text-dark' : 'bg-success text-white'}`}>
                  {commitComparisons[sectionTitle].commitsAhead > 0
                    ? `+${commitComparisons[sectionTitle].commitsAhead} commits`
                    : '✓ Up to date'
                  }
                </span>
              )}
            </div>
          </h6>
        </div>
      )}
      <Table variant="dark" striped bordered hover className="mb-0">
        <thead>
          <tr>
            <th style={{ width: '18%' }}>Project</th>
            <th className="text-center" style={{ width: '12%' }}>Deployed</th>
            <th style={{ width: '8%' }}>Status</th>
            <th className="text-center" style={{ width: '10%' }}>Source → Target</th>
            <th className="text-center" style={{ width: '7%' }}>PR #</th>
            <th style={{ width: '8%' }}>Run Mode</th>
            <th style={{ width: '7%' }}>Duration</th>
            <th style={{ width: '12%' }}>Completed</th>
            <th style={{ width: '18%' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sectionBuilds.map((build) => (
            <BuildRow
              key={build.buildId}
              build={build}
              allBuilds={allBuilds}
              onTriggerProdBuilds={onTriggerProdBuilds}
              prodBuildStatuses={prodBuildStatuses}
              buildsInProgress={buildsInProgress}
              setBuildsInProgress={setBuildsInProgress}
              buildFailures={buildFailures}
              setBuildFailures={setBuildFailures}
              recentlyCompleted={recentlyCompleted}
              setRecentlyCompleted={setRecentlyCompleted}
              startPollingBuildStatus={startPollingBuildStatus}
              deployments={deployments}
            />
          ))}
        </tbody>
      </Table>
    </div>
  )

  return (
    <Card bg="dark" border="secondary" text="white">
      <Card.Header className="bg-primary bg-opacity-15">
        <Card.Title className="d-flex align-items-center mb-0">
          {title}
        </Card.Title>
      </Card.Header>



      <Card.Body className="p-0">
        {!builds?.length ? (
          <div className="text-center py-5 text-muted">
            {emptyMessage}
          </div>
        ) : shouldGroupByComponent ? (
          <div>
            {/* Backend builds section */}
            {groupedBuilds.backend?.length > 0 && renderBuildTable(groupedBuilds.backend, 'backend')}

            {/* Frontend builds section */}
            {groupedBuilds.frontend?.length > 0 && (
              <div style={{ borderTop: groupedBuilds.backend?.length > 0 ? '1px solid rgba(255,255,255,0.2)' : 'none' }}>
                {renderBuildTable(groupedBuilds.frontend, 'frontend')}
              </div>
            )}

            {/* Other builds section (if any) */}
            {groupedBuilds.other?.length > 0 && (
              <div style={{ borderTop: (groupedBuilds.backend?.length > 0 || groupedBuilds.frontend?.length > 0) ? '1px solid rgba(255,255,255,0.2)' : 'none' }}>
                {renderBuildTable(groupedBuilds.other, 'other')}
              </div>
            )}
          </div>
        ) : (
          renderBuildTable(builds)
        )}
      </Card.Body>
    </Card>
  )
}