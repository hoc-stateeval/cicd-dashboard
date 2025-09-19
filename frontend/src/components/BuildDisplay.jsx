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
  showOutOfDateIndicator = true,
  componentType = null
}) {
  // Calculate if build is out of date using the utility function
  // Only check if we have valid latestMerges data and showOutOfDateIndicator is true
  const hasValidLatestMerges = latestMerges?.frontend || latestMerges?.backend

  // Check both the build object and any matchedBuild object for hotfix info
  const hotfixDetails = build?.hotfixDetails || build?.matchedBuild?.hotfixDetails
  const sourceBranch = build?.sourceBranch || build?.matchedBuild?.sourceBranch

  const buildCommit = build.commit || build.gitCommit

  // Helper function to get the newer commit information for tooltip
  const getNewerCommitInfo = (build, latestMerges, componentType) => {
    if (!componentType || !latestMerges) return null

    // Determine which branch to compare against based on build type
    const isDevBuild = build.type === 'dev-test' ||
                       build.projectName?.includes('devbranchtest') ||
                       (build.sourceVersion === 'dev' || build.sourceVersion === 'refs/heads/dev') ||
                       (build.sourceBranch === 'dev')

    // Choose the appropriate latest commit data based on build type
    const latestCommitKey = isDevBuild ? `${componentType}Dev` : componentType

    // Try different possible data structures
    let latestCommitData = latestMerges?.[latestCommitKey]?.data?.latestCommit || // React Query structure
                          latestMerges?.[latestCommitKey]?.latestCommit ||        // Direct structure
                          latestMerges?.[latestCommitKey]                         // Simple structure


    if (!latestCommitData) return null

    return {
      shortSha: latestCommitData.shortSha || latestCommitData.sha?.substring(0, 8),
      message: latestCommitData.message?.split('\n')[0], // First line only
      author: latestCommitData.author,
      branch: isDevBuild ? 'dev' : 'main'
    }
  }

  const newerCommitInfo = getNewerCommitInfo(build, latestMerges, componentType)


  const renderBuildSource = () => {
    // PR Number
    if (build.prNumber) {
      return (
        <div className="d-flex align-items-center">
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
          {(showOutOfDateIndicator && hasValidLatestMerges && isBuildOutOfDate(build, latestMerges, componentType)) && (
            <OverlayTrigger
              placement="top"
              overlay={
                <Tooltip id={`outdated-tooltip-${build.buildId || build.id}`}>
                  <div className="text-start">
                    <div><strong>Build is out of date</strong></div>
                    {newerCommitInfo ? (
                      <>
                        <div><strong>Newer commit available:</strong></div>
                        <div><strong>Commit:</strong> {newerCommitInfo.shortSha || 'Unknown'}</div>
                        <div><strong>Author:</strong> {newerCommitInfo.author || 'Unknown'}</div>
                        <div><strong>Message:</strong> {newerCommitInfo.message || 'No message'}</div>
                        <div><strong>Branch:</strong> {newerCommitInfo.branch}</div>
                      </>
                    ) : (
                      <div><strong>Newer commits are available</strong></div>
                    )}
                    <div className="mt-1 text-warning-emphasis">Trigger a new build to get the latest changes</div>
                  </div>
                </Tooltip>
              }
            >
              <span className="ms-2 text-warning" style={{ cursor: 'help' }}>
                🔺
              </span>
            </OverlayTrigger>
          )}
        </div>
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
          {(showOutOfDateIndicator && hasValidLatestMerges && isBuildOutOfDate(build, latestMerges, componentType)) && (
            <OverlayTrigger
              placement="top"
              overlay={
                <Tooltip id={`outdated-tooltip-${build.buildId || build.id}`}>
                  <div className="text-start">
                    <div><strong>Build is out of date</strong></div>
                    {newerCommitInfo ? (
                      <>
                        <div><strong>Newer commit available:</strong></div>
                        <div><strong>Commit:</strong> {newerCommitInfo.shortSha || 'Unknown'}</div>
                        <div><strong>Author:</strong> {newerCommitInfo.author || 'Unknown'}</div>
                        <div><strong>Message:</strong> {newerCommitInfo.message || 'No message'}</div>
                        <div><strong>Branch:</strong> {newerCommitInfo.branch}</div>
                      </>
                    ) : (
                      <div><strong>Newer commits are available</strong></div>
                    )}
                    <div className="mt-1 text-warning-emphasis">Trigger a new build to get the latest changes</div>
                  </div>
                </Tooltip>
              }
            >
              <span className="ms-2 text-warning" style={{ cursor: 'help' }}>
                🔺
              </span>
            </OverlayTrigger>
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