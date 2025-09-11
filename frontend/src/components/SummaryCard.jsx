import { Activity, AlertCircle, RefreshCw } from 'lucide-react'
import { Card, Row, Col, Button, Alert, Spinner } from 'react-bootstrap'

export default function SummaryCard({ summary, onRefresh, isLoading }) {
  if (!summary) return null
  
  return (
    <Card bg="dark" border="secondary" text="white">
      <Card.Header className="d-flex justify-content-between align-items-center">
        <Card.Title className="d-flex align-items-center mb-0">
          <Activity className="me-2" size={20} />
          Build Summary
        </Card.Title>
        <Button
          variant="primary"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading}
          className="d-flex align-items-center"
        >
          {isLoading ? (
            <Spinner animation="border" size="sm" className="me-2" />
          ) : (
            <RefreshCw className="me-2" size={16} />
          )}
          Refresh
        </Button>
      </Card.Header>
      <Card.Body>
        <Row className="text-center">
          <Col xs={6} md={3}>
            <div className="h2 fw-bold text-white">{summary.totalBuilds}</div>
            <div className="small text-light">Total Builds</div>
          </Col>
          
          <Col xs={6} md={3}>
            <div className="h2 fw-bold text-info">{summary.devTestBuilds}</div>
            <div className="small text-light">Dev Tests</div>
          </Col>
          
          <Col xs={6} md={3}>
            <div className="h2 fw-bold text-success">{summary.deploymentBuilds}</div>
            <div className="small text-light">Deployments</div>
          </Col>
          
          <Col xs={6} md={3}>
            <div className={`h2 fw-bold ${summary.failedDevBuilds > 0 ? 'text-danger' : 'text-success'}`}>
              {summary.failedDevBuilds}
            </div>
            <div className="small text-light">Failed</div>
          </Col>
        </Row>

        {summary.failedDevBuilds > 0 && (
          <Alert variant="danger" className="mt-3 d-flex align-items-center">
            <AlertCircle className="me-2" size={16} />
            <span>
              {summary.failedDevBuilds} dev build{summary.failedDevBuilds !== 1 ? 's' : ''} need attention
            </span>
          </Alert>
        )}
        
        {summary.lastUpdated && (
          <div className="mt-3 text-muted text-center small">
            Last updated: {new Date(summary.lastUpdated).toLocaleString()}
          </div>
        )}
      </Card.Body>
    </Card>
  )
}