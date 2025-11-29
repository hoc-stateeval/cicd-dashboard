import { Card, Table } from 'react-bootstrap'
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
  startPollingBuildStatus
}) {
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


  const renderBuildTable = (sectionBuilds) => (
    <Table variant="dark" striped bordered hover className="mb-0">
        <thead>
          <tr>
            <th style={{ width: '18%' }}>Project</th>
            <th style={{ width: '8%' }}>Status</th>
            <th className="text-center" style={{ width: '10%' }}>Source → Target</th>
            <th style={{ width: '14%' }}>PR #</th>
            <th style={{ width: '8%' }}>Duration</th>
            <th style={{ width: '14%' }}>Completed</th>
            <th style={{ width: '28%' }}>Actions</th>
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
              latestMerges={latestMerges}
            />
          ))}
        </tbody>
      </Table>
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
        ) : (
          renderBuildTable(builds)
        )}
      </Card.Body>
    </Card>
  )
}