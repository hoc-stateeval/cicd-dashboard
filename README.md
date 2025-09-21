# CI/CD Dashboard MVP

**Branch-focused build status dashboard** that distinguishes between dev testing builds and main deployment builds.

## Quick Start

```bash
# Start both backend and frontend servers
./start.sh         # Linux/Mac
# or
start.bat          # Windows

# Dashboard available at: http://localhost:3000
```

## What This Provides

### 🔍 **Branch Detection**
Automatically categorizes builds based on your existing buildspec logic:

- **Dev Builds**: `feature/* → dev` (TEST_ONLY mode)
- **Main Builds**: `dev → main` and manual main builds (FULL_BUILD mode)

### 📊 **API Response Structure**
```json
{
  "devBuilds": [
    {
      "projectName": "eval-sandbox-frontend", 
      "branch": "feature/login-fix",
      "status": "SUCCESS",
      "runMode": "TEST_ONLY",
      "startTime": "2025-01-15T14:30:22Z"
    }
  ],
  "deploymentBuilds": [
    {
      "projectName": "stateeval-backend",
      "branch": "dev→main", 
      "status": "SUCCESS",
      "runMode": "FULL_BUILD",
      "isDeployable": true
    }
  ],
  "summary": {
    "failedDevBuilds": 2,
    "lastUpdated": "2025-01-15T15:00:00Z"
  }
}
```

## Configuration

### Project Names
Update `server/index.js:103-108` with your actual CodeBuild project names:

```javascript
const projectNames = [
  'your-frontend-project',
  'your-backend-project',
  // Add your actual project names
];
```

### AWS Credentials
Your local environment needs AWS credentials with these CodeBuild permissions:
- `codebuild:BatchGetBuilds`
- `codebuild:ListBuildsForProject` 
- `codebuild:ListProjects`

```bash
# Configure AWS credentials
aws configure
# or set environment variables:
# AWS_ACCESS_KEY_ID=your-key
# AWS_SECRET_ACCESS_KEY=your-secret
```

## Dashboard UI Guide

### Understanding Hash Values
Hash values displayed throughout the dashboard follow this priority:
1. **Git commit hash (7 characters)** - Primary method for deployment correlation
2. **SHA256 artifact hash (8 characters)** - Fallback when git commit unavailable
3. **MD5 artifact hash (8 characters)** - Secondary fallback

### Dashboard Sections

#### Main Branch Builds
- **Backend Builds**: Production deployments and main branch builds for backend services
- **Frontend Builds**: Production deployments and main branch builds for frontend services
- **Hash location**: Displayed in the PR# column alongside PR numbers
- **Color coding**: Backend (blue 🔧), Frontend (orange 🌐)

#### Code Pipeline Deployment Targets
- **Environment sections**: Sandbox, Demo, Production deployments
- **Current Deployment**: Shows what's currently running in each environment
- **Available Updates**: Shows newer builds ready for deployment
- **Hash location**: Displayed next to PR numbers in deployment status
- **Deploy buttons**: Trigger deployments to specific environments

#### Recent Dev Builds
- **Feature branch testing**: Shows `feature/* → dev` builds in TEST_ONLY mode
- **Hash location**: Displayed in the PR# column
- **Status indicators**: Success/failure badges for quick health checks

## Development

```bash
# Start backend only
cd server && npm start

# Start frontend only
cd frontend && npm run dev

# Test API directly
curl http://localhost:3001/builds
```

## EDS Nightly Import Testing

The `eds-nightly-import-prod` Lambda function can be tested using the following methods:

### API Gateway Endpoints (Recommended)

**Production Stage:**
```bash
curl -X POST https://hlgnf1or0m.execute-api.us-west-2.amazonaws.com/Prod/
```

**Staging Stage:**
```bash
curl -X POST https://hlgnf1or0m.execute-api.us-west-2.amazonaws.com/Stage/
```

### Test Specific Endpoints

Since it's an ASP.NET Core application, try these common endpoints:
```bash
# Health check
curl https://hlgnf1or0m.execute-api.us-west-2.amazonaws.com/Prod/health

# Status endpoint
curl https://hlgnf1or0m.execute-api.us-west-2.amazonaws.com/Prod/status

# Import trigger
curl -X POST https://hlgnf1or0m.execute-api.us-west-2.amazonaws.com/Prod/import

# Root with different HTTP methods
curl -X GET https://hlgnf1or0m.execute-api.us-west-2.amazonaws.com/Prod/
```

### Direct Lambda Invocation

```bash
# Invoke with empty payload
aws lambda invoke --function-name eds-nightly-import-prod response.json

# View response
cat response.json
```

### Monitor Test Results

Check CloudWatch logs after testing:
```bash
aws logs describe-log-streams --log-group-name "/aws/lambda/eds-nightly-import-prod" --order-by LastEventTime --descending --max-items 3
```

### Function Details

- **Function**: `eds-nightly-import-prod`
- **Runtime**: .NET 8 (ASP.NET Core)
- **Purpose**: EDS (Education Data System) nightly data import
- **Memory**: 5,120 MB
- **Timeout**: 15 minutes
- **VPC**: Runs inside VPC for secure data access
- **Status**: Currently dormant (no automated schedulers active)

## Next Steps

1. **Update project names** in `server/index.js` with your actual CodeBuild projects
2. **Test the dashboard** with `./start.sh` (or `start.bat` on Windows)
3. **Add deployment status tracking** (ECS/pipeline correlation)
4. **Add real-time updates** (WebSocket or polling)

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  React Frontend │────│  Express Server │────│   CodeBuild API │
│  localhost:3000 │    │  localhost:3001 │    │                 │
│                 │    │ Branch Detection│    │ Build History   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

The Express server queries your CodeBuild projects and uses the webhook environment variables (already logged in your buildspecs) to determine branch types and deployment readiness.