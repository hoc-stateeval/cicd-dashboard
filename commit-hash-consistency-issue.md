# CodeBuild Commit Hash Inconsistency Issue

## Problem Summary

Our CI/CD pipeline environments are showing different commit hashes for the same PR number, causing confusion in the dashboard and potentially deploying inconsistent code versions.

## Root Cause

Different CodeBuild projects are using different webhook event triggers, which reference different commits from the same GitHub PR:

- **PULL_REQUEST_CREATED/UPDATED events**: Use `head.sha` (the feature branch commit)
- **PULL_REQUEST_MERGED events**: Use `merge_commit_sha` (the actual merge commit on main)

## Current Behavior

**Example from PR #208:**
- `eval-frontend-prod`: Shows commit `4b1b437` (correct merge commit)
- `eval-frontend-demo`: Shows commit `0c8f966` (incorrect head commit from PR #207)
- `eval-frontend-sandbox`: Shows commit `0c8f966` (incorrect head commit from PR #207)

This happens because demo/sandbox environments only trigger on PR creation (using head commit) but don't rebuild when the PR is actually merged (which would use the merge commit).

## Why This Matters

### 1. **Dashboard Confusion**
- Same PR number displays different commit hashes across environments
- Difficult to verify what code is actually deployed where
- "Needs Build" indicators show incorrectly

### 2. **Code Version Inconsistency**
- **Feature branch commit** (`head.sha`): Code as it existed before merging
- **Merge commit** (`merge_commit_sha`): Final code including merge conflict resolutions and any additional commits

### 3. **Potential Deployment Issues**
If there were merge conflicts resolved during the PR merge:
- Environments using `head.sha` would deploy the pre-merge code (missing conflict resolutions)
- Environments using `merge_commit_sha` would deploy the post-merge code (including conflict resolutions)
- This could lead to different behavior between environments

### 4. **Docker Image Tagging**
Our Docker images are tagged with the commit hash from `resolvedSourceVersion`. If environments have different commit hashes, they're potentially running different Docker images even for the same PR.

## Recommended Solution

### Branch-Specific Webhook Configuration

**For Main Branch Deployments (Production):**
- Use `PULL_REQUEST_MERGED` only
- Ensures production only builds approved, merged code
- Uses correct merge commit hash
- Environments: `eval-frontend-prod`, `eval-backend-prod`

**For Dev Branch Deployments (Integration Testing):**
- Use `PULL_REQUEST_CREATED` + `PULL_REQUEST_UPDATED`
- Allows integration testing of feature branches before approval
- Catches issues early in development cycle
- Environments: `eval-frontend-sandbox`, `eval-backend-sandbox`, integration test environments

### Required Changes

1. **Separate CodeBuild Projects**: Create dedicated projects for dev vs main branch workflows, each with appropriate webhook configurations

2. **Update buildspec.yaml**: Ensure build logic handles all three event types:
   ```bash
   if [[ "$CODEBUILD_WEBHOOK_EVENT" == "PULL_REQUEST_CREATED" ]] ||
      [[ "$CODEBUILD_WEBHOOK_EVENT" == "PULL_REQUEST_UPDATED" ]] ||
      [[ "$CODEBUILD_WEBHOOK_EVENT" == "PULL_REQUEST_MERGED" ]]; then
   ```

3. **Webhook Filter Configuration**:
   - Main branch projects: `PULL_REQUEST_MERGED` only
   - Dev branch projects: `PULL_REQUEST_CREATED` + `PULL_REQUEST_UPDATED`

## Current Workaround

The buildspec.yaml currently only handles `PULL_REQUEST_CREATED` and `PULL_REQUEST_UPDATED` events. When configured for `PULL_REQUEST_MERGED`, builds fail with `RUN_MODE="SKIP"` because the event type is not recognized.

## Impact

- **High**: Dashboard shows incorrect status for production environments
- **Medium**: Potential for deploying inconsistent code versions
- **Low**: Currently functional but creates operational confusion

## Next Steps

1. Create separate CodeBuild projects for dev vs main workflows
2. Update buildspec.yaml to handle all event types
3. Configure appropriate webhook filters for each project type
4. Test with a complete dev→main PR cycle