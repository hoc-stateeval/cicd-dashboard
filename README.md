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

## Development

```bash
# Start backend only
cd server && npm start

# Start frontend only  
cd frontend && npm run dev

# Test API directly
curl http://localhost:3001/builds
```

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