import { AlertCircle, Loader2 } from 'lucide-react'
import { Container, Row, Col, Alert, Button, Spinner } from 'react-bootstrap'
import { useBuilds } from './hooks/useBuilds'
import SummaryCard from './components/SummaryCard'
import BuildSection from './components/BuildSection'
import DeploymentStatus from './components/DeploymentStatus'

function App() {
  const { data: buildData, isLoading, error, refetch } = useBuilds()


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
    return (
      <div className="min-vh-100 bg-dark d-flex align-items-center justify-content-center p-4">
        <Alert variant="danger" className="w-100" style={{ maxWidth: '400px' }}>
          <Alert.Heading className="d-flex align-items-center">
            <AlertCircle className="me-2" size={24} />
            Connection Error
          </Alert.Heading>
          <p>{error.message || 'Failed to load build data'}</p>
          <Button variant="outline-danger" onClick={() => refetch()} className="w-100">
            Retry
          </Button>
        </Alert>
      </div>
    )
  }

  const { devBuilds = [], deploymentBuilds = [], summary, deployments = [] } = buildData || {}

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
        <Row className="mb-4">
          <Col>
            <DeploymentStatus deployments={deployments} />
          </Col>
        </Row>

        {/* Deployment Builds Section */}
        <Row className="mb-4">
          <Col>
            <BuildSection
              title="🚀 Deployment Builds"
              builds={deploymentBuilds}
              emptyMessage="No recent deployment builds found. These are builds that create deployable artifacts."
            />
          </Col>
        </Row>

        {/* Dev Builds Section */}
        <Row className="mb-4">
          <Col>
            <BuildSection
              title="🧪 Dev Testing Builds"
              builds={devBuilds}
              emptyMessage="No recent dev builds found. Dev builds are created when feature branches are merged to dev."
            />
          </Col>
        </Row>

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