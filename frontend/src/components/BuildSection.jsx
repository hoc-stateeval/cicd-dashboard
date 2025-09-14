import { Card, Table, Alert } from 'react-bootstrap'
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

  // Group builds by frontend and backend for Main Branch Builds
  const shouldGroupByComponent = title.includes('Main Branch')

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
          <h6 className="mb-0">
            {sectionTitle === 'backend' ? <span className="text-info">Backend Builds</span> :
             sectionTitle === 'frontend' ? <span className="text-warning">Frontend Builds</span> :
             <span className="text-light">Other Builds</span>}
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