#!/bin/bash

# CI/CD Dashboard Startup Script
# Starts both backend server and frontend dev server
# This script is designed to work in bash environments (WSL, Git Bash, Linux)

set -e

echo "🚀 Starting CI/CD Dashboard (bash environment)..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 18+ first."
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null 2>&1; then
    echo "⚠️  Warning: AWS credentials not configured."
    echo "   Run 'aws configure' or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY"
    echo "   The dashboard will start but may not fetch real data."
    echo ""
fi

# Install backend dependencies
echo "📦 Installing backend dependencies..."
cd server
if [ ! -d "node_modules" ]; then
    npm install
fi
cd ..

# Install frontend dependencies  
echo "📦 Installing frontend dependencies..."
cd frontend
if [ ! -d "node_modules" ]; then
    npm install
fi
cd ..

echo ""
echo "✅ Dependencies installed!"
echo ""
echo "🔧 Starting servers..."
echo "   Backend:  http://localhost:3001"
echo "   Frontend: http://localhost:3000"
echo ""
echo "📊 Dashboard will be available at: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop both servers"
echo ""

# Start backend in background
cd server
npm start &
BACKEND_PID=$!
cd ..

# Wait a moment for backend to start
sleep 2

# Start frontend (this will block)
cd frontend
npm run dev &
FRONTEND_PID=$!

# Wait for either process to exit
wait $BACKEND_PID $FRONTEND_PID

# Cleanup: kill both processes when script exits
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT