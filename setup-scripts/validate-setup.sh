#!/bin/bash

# Setup Validation Script
# This script validates that the IAM user and infrastructure are properly configured

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔍 Setup Validation${NC}"
echo -e "${BLUE}==================${NC}"

# Check AWS CLI
echo -e "\n${YELLOW}Checking AWS CLI...${NC}"
if command -v aws &> /dev/null; then
    AWS_VERSION=$(aws --version)
    echo -e "${GREEN}✅ AWS CLI installed: ${AWS_VERSION}${NC}"
else
    echo -e "${RED}❌ AWS CLI not found${NC}"
    exit 1
fi

# Check AWS credentials
echo -e "\n${YELLOW}Checking AWS credentials...${NC}"
if aws sts get-caller-identity &> /dev/null; then
    IDENTITY=$(aws sts get-caller-identity)
    USER_ARN=$(echo "${IDENTITY}" | jq -r '.Arn')
    ACCOUNT_ID=$(echo "${IDENTITY}" | jq -r '.Account')
    echo -e "${GREEN}✅ AWS credentials configured${NC}"
    echo -e "   User: ${USER_ARN}"
    echo -e "   Account: ${ACCOUNT_ID}"
else
    echo -e "${RED}❌ AWS credentials not configured${NC}"
    exit 1
fi

# Check if user is IAC user
echo -e "\n${YELLOW}Checking IAM user type...${NC}"
if echo "${USER_ARN}" | grep -q "user/iac-user"; then
    echo -e "${GREEN}✅ Using IAC user${NC}"
elif echo "${USER_ARN}" | grep -q "user/"; then
    echo -e "${YELLOW}⚠️  Using custom IAM user: $(echo "${USER_ARN}" | cut -d'/' -f2)${NC}"
else
    echo -e "${YELLOW}⚠️  Using IAM role or different authentication method${NC}"
fi

# Check Pulumi
echo -e "\n${YELLOW}Checking Pulumi...${NC}"
if command -v pulumi &> /dev/null; then
    PULUMI_VERSION=$(pulumi version)
    echo -e "${GREEN}✅ Pulumi installed: ${PULUMI_VERSION}${NC}"
else
    echo -e "${RED}❌ Pulumi not found${NC}"
    exit 1
fi

# Check Node.js and npm
echo -e "\n${YELLOW}Checking Node.js...${NC}"
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✅ Node.js installed: ${NODE_VERSION}${NC}"
else
    echo -e "${RED}❌ Node.js not found${NC}"
fi

if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    echo -e "${GREEN}✅ npm installed: v${NPM_VERSION}${NC}"
else
    echo -e "${RED}❌ npm not found${NC}"
fi

# Check Docker (optional for local development)
echo -e "\n${YELLOW}Checking Docker (optional)...${NC}"
if command -v docker &> /dev/null; then
    if docker --version &> /dev/null; then
        DOCKER_VERSION=$(docker --version)
        echo -e "${GREEN}✅ Docker installed: ${DOCKER_VERSION}${NC}"
    else
        echo -e "${YELLOW}⚠️  Docker installed but not running${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Docker not found (optional for CI/CD)${NC}"
fi

# Check jq
echo -e "\n${YELLOW}Checking jq...${NC}"
if command -v jq &> /dev/null; then
    JQ_VERSION=$(jq --version)
    echo -e "${GREEN}✅ jq installed: ${JQ_VERSION}${NC}"
else
    echo -e "${RED}❌ jq not found (required for scripts)${NC}"
fi

# Check project structure
echo -e "\n${YELLOW}Checking project structure...${NC}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Check key directories
DIRS=("environments/dev" "environments/staging" "environments/prod" "modules" "shared" "tests")
for dir in "${DIRS[@]}"; do
    if [ -d "${PROJECT_ROOT}/${dir}" ]; then
        echo -e "${GREEN}✅ Directory exists: ${dir}${NC}"
    else
        echo -e "${RED}❌ Directory missing: ${dir}${NC}"
    fi
done

# Check key files
FILES=("package.json" "tsconfig.json" "shared/constants.ts" "shared/config.ts" "shared/types.ts")
for file in "${FILES[@]}"; do
    if [ -f "${PROJECT_ROOT}/${file}" ]; then
        echo -e "${GREEN}✅ File exists: ${file}${NC}"
    else
        echo -e "${RED}❌ File missing: ${file}${NC}"
    fi
done

