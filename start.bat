@echo off
REM CI/CD Dashboard Startup Script for Windows

echo 🚀 Starting CI/CD Dashboard...

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js not found. Please install Node.js 18+ first.
    pause
    exit /b 1
)

REM Check AWS credentials
aws sts get-caller-identity >nul 2>&1
if errorlevel 1 (
    echo ⚠️  Warning: AWS credentials not configured.
    echo    Run 'aws configure' or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
    echo    The dashboard will start but may not fetch real data.
    echo.
)

REM Install backend dependencies
echo 📦 Installing backend dependencies...
cd server
if not exist "node_modules" (
    npm install
)
cd ..

REM Install frontend dependencies
echo 📦 Installing frontend dependencies...
cd frontend
if not exist "node_modules" (
    npm install
)
cd ..

echo.
echo ✅ Dependencies installed!
echo.
echo 🔧 Starting servers...
echo    Backend:  http://localhost:3001
echo    Frontend: http://localhost:3000
echo.
echo 📊 Dashboard will be available at: http://localhost:3000
echo.
echo Press Ctrl+C to stop both servers
echo.

REM Start backend in new window
start "Backend Server" cmd /k "cd server && npm start"

REM Wait a moment for backend to start
timeout /t 3 /nobreak >nul

REM Start frontend in new window
start "Frontend Server" cmd /k "cd frontend && npm run dev"

echo Both servers started in separate windows.
echo Close this window or press any key to exit.
pause >nul