import { Card, Table } from 'react-bootstrap'
import BuildRow from './BuildRow'

export default function BuildSection({ title, builds, emptyMessage }) {
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
                <th>Project</th>
                <th>Status</th>
                <th className="text-center">PR #</th>
                <th>Run Mode</th>
                <th>Duration</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {builds.map((build) => (
                <BuildRow key={build.buildId} build={build} />
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>
    </Card>
  )
}