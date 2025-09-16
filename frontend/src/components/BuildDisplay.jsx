import { Badge, OverlayTrigger, Tooltip } from 'react-bootstrap'
import { getHashDisplay } from '../utils/buildFormatting.jsx'

const formatHotfixTooltip = (hotfixDetails) => {
  if (!hotfixDetails) return null

  const message = hotfixDetails.message.split('\n')[0] // First line only
  const date = hotfixDetails.date ? new Date(hotfixDetails.date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }) : 'Unknown date'

  return (
    <div className="text-start">
      <div><strong>Commit:</strong> {hotfixDetails.sha?.substring(0, 7) || 'unknown'}</div>
      <div><strong>Author:</strong> {hotfixDetails.author?.name || 'Unknown'}</div>
      <div><strong>Message:</strong> {message}</div>
      <div><strong>Date:</strong> {date}</div>
      <div className="text-muted small">Direct commit (no PR)</div>
    </div>
  )
}

const formatPRTooltip = (build) => {
  if (!build.prNumber) return null

  return (
    <div className="text-start">
      <div><strong>PR #{build.prNumber}</strong></div>
      <div><strong>Title:</strong> {build.prTitle || 'No title available'}</div>
      <div><strong>Author:</strong> {build.commitAuthor || 'Unknown'}</div>
      <div><strong>Branch:</strong> {build.sourceBranch || 'unknown'} → {build.targetBranch || 'unknown'}</div>
      <div className="text-muted small">Pull request merge</div>
    </div>
  )
}

/**
 * Unified build display component that shows build source and git commit consistently
 * across all tables (build tables, deployment tables, pipeline tables)
 */
export default function BuildDisplay({
  build,
  showRedIndicator = false,
  isOutOfDate = false,
  className = "",
  style = {}
}) {
  // Check both the build object and any matchedBuild object for hotfix info
  const hotfixDetails = build?.hotfixDetails || build?.matchedBuild?.hotfixDetails
  const sourceBranch = build?.sourceBranch || build?.matchedBuild?.sourceBranch

  const renderBuildSource = () => {
    // PR Number
    if (build.prNumber) {
      return (
        <>
          <OverlayTrigger
            placement="top"
            overlay={<Tooltip id={`pr-tooltip-${build.buildId || build.id}`}>{formatPRTooltip(build)}</Tooltip>}
          >
            <span className="text-light" style={{ cursor: 'help' }}>
              #{build.prNumber}
            </span>
          </OverlayTrigger>
          <span className="text-secondary ms-2" style={{ fontSize: '0.875rem' }}>
            ({getHashDisplay(build)})
          </span>
          {showRedIndicator && isOutOfDate && (
            <span className="ms-2 text-warning" title="This build is out of date - newer commits available">
              🔺
            </span>
          )}
        </>
      )
    }

    // Hotfix
    if (hotfixDetails?.isHotfix) {
      return (
        <>
          <OverlayTrigger
            placement="top"
            overlay={<Tooltip id={`hotfix-tooltip-${build.buildId || build.id}`}>{formatHotfixTooltip(hotfixDetails)}</Tooltip>}
          >
            <Badge
              bg={sourceBranch === 'dev' ? "info" : "warning"}
              text="dark"
              className="me-1"
              style={{ cursor: 'help' }}
            >
              hotfix
            </Badge>
          </OverlayTrigger>
          <span className="text-secondary" style={{ fontSize: '0.875rem' }}>
            ({getHashDisplay(build)})
          </span>
        </>
      )
    }

    // Dev branch
    if (build.sourceVersion === 'dev' || build.sourceVersion === 'refs/heads/dev') {
      return (
        <>
          <span className="text-light">
            dev
          </span>
          <span className="text-secondary ms-2" style={{ fontSize: '0.875rem' }}>
            ({getHashDisplay(build)})
          </span>
          {showRedIndicator && isOutOfDate && (
            <span className="ms-2 text-warning" title="This build is out of date - newer commits available">
              🔺
            </span>
          )}
        </>
      )
    }

    // Main branch or default
    return (
      <div className="d-flex align-items-center">
        <span className="text-light">
          main
        </span>
        <span className="text-secondary ms-2" style={{ fontSize: '0.875rem' }}>
          ({getHashDisplay(build)})
        </span>
        {showRedIndicator && isOutOfDate && (
          <span className="ms-2 text-warning" title="This build is out of date - newer commits available">
            🔺
          </span>
        )}
      </div>
    )
  }

  return renderBuildSource()
}