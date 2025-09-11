#!/bin/bash

# CI/CD Dashboard Deployment Script
# Requirements: AWS CLI, SAM CLI

set -e

ENVIRONMENT=${1:-dev}
STACK_NAME="cicd-dashboard-${ENVIRONMENT}"

echo "🚀 Deploying CI/CD Dashboard to ${ENVIRONMENT}..."

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(dev|staging|prod)$ ]]; then
    echo "❌ Invalid environment. Use: dev, staging, or prod"
    exit 1
fi

# Check prerequisites
if ! command -v sam &> /dev/null; then
    echo "❌ SAM CLI not found. Install: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html"
    exit 1
fi

if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS credentials not configured. Run: aws configure"
    exit 1
fi

# Install Lambda dependencies
echo "📦 Installing Lambda dependencies..."
cd lambda && npm install && cd ..

# Build and deploy with SAM
echo "🔨 Building SAM application..."
sam build --template-file deploy/template.yaml

echo "📤 Deploying to AWS..."
sam deploy \
    --stack-name "$STACK_NAME" \
    --parameter-overrides Environment="$ENVIRONMENT" \
    --capabilities CAPABILITY_IAM \
    --confirm-changeset \
    --resolve-s3

# Get API endpoint
echo "✅ Deployment complete!"
API_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
    --output text)

echo ""
echo "🌐 API Endpoint: ${API_ENDPOINT}/builds"
echo ""
echo "🧪 Test the API:"
echo "curl ${API_ENDPOINT}/builds"
echo ""
echo "📊 Sample response structure:"
echo "{"
echo "  \"devBuilds\": [...],"
echo "  \"deploymentBuilds\": [...],"
echo "  \"summary\": {...}"
echo "}"