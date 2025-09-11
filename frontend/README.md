# CI/CD Dashboard Frontend

React frontend for the CI/CD build status dashboard.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment file and update API URL
cp .env.example .env
# Edit .env with your API Gateway URL

# Start development server
npm run dev
```

## Features

- **Real-time Build Status**: Auto-refreshes every 30 seconds
- **Branch Detection**: Separates dev testing builds from deployment builds
- **Visual Status Indicators**: Color-coded status with icons
- **Build Details**: Shows branch, duration, commit, and run mode
- **Summary Statistics**: Quick overview of build health
- **Responsive Design**: Works on desktop and mobile

## Configuration

Update `.env` with your API Gateway URL after deploying the Lambda:

```env
VITE_API_URL=https://your-api-id.execute-api.region.amazonaws.com/dev
```

## Build for Production

```bash
npm run build
```

The `dist/` folder can be deployed to S3 + CloudFront for hosting.

## Component Structure

```
src/
├── App.jsx                 # Main dashboard layout
├── hooks/
│   └── useBuilds.js       # API integration with React Query
└── components/
    ├── BuildCard.jsx      # Individual build status card
    ├── BuildSection.jsx   # Section wrapper for build groups  
    └── SummaryCard.jsx    # Summary statistics and refresh button
```