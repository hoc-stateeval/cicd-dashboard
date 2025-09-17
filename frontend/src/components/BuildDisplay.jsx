import { Badge, OverlayTrigger, Tooltip } from 'react-bootstrap'
import { getHashDisplay, formatHotfixTooltip, formatPRTooltip } from '../utils/buildFormatting.jsx'

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