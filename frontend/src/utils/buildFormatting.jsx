import { Badge } from 'react-bootstrap'

export const formatHotfixTooltip = (hotfixDetails, additionalFields = [], buildNumber = null) => {
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
      <div><strong>Commit Date:</strong> {date}</div>
      {buildNumber && <div><strong>Build #:</strong> {buildNumber}</div>}
      {additionalFields.map((field, index) => (
        <div key={index}><strong>{field.label}:</strong> {field.value}</div>
      ))}
      <div className="text-muted small">Direct commit (no PR)</div>
    </div>
  )
}

export const formatPRTooltip = (build, additionalFields = []) => {
  if (!build.prNumber) return null

  return (
    <div className="text-start">
      <div><strong>PR #{build.prNumber}</strong></div>
      <div><strong>Title:</strong> {build.prTitle || 'No title available'}</div>
      <div><strong>Author:</strong> {build.commitAuthor || 'Unknown'}</div>
      {build.buildNumber && <div><strong>Build #:</strong> {build.buildNumber}</div>}
      {additionalFields.map((field, index) => (
        <div key={index}><strong>{field.label}:</strong> {field.value}</div>
      ))}
      <div className="text-muted small">Pull request merge</div>
    </div>
  )
}

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

export const formatGenericTooltip = (build, additionalFields = []) => {
  if (!build) return null

  const buildTime = build.buildTimestamp ? new Date(build.buildTimestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }) : 'Unknown date'

  const commit = build.gitCommit || build.commit || 'Not available'
  const author = build.commitAuthor || 'Unknown'
  const message = build.commitMessage ? build.commitMessage.split('\n')[0] : 'Not available'
  const branch = build.sourceVersion === 'dev' || build.sourceVersion === 'refs/heads/dev' ? 'dev' : 'main'

  return (
    <div className="text-start">
      <div><strong>Commit:</strong> {commit.substring(0, 7)}</div>
      <div><strong>Author:</strong> {author}</div>
      <div><strong>Message:</strong> {message}</div>
      <div><strong>Built:</strong> {buildTime}</div>
      {build.buildNumber && <div><strong>Build #:</strong> {build.buildNumber}</div>}
      {additionalFields.map((field, index) => (
        <div key={index}><strong>{field.label}:</strong> {field.value}</div>
      ))}
      <div className="text-muted small">Branch commit</div>
    </div>
  )
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

export const isBuildOutOfDate = (build, latestMerges, explicitComponentType = null) => {
  // Determine component type - use explicit type if provided, otherwise detect from project name
  const componentType = explicitComponentType ||
                        (build.projectName?.includes('backend') ? 'backend' :
                         build.projectName?.includes('frontend') ? 'frontend' : null)

  if (!componentType) {
    return false
  }

  // Determine which branch to compare against based on build type
  const isDevBuild = build.type === 'dev-test' ||
                     build.projectName?.includes('devbranchtest') ||
                     (build.sourceVersion === 'dev' || build.sourceVersion === 'refs/heads/dev') ||
                     (build.sourceBranch === 'dev')

  // Choose the appropriate latest commit data based on build type
  const latestCommitKey = isDevBuild ? `${componentType}Dev` : componentType
  const latestCommitData = latestMerges?.[latestCommitKey]

  if (!latestCommitData) {
    return false
  }

  // Compare commit SHAs - if build commit doesn't match latest, it's out of date
  const buildCommit = build.commit || build.gitCommit
  if (buildCommit && latestCommitData?.sha) {
    const isOutOfDate = buildCommit !== latestCommitData.sha.substring(0, 7) &&
                       buildCommit !== latestCommitData.sha

    return isOutOfDate
  }

  return false
}

export const createDeploymentTooltipFields = (deployment) => {
  const additionalTooltipFields = []
  if (deployment?.deployedAt) {
    const deployedAt = new Date(deployment.deployedAt).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    })
    additionalTooltipFields.push({ label: 'Deployed', value: deployedAt })
  }
  return additionalTooltipFields
}