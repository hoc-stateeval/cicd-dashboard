#!/usr/bin/env node

/**
 * Simple safe server starter that cleans ports and runs server directly
 * This avoids the multiple process chain while still providing safety
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 Starting server safely...');

// Check and fix frontend proxy configuration
const checkFrontendConfig = () => {
  const frontendViteConfig = path.join(__dirname, '..', 'frontend', 'vite.config.js');

  if (fs.existsSync(frontendViteConfig)) {
    const content = fs.readFileSync(frontendViteConfig, 'utf8');

    if (content.includes('localhost:4004')) {
      console.log('🔧 Fixing frontend proxy configuration...');
      const fixedContent = content.replace('localhost:4004', 'localhost:3004');
      fs.writeFileSync(frontendViteConfig, fixedContent);
      console.log('✅ Frontend proxy now points to correct port 3004');
    }
  }
};

// Clean up any processes on server ports
const killPortProcesses = () => {
  const serverPorts = [3004, 3005, 3006];
  let killedCount = 0;

  console.log('🧹 Cleaning up server processes...');

  serverPorts.forEach(port => {
    try {
      const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const lines = result.split('\n').filter(line => line.includes('LISTENING'));

      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') {
          try {
            execSync(`taskkill /PID ${pid} /F`, { encoding: 'utf8', stdio: 'ignore' });
            console.log(`🔪 Killed process ${pid} on port ${port}`);
            killedCount++;
          } catch (e) {
            // Process might have already exited
          }
        }
      });
    } catch (e) {
      // Port not in use, that's fine
    }
  });

  console.log(`✅ Cleaned up ${killedCount} server processes`);
};

// Check and fix frontend config first
checkFrontendConfig();

// Clean ports
killPortProcesses();

// Wait a moment for ports to clear
console.log('⏱️  Waiting 1 second for ports to clear...');
setTimeout(() => {
  console.log('🚀 Starting server directly...');

  // Start the server directly (replace this process)
  require('./index.js');

  // The server is now running, this script's job is done
  // Note: process will stay alive because the server keeps it running
}, 1000);