# Check TypeScript build
echo -e "\n${YELLOW}Checking TypeScript build...${NC}"
cd "${PROJECT_ROOT}"
if [ -f "package.json" ]; then
    if npm run build &> /dev/null; then
        echo -e "${GREEN}✅ TypeScript build successful${NC}"
    else
        echo -e "${RED}❌ TypeScript build failed${NC}"
        echo -e "   Run: ${YELLOW}npm run build${NC} to see details"
    fi
else
    echo -e "${RED}❌ package.json not found${NC}"
fi

# Check environment deployments
echo -e "\n${YELLOW}Checking environment deployments...${NC}"
ENVIRONMENTS=("dev" "staging" "prod")
DEPLOYED_COUNT=0

for env in "${ENVIRONMENTS[@]}"; do
    ENV_DIR="${PROJECT_ROOT}/environments/${env}"
    if [ -d "${ENV_DIR}" ]; then
        cd "${ENV_DIR}"
        if pulumi stack ls --json 2>/dev/null | jq -e ".[] | select(.name == \"${env}\")" > /dev/null; then
            LAST_UPDATE=$(pulumi stack ls --json 2>/dev/null | jq -r ".[] | select(.name == \"${env}\") | .lastUpdate" 2>/dev/null || echo "null")
            if [ "${LAST_UPDATE}" != "null" ] && [ -n "${LAST_UPDATE}" ]; then
                echo -e "${GREEN}✅ Environment '${env}' deployed (${LAST_UPDATE})${NC}"
                ((DEPLOYED_COUNT++))
            else
                echo -e "${YELLOW}⚠️  Environment '${env}' stack exists but not deployed${NC}"
            fi
        else
            echo -e "${RED}❌ Environment '${env}' not deployed${NC}"
        fi
    else
        echo -e "${RED}❌ Environment directory missing: ${env}${NC}"
    fi
done

# Test AWS permissions (basic checks)
echo -e "\n${YELLOW}Testing AWS permissions...${NC}"

# Test EC2 permissions
if aws ec2 describe-regions --query 'Regions[0].RegionName' --output text &> /dev/null; then
    echo -e "${GREEN}✅ EC2 permissions working${NC}"
else
    echo -e "${RED}❌ EC2 permissions insufficient${NC}"
fi

# Test ECR permissions
if aws ecr describe-repositories --max-items 1 &> /dev/null; then
    echo -e "${GREEN}✅ ECR permissions working${NC}"
else
    echo -e "${YELLOW}⚠️  ECR permissions may be insufficient${NC}"
fi

# Test IAM permissions
if aws iam list-roles --max-items 1 &> /dev/null; then
    echo -e "${GREEN}✅ IAM permissions working${NC}"
else
    echo -e "${RED}❌ IAM permissions insufficient${NC}"
fi

# Summary
echo -e "\n${BLUE}📋 Validation Summary${NC}"
echo -e "${BLUE}====================${NC}"

if [ "${DEPLOYED_COUNT}" -eq 0 ]; then
    echo -e "${YELLOW}⚠️  No environments deployed - ready for initial deployment${NC}"
    echo -e "   Next steps:"
    echo -e "   1. Run: ${GREEN}npm run dev:up${NC}"
    echo -e "   2. Run: ${GREEN}./setup-scripts/get-github-vars.sh${NC}"
elif [ "${DEPLOYED_COUNT}" -lt 3 ]; then
    echo -e "${YELLOW}⚠️  Partial deployment (${DEPLOYED_COUNT}/3 environments)${NC}"
    echo -e "   You can run: ${GREEN}./setup-scripts/get-github-vars.sh${NC}"
else
    echo -e "${GREEN}✅ All environments deployed (${DEPLOYED_COUNT}/3)${NC}"
    echo -e "   Ready for: ${GREEN}./setup-scripts/get-github-vars.sh${NC}"
fi

echo -e "\n${BLUE}🔗 Useful Commands${NC}"
echo -e "${BLUE}=================${NC}"
echo -e "Build project:      ${GREEN}npm run build${NC}"
echo -e "Deploy dev:         ${GREEN}npm run dev:up${NC}"
echo -e "Deploy staging:     ${GREEN}npm run staging:up${NC}"
echo -e "Deploy prod:        ${GREEN}npm run prod:up${NC}"
echo -e "Get GitHub vars:    ${GREEN}./setup-scripts/get-github-vars.sh${NC}"
echo -e "Run tests:          ${GREEN}npm test${NC}"

echo -e "\n${GREEN}✅ Validation completed${NC}"