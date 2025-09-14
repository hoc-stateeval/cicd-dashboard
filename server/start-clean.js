#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const path = require('path');

console.log('🧹 Starting clean server...');

// Kill any existing node processes on common dev ports
const killPortProcesses = (ports) => {
  ports.forEach(port => {
    try {
      // Windows command to find and kill process on port
      const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const lines = result.split('\n').filter(line => line.includes('LISTENING'));

      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') {
          console.log(`🔪 Killing process ${pid} on port ${port}`);
          try {
            execSync(`taskkill /PID ${pid} /F`, { encoding: 'utf8', stdio: 'ignore' });
          } catch (e) {
            console.log(`   ⚠️  Could not kill PID ${pid}: ${e.message}`);
          }
        }
      });
    } catch (e) {
      // Port not in use, that's fine
    }
  });
};

// Kill only server processes running on specific ports
const killServerProcesses = () => {
  try {
    console.log('🧹 Cleaning up server processes...');

    // Only kill processes on server ports (3004, 3005, 3006)
    const serverPorts = [3004, 3005, 3006];
    let killedCount = 0;

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
              console.log(`🔪 Killed server process ${pid} on port ${port}`);
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
  } catch (e) {
    console.log('⚠️  Could not clean server processes:', e.message);
  }
};

// Kill server processes first
killServerProcesses();

console.log('⏱️  Waiting 2 seconds for ports to clear...');
setTimeout(() => {
  console.log('🚀 Starting server...');

  // Start the server
  const serverProcess = spawn('node', ['index.js'], {
    cwd: __dirname,
    stdio: 'inherit'
  });

  // Handle process termination
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    serverProcess.kill('SIGINT');
    process.exit(0);
  });

  serverProcess.on('exit', (code) => {
    console.log(`🔚 Server process exited with code ${code}`);
    process.exit(code);
  });

}, 2000);