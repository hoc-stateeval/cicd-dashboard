import { Card, Table } from 'react-bootstrap'
import BuildRow from './BuildRow'

export default function BuildSection({ title, builds, emptyMessage, allBuilds, onTriggerProdBuilds }) {
  return (
    <Card bg="dark" border="secondary" text="white">
      <Card.Header>
        <Card.Title className="d-flex align-items-center mb-0">
          {title}
          <span className="text-muted ms-2 fw-normal small">
            ({builds?.length || 0})
          </span>
        </Card.Title>
      </Card.Header>
      
      <Card.Body className="p-0">
        {!builds?.length ? (
          <div className="text-center py-5 text-muted">
            {emptyMessage}
          </div>
        ) : (
          <Table variant="dark" striped bordered hover className="mb-0">
            <thead>
              <tr>
                <th style={{ width: '20%' }}>Project</th>
                <th style={{ width: '10%' }}>Status</th>
                <th className="text-center" style={{ width: '12%' }}>Source → Target</th>
                <th className="text-center" style={{ width: '8%' }}>PR #</th>
                <th style={{ width: '10%' }}>Run Mode</th>
                <th style={{ width: '8%' }}>Duration</th>
                <th style={{ width: '17%' }}>Completed</th>
                <th style={{ width: '15%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {builds.map((build) => (
                <BuildRow 
                  key={build.buildId} 
                  build={build} 
                  allBuilds={allBuilds}
                  onTriggerProdBuilds={onTriggerProdBuilds}
                />
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>
    </Card>
  )
}