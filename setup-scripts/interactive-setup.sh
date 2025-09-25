#!/bin/bash

# Interactive Setup Script
# This script guides users through the complete setup process

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

clear

echo -e "${BLUE}${BOLD}🚀 Pulumi AWS Infrastructure Setup Wizard${NC}"
echo -e "${BLUE}${BOLD}==========================================${NC}"
echo -e ""
echo -e "This wizard will guide you through setting up your AWS infrastructure"
echo -e "deployment environment with Pulumi, including IAM users, policies,"
echo -e "and GitHub Actions CI/CD configuration."
echo -e ""
echo -e "${YELLOW}What this wizard will do:${NC}"
echo -e "1. 🔍 Validate prerequisites (AWS CLI, Pulumi, etc.)"
echo -e "2. 👤 Create IAM user and policy for infrastructure deployment"
echo -e "3. 🏗️  Guide you through infrastructure deployment"
echo -e "4. 📋 Generate GitHub Actions configuration"
echo -e "5. 📚 Provide next steps and documentation links"
echo -e ""

read -p "Continue with setup? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Setup cancelled.${NC}"
    exit 0
fi

# Step 1: Prerequisites Check
echo -e "\n${BLUE}${BOLD}Step 1: Prerequisites Check${NC}"
echo -e "${BLUE}===========================${NC}"

echo -e "\n${YELLOW}Running validation script...${NC}"
if "${SCRIPT_DIR}/validate-setup.sh"; then
    echo -e "\n${GREEN}✅ Prerequisites validation completed${NC}"
else
    echo -e "\n${RED}❌ Prerequisites validation failed${NC}"
    echo -e "Please fix the issues above before continuing."
    exit 1
fi

read -p "Continue to IAM user setup? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Skipping IAM user setup...${NC}"
    SKIP_IAM=true
else
    SKIP_IAM=false
fi

# Step 2: IAM User Setup
if [ "${SKIP_IAM}" = false ]; then
    echo -e "\n${BLUE}${BOLD}Step 2: IAM User Setup${NC}"
    echo -e "${BLUE}======================${NC}"

    echo -e "\n${YELLOW}This will create an IAM user with full permissions for infrastructure deployment.${NC}"
    echo -e "${YELLOW}Make sure you have AWS admin credentials configured.${NC}"

    read -p "Proceed with IAM user creation? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "\n${YELLOW}Creating IAM user and policy...${NC}"
        if "${SCRIPT_DIR}/create-iac-user.sh"; then
            echo -e "\n${GREEN}✅ IAM user setup completed${NC}"
            echo -e "\n${YELLOW}IMPORTANT: Save the credentials displayed above!${NC}"
            echo -e "You'll need to configure your environment with these credentials."
        else
            echo -e "\n${RED}❌ IAM user setup failed${NC}"
            exit 1
        fi

        echo -e "\n${YELLOW}Please configure your AWS credentials now:${NC}"
        echo -e "Option 1 - Environment variables (recommended):"
        echo -e "  ${GREEN}export AWS_ACCESS_KEY_ID=\"your-access-key\"${NC}"
        echo -e "  ${GREEN}export AWS_SECRET_ACCESS_KEY=\"your-secret-key\"${NC}"
        echo -e "  ${GREEN}export AWS_REGION=\"eu-west-3\"${NC}"
        echo -e ""
        echo -e "Option 2 - AWS CLI profile:"
        echo -e "  ${GREEN}aws configure --profile iac-user${NC}"

        read -p "Have you configured your AWS credentials? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo -e "\n${RED}Please configure AWS credentials and re-run this script.${NC}"
            exit 1
        fi
    else
        echo -e "\n${YELLOW}Skipping IAM user creation...${NC}"
    fi
fi

# Step 3: Infrastructure Configuration
echo -e "\n${BLUE}${BOLD}Step 3: Infrastructure Configuration${NC}"
echo -e "${BLUE}====================================${NC}"

echo -e "\n${YELLOW}Let's configure your infrastructure deployment settings.${NC}"

