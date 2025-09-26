import { useState } from 'react'
import { Card, Table, Alert, OverlayTrigger, Tooltip } from 'react-bootstrap'
import BuildRow from './BuildRow'
import { useLatestMerges } from '../hooks/useLatestMerge'


export default function BuildSection({
  title,
  builds,
  emptyMessage,
  allBuilds,
  buildsInProgress,
  setBuildsInProgress,
  buildFailures,
  setBuildFailures,
  recentlyCompleted,
  setRecentlyCompleted,
  startPollingBuildStatus,
  deployments = []
}) {
  // Group builds by frontend and backend for Main Branch Builds - For Deployment only
  const shouldGroupByComponent = title.includes('Main Branch') && title.includes('For Deployment')

  // Fetch latest merge information for Main Branch builds and Dev Branch builds
  const shouldFetchLatestMerges = title.includes('Main Branch') || title.includes('Dev Branch')

  // Use React Query for latest merge data
  const latestMergeQuery = useLatestMerges()
  const latestMerges = shouldFetchLatestMerges ? {
    backend: latestMergeQuery.backend.data,
    frontend: latestMergeQuery.frontend.data,
    backendDev: latestMergeQuery.backendDev.data,
    frontendDev: latestMergeQuery.frontendDev.data
  } : { backend: null, frontend: null, backendDev: null, frontendDev: null }


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
              {sectionTitle === 'test' ? <span className="text-success">Test Builds</span> :
               sectionTitle === 'backend' ? <span className="text-info">Backend Builds</span> :
               sectionTitle === 'frontend' ? <span className="text-warning">Frontend Builds</span> :
               <span className="text-light">Other Builds</span>}
            </span>
            <div className="d-flex gap-2">
            </div>
          </h6>
        </div>
      )}
      <Table variant="dark" striped bordered hover className="mb-0">
        <thead>
          <tr>
            <th style={{ width: '13.5%' }}>Project</th>
            <th className="text-center" style={{ width: '13.2%' }}>Deployed</th>
            <th style={{ width: '8%' }}>Status</th>
            <th className="text-center" style={{ width: '12%' }}>Source → Target</th>
            <th style={{ width: '12%' }}>PR #</th>
            <th style={{ width: '8%' }}>Duration</th>
            <th style={{ width: '12%' }}>Completed</th>
            <th style={{ width: '15%' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sectionBuilds.map((build) => (
            <BuildRow
              key={build.buildId}
              build={build}
              allBuilds={allBuilds}
              buildsInProgress={buildsInProgress}
              setBuildsInProgress={setBuildsInProgress}
              buildFailures={buildFailures}
              setBuildFailures={setBuildFailures}
              recentlyCompleted={recentlyCompleted}
              setRecentlyCompleted={setRecentlyCompleted}
              startPollingBuildStatus={startPollingBuildStatus}
              deployments={deployments}
              latestMerges={latestMerges}
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