import { Badge } from 'react-bootstrap'

export const getHashDisplay = (build) => {
  // Check for git commit in deployment objects
  if (build?.gitCommit) {
    return build.gitCommit.substring(0, 7)
  }
  // Check for git commit in build objects (for matchedBuild cases)
  if (build?.commit) {
    return build.commit.substring(0, 7)
  }
  return 'NA'
}

export const formatBuildSource = (build) => {
  // Use same logic as BuildRow.jsx for consistent hotfix detection
  if (build.prNumber) {
    return `PR#${build.prNumber}`
  }

  // Check both the deployment object and any matchedBuild object for hotfix info
  const hotfixDetails = build.hotfixDetails || build.matchedBuild?.hotfixDetails
  const sourceBranch = build.sourceBranch || build.matchedBuild?.sourceBranch

  if (hotfixDetails?.isHotfix) {
    // Return JSX Badge component like BuildRow.jsx does
    return (
      <Badge
        bg={sourceBranch === 'dev' ? "info" : "warning"}
        text="dark"
        className="me-1"
        style={{ cursor: 'help', fontSize: 'inherit' }}
      >
        hotfix
      </Badge>
    )
  }
  return 'main'
}