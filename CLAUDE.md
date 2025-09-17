# Claude Instructions for Dashboard Project

## Server Management

**IMPORTANT**: To prevent rate limiting issues from multiple server instances, always use the safe restart script when making server changes.

### Server Commands

- **Safe Restart**: `node claude-restart-server.js` (USE THIS when making server changes)
- **Safe Start**: `cd server && npm run start-safe` (single process with cleanup)
- **Direct Start**: `cd server && npm run start` (direct - for Render compatibility)
- **Check Status**: `cd server && npm run status`
- **Manual Stop**: `cd server && npm run stop`
- **Clean Ports**: `cd server && npm run clean`

### Development Workflow

1. When making changes to `server/index.js` or other server files
2. Always run: `node claude-restart-server.js`
3. This script will safely stop any existing server instances and start a new one
4. Never use `node server/index.js` directly - always use the managed scripts

### Port Information

- Main server runs on port 3004
- Development ports: 3004, 3005, 3006
- Frontend typically runs on port 3000

### Rate Limiting Prevention

The server manager prevents multiple instances by:
- Checking for existing server processes before starting
- Maintaining a PID file to track running servers
- Cleaning up ports before starting new instances
- Providing safe restart functionality

### Common Issues Fixed Automatically

The safe start script automatically fixes:
- **Port Mismatches**: Ensures frontend proxy points to correct server port (3004)
- **Multiple Server Instances**: Kills old processes before starting new ones
- **Configuration Drift**: Validates and corrects common configuration issues

### Port Configuration

- **Server**: Always runs on port 3004
- **Frontend**: Always runs on port 3000
- **Frontend Proxy**: Must point to `localhost:3004` (auto-fixed by safe start)