#!/usr/bin/env node

/**
 * Safe Server Restart Script for Claude
 *
 * This script should be used by Claude whenever making changes to the server
 * that require a restart. It prevents multiple server instances and rate limiting.
 */

const { exec } = require('child_process');
const path = require('path');

console.log('🤖 Claude is safely restarting the server...');

// Change to server directory
const serverDir = path.join(__dirname, 'server');
process.chdir(serverDir);

// Clean ports and start with single process
exec('npm run clean && npm run start-safe', (error, stdout, stderr) => {
  if (error) {
    console.error(`❌ Error restarting server: ${error.message}`);
    return;
  }

  if (stderr) {
    console.error(`⚠️  Stderr: ${stderr}`);
  }

  console.log(stdout);
  console.log('✅ Server restart completed safely!');
});