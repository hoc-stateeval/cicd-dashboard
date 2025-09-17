#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class ServerManager {
  constructor() {
    this.serverPorts = [3004, 3005, 3006];
    this.pidFile = path.join(__dirname, '.server.pid');
    this.isRunning = false;
  }

  // Check if our server is already running by checking PID file and process
  async checkServerStatus() {
    try {
      if (fs.existsSync(this.pidFile)) {
        const pid = fs.readFileSync(this.pidFile, 'utf8').trim();

        // Check if process is still running
        try {
          execSync(`tasklist /PID ${pid}`, { stdio: 'ignore' });
          console.log(`📍 Server already running with PID ${pid}`);
          return { running: true, pid: parseInt(pid) };
        } catch (e) {
          // PID file exists but process is dead, clean it up
          fs.unlinkSync(this.pidFile);
          console.log(`🧹 Cleaned up stale PID file for dead process ${pid}`);
        }
      }
      return { running: false, pid: null };
    } catch (e) {
      console.log('⚠️  Error checking server status:', e.message);
      return { running: false, pid: null };
    }
  }

  // Kill processes on specific ports
  killPortProcesses() {
    console.log('🧹 Cleaning up server processes...');
    let killedCount = 0;

    this.serverPorts.forEach(port => {
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
              console.log(`   ⚠️  Could not kill PID ${pid}: ${e.message}`);
            }
          }
        });
      } catch (e) {
        // Port not in use, that's fine
      }
    });

    console.log(`✅ Cleaned up ${killedCount} server processes`);

    // Clean up PID file if it exists
    if (fs.existsSync(this.pidFile)) {
      fs.unlinkSync(this.pidFile);
      console.log('🗑️  Removed PID file');
    }
  }

  // Start the server with proper cleanup
  async startServer() {
    console.log('🚀 Starting server manager...');

    // Check if server is already running
    const status = await this.checkServerStatus();
    if (status.running) {
      console.log('✅ Server is already running, no need to start another instance');
      return status.pid;
    }

    // Kill any processes on our ports
    this.killPortProcesses();

    console.log('⏱️  Waiting 2 seconds for ports to clear...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('🚀 Starting server...');

    // Start the server
    const serverProcess = spawn('node', ['index.js'], {
      cwd: __dirname,
      stdio: 'inherit',
      detached: false
    });

    // Write PID to file
    fs.writeFileSync(this.pidFile, serverProcess.pid.toString());
    console.log(`📝 Server started with PID ${serverProcess.pid}`);

    // Handle process termination
    const cleanup = () => {
      console.log('\n🛑 Shutting down server manager...');
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
      if (!serverProcess.killed) {
        serverProcess.kill('SIGINT');
      }
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    serverProcess.on('exit', (code) => {
      console.log(`🔚 Server process exited with code ${code}`);
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
      process.exit(code);
    });

    serverProcess.on('error', (err) => {
      console.error('❌ Server process error:', err);
      cleanup();
    });

    return serverProcess.pid;
  }

  // Stop the server
  async stopServer() {
    const status = await this.checkServerStatus();
    if (status.running) {
      try {
        execSync(`taskkill /PID ${status.pid} /F`, { stdio: 'ignore' });
        console.log(`🛑 Stopped server with PID ${status.pid}`);
        if (fs.existsSync(this.pidFile)) {
          fs.unlinkSync(this.pidFile);
        }
        return true;
      } catch (e) {
        console.log(`⚠️  Could not stop server: ${e.message}`);
        return false;
      }
    } else {
      console.log('ℹ️  No server running to stop');
      return true;
    }
  }

  // Restart the server
  async restartServer() {
    console.log('🔄 Restarting server...');
    await this.stopServer();
    await new Promise(resolve => setTimeout(resolve, 1000));
    return await this.startServer();
  }

  // Get server status
  async status() {
    const status = await this.checkServerStatus();
    if (status.running) {
      console.log(`✅ Server is running with PID ${status.pid}`);
    } else {
      console.log('❌ Server is not running');
    }
    return status;
  }
}

// CLI interface
if (require.main === module) {
  const manager = new ServerManager();
  const command = process.argv[2] || 'start';

  switch (command) {
    case 'start':
      manager.startServer().catch(console.error);
      break;
    case 'stop':
      manager.stopServer().catch(console.error);
      break;
    case 'restart':
      manager.restartServer().catch(console.error);
      break;
    case 'status':
      manager.status().catch(console.error);
      break;
    case 'clean':
      manager.killPortProcesses();
      break;
    default:
      console.log(`
Usage: node server-manager.js [command]

Commands:
  start    - Start the server (default)
  stop     - Stop the server
  restart  - Restart the server
  status   - Check server status
  clean    - Kill processes on server ports
`);
  }
}

module.exports = ServerManager;