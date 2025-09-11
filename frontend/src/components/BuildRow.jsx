import { CheckCircle, XCircle, Clock } from 'lucide-react'
import { Badge } from 'react-bootstrap'

const statusIcons = {
  SUCCESS: CheckCircle,
  SUCCEEDED: CheckCircle,
  FAILED: XCircle,
  IN_PROGRESS: Clock,
  RUNNING: Clock
}

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

export default function BuildRow({ build }) {
  const StatusIcon = statusIcons[build.status] || Clock
  const statusVariant = statusVariants[build.status] || 'secondary'
  
  return (
    <tr>
      <td className="fw-medium">{build.projectName}</td>
      <td>
        <div className="d-flex align-items-center">
          <StatusIcon className="me-2" size={16} />
          <Badge bg={statusVariant}>{build.status}</Badge>
        </div>
      </td>
      <td className="text-center">
        {build.prNumber ? (
          <span className="text-light">#{build.prNumber}</span>
        ) : (
          <span className="text-light">--</span>
        )}
      </td>
      <td className="text-light">
        {build.runMode}
      </td>
      <td className="text-light font-monospace">{formatDuration(build.duration)}</td>
      <td className="text-light font-monospace">{formatTime(build.startTime)}</td>
    </tr>
  )
}