# Get app name
read -p "Enter your application name (default: my-app): " APP_NAME
APP_NAME=${APP_NAME:-my-app}

# Get GitHub org and repo
read -p "Enter your GitHub organization: " GITHUB_ORG
read -p "Enter your GitHub repository name: " GITHUB_REPO

# Get alert email
read -p "Enter alert email (required for production): " ALERT_EMAIL

echo -e "\n${YELLOW}Configuration summary:${NC}"
echo -e "Application name: ${GREEN}${APP_NAME}${NC}"
echo -e "GitHub org: ${GREEN}${GITHUB_ORG}${NC}"
echo -e "GitHub repo: ${GREEN}${GITHUB_REPO}${NC}"
echo -e "Alert email: ${GREEN}${ALERT_EMAIL}${NC}"

read -p "Is this correct? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "\n${RED}Please re-run the script with correct values.${NC}"
    exit 1
fi

# Step 4: Environment Selection
echo -e "\n${BLUE}${BOLD}Step 4: Environment Deployment${NC}"
echo -e "${BLUE}===============================${NC}"

echo -e "\n${YELLOW}Which environments would you like to deploy?${NC}"
echo -e "1. Development only (recommended for first-time setup)"
echo -e "2. Development + Staging"
echo -e "3. All environments (Dev + Staging + Production)"

read -p "Enter your choice (1-3): " -n 1 -r ENV_CHOICE
echo

case $ENV_CHOICE in
    1)
        ENVIRONMENTS=("dev")
        ;;
    2)
        ENVIRONMENTS=("dev" "staging")
        ;;
    3)
        ENVIRONMENTS=("dev" "staging" "prod")
        ;;
    *)
        echo -e "${RED}Invalid choice. Defaulting to development only.${NC}"
        ENVIRONMENTS=("dev")
        ;;
esac

# Build the project first
echo -e "\n${YELLOW}Building TypeScript project...${NC}"
cd "${SCRIPT_DIR}/.."
if npm run build; then
    echo -e "${GREEN}✅ Build successful${NC}"
else
    echo -e "${RED}❌ Build failed${NC}"
    exit 1
fi

# Deploy environments
for env in "${ENVIRONMENTS[@]}"; do
    echo -e "\n${BLUE}${BOLD}Deploying ${env} environment${NC}"
    echo -e "${BLUE}========================${NC}"

    ENV_DIR="${SCRIPT_DIR}/../environments/${env}"
    cd "${ENV_DIR}"

    # Configure Pulumi stack
    echo -e "\n${YELLOW}Configuring Pulumi stack for ${env}...${NC}"

    # Initialize stack if it doesn't exist
    if ! pulumi stack ls --json 2>/dev/null | jq -e ".[] | select(.name == \"${env}\")" > /dev/null; then
        echo -e "${YELLOW}Creating new Pulumi stack: ${env}${NC}"
        pulumi stack init "${env}"
    else
        echo -e "${YELLOW}Using existing Pulumi stack: ${env}${NC}"
        pulumi stack select "${env}"
    fi

    # Set configuration
    pulumi config set appName "${APP_NAME}"
    pulumi config set githubOrg "${GITHUB_ORG}"
    pulumi config set githubRepo "${GITHUB_REPO}"

    if [ "${env}" = "prod" ]; then
        pulumi config set alertEmail "${ALERT_EMAIL}"
    fi

    # Get database password
    echo -e "\n${YELLOW}Database password for ${env} environment:${NC}"
    read -s -p "Enter database password (hidden input): " DB_PASSWORD
    echo
    pulumi config set --secret dbPassword "${DB_PASSWORD}"

    echo -e "\n${YELLOW}Preview deployment for ${env}...${NC}"
    if pulumi preview; then
        read -p "Deploy this environment? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo -e "\n${YELLOW}Deploying ${env} environment...${NC}"
            if pulumi up --yes; then
                echo -e "\n${GREEN}✅ ${env} environment deployed successfully${NC}"
            else
                echo -e "\n${RED}❌ ${env} environment deployment failed${NC}"
                read -p "Continue with remaining environments? (y/n): " -n 1 -r
                echo
                if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                    exit 1
                fi
            fi
        else
            echo -e "\n${YELLOW}Skipping ${env} deployment${NC}"
        fi
    else
        echo -e "\n${RED}❌ Preview failed for ${env}${NC}"
        read -p "Continue with remaining environments? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
