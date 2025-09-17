import { Badge, OverlayTrigger, Tooltip } from 'react-bootstrap'
import { getHashDisplay, formatHotfixTooltip, formatPRTooltip, formatGenericTooltip, isBuildOutOfDate } from '../utils/buildFormatting.jsx'

/**
 * Unified build display component that shows build source and git commit consistently
 * across all tables (build tables, deployment tables, pipeline tables)
 */
export default function BuildDisplay({
  build,
  className = "",
  style = {},
  additionalTooltipFields = [],
  latestMerges = {},
  showOutOfDateIndicator = true
}) {
  // Calculate if build is out of date using the utility function
  // Only check if we have valid latestMerges data and showOutOfDateIndicator is true
  const hasValidLatestMerges = latestMerges?.frontend || latestMerges?.backend
  const isOutOfDate = showOutOfDateIndicator && hasValidLatestMerges ? isBuildOutOfDate(build, latestMerges) : false

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
            overlay={<Tooltip id={`pr-tooltip-${build.buildId || build.id}`}>{formatPRTooltip(build, additionalTooltipFields)}</Tooltip>}
          >
            <span className="text-light" style={{ cursor: 'help' }}>
              #{build.prNumber}
            </span>
          </OverlayTrigger>
          <span className="text-secondary ms-2" style={{ fontSize: '0.875rem' }}>
            ({getHashDisplay(build)})
          </span>
          {isOutOfDate && (
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
        <div className="d-flex align-items-center">
          <OverlayTrigger
            placement="top"
            overlay={<Tooltip id={`hotfix-tooltip-${build.buildId || build.id}`}>{formatHotfixTooltip(hotfixDetails, additionalTooltipFields)}</Tooltip>}
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
          {isOutOfDate && (
            <span className="ms-2 text-warning" title="This build is out of date - newer commits available">
              🔺
            </span>
          )}
        </div>
      )
    }

    // Default fallback
    return (
      <div className="d-flex align-items-center">
        <span className="text-danger">
          ERROR: Unknown build type - {build.buildId || build.id}
        </span>
      </div>
    )
  }

  return renderBuildSource()
}