done

# Step 5: GitHub Actions Configuration
echo -e "\n${BLUE}${BOLD}Step 5: GitHub Actions Configuration${NC}"
echo -e "${BLUE}====================================${NC}"

echo -e "\n${YELLOW}Generating GitHub Actions configuration...${NC}"
cd "${SCRIPT_DIR}"

if ./get-github-vars.sh; then
    echo -e "\n${GREEN}✅ GitHub Actions configuration generated${NC}"
else
    echo -e "\n${RED}❌ Failed to generate GitHub Actions configuration${NC}"
fi

# Step 6: Next Steps
echo -e "\n${BLUE}${BOLD}Step 6: Next Steps${NC}"
echo -e "${BLUE}=================${NC}"

echo -e "\n${GREEN}🎉 Setup completed successfully!${NC}"
echo -e "\n${YELLOW}What you've accomplished:${NC}"
echo -e "✅ Created IAM user with infrastructure permissions"
echo -e "✅ Deployed infrastructure environments"
echo -e "✅ Generated GitHub Actions configuration"

echo -e "\n${YELLOW}Next steps to complete your CI/CD setup:${NC}"
echo -e ""
echo -e "${BOLD}1. Configure GitHub Repository:${NC}"
echo -e "   • Add the secrets from: ${GREEN}setup-scripts/github-actions-config.md${NC}"
echo -e "   • Go to: Settings > Secrets and variables > Actions"
echo -e ""
echo -e "${BOLD}2. Create GitHub Workflow:${NC}"
echo -e "   • Copy: ${GREEN}setup-files/deploy.yml${NC} to ${GREEN}.github/workflows/deploy.yml${NC}"
echo -e "   • Customize the workflow for your application"
echo -e ""
echo -e "${BOLD}3. Create Application Dockerfile:${NC}"
echo -e "   • Add a Dockerfile to your application repository"
echo -e "   • Ensure it exposes port 8080 for App Runner"
echo -e ""
echo -e "${BOLD}4. Set up Branch Protection:${NC}"
echo -e "   • Protect ${GREEN}main${NC} branch (requires PR reviews)"
echo -e "   • Protect ${GREEN}develop${NC} branch (requires status checks)"
echo -e ""
echo -e "${BOLD}5. Test Deployment:${NC}"
echo -e "   • Push to ${GREEN}develop${NC} branch → deploys to dev"
echo -e "   • Push to ${GREEN}main${NC} branch → deploys to staging"
echo -e "   • Create release tag → deploys to production (with approval)"

echo -e "\n${BLUE}📚 Documentation:${NC}"
echo -e "• Setup guide: ${GREEN}setup-scripts/README.md${NC}"
echo -e "• GitHub config: ${GREEN}setup-scripts/github-actions-config.md${NC}"
echo -e "• CI/CD guide: ${GREEN}CICD-IMPLEMENTATION-GUIDE.md${NC}"
echo -e "• Permissions: ${GREEN}IAC-USER-PERMISSIONS.md${NC}"
echo -e "• Project overview: ${GREEN}CLAUDE.md${NC}"

echo -e "\n${BLUE}🔧 Useful Commands:${NC}"
echo -e "• Validate setup: ${GREEN}./setup-scripts/validate-setup.sh${NC}"
echo -e "• Update GitHub vars: ${GREEN}./setup-scripts/get-github-vars.sh${NC}"
echo -e "• Deploy dev: ${GREEN}npm run dev:up${NC}"
echo -e "• Deploy staging: ${GREEN}npm run staging:up${NC}"
echo -e "• Deploy prod: ${GREEN}npm run prod:up${NC}"
echo -e "• Run tests: ${GREEN}npm test${NC}"

echo -e "\n${GREEN}✨ Happy deploying!${NC}"