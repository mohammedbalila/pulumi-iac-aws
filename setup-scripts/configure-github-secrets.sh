#!/bin/bash

# GitHub Secrets Configuration Script
# This script uses the GitHub CLI to automatically set secrets and variables for your application repository
# It extracts the necessary values from the infrastructure and applies them to GitHub

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
    echo "Usage: $0 --dev | --staging | --prod" >&2
    exit 1
}

SELECTED_ENV=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dev)
            SELECTED_ENV="dev"
            ;;
        --staging)
            SELECTED_ENV="staging"
            ;;
        --prod)
            SELECTED_ENV="prod"
            ;;
        *)
            echo -e "${RED}❌ Unknown option: $1${NC}" >&2
            usage
            ;;
    esac

    if [ $# -gt 1 ] && [ -n "${SELECTED_ENV}" ]; then
        echo -e "${RED}❌ Please specify only one environment flag${NC}" >&2
        usage
    fi

    shift
done

if [ -z "${SELECTED_ENV}" ]; then
    echo -e "${RED}❌ Environment flag required (--dev | --staging | --prod)${NC}" >&2
    usage
fi

ENVIRONMENTS=("${SELECTED_ENV}")
ENV_LABEL=$(echo "${SELECTED_ENV}" | tr '[:lower:]' '[:upper:]')

echo -e "${BLUE}🔧 GitHub Secrets Configuration Tool${NC}"
echo -e "${BLUE}====================================${NC}"
echo -e "Target environment: ${GREEN}${ENV_LABEL}${NC}"

# Check if GitHub CLI is installed
if ! command -v gh &> /dev/null; then
    echo -e "${RED}❌ GitHub CLI (gh) is not installed. Please install it first.${NC}"
    echo -e "   Installation: ${GREEN}https://cli.github.com/manual/installation${NC}"
    exit 1
fi

# Check if GitHub CLI is authenticated
if ! gh auth status &> /dev/null; then
    echo -e "${RED}❌ GitHub CLI is not authenticated. Please run 'gh auth login' first.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ GitHub CLI is installed and authenticated${NC}"

# Check if AWS CLI is installed and configured
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI is not installed. Please install it first.${NC}"
    exit 1
fi

if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}❌ AWS credentials are not configured. Please run 'aws configure' first.${NC}"
    exit 1
fi

# Check if Pulumi CLI is installed
if ! command -v pulumi &> /dev/null; then
    echo -e "${RED}❌ Pulumi CLI is not installed. Please install it first.${NC}"
    exit 1
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${RED}❌ jq is not installed. Please install it first.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ All required tools are available${NC}"

# Get GitHub repository information from Pulumi config
echo -e "\n${BLUE}🔍 Detecting GitHub Repository Configuration${NC}"
echo -e "${BLUE}=============================================${NC}"

# Try to get GitHub org and repo from any environment
GITHUB_ORG=""
GITHUB_REPO=""

for env in "${ENVIRONMENTS[@]}"; do
    env_dir="${PROJECT_ROOT}/environments/${env}"
    if [ -d "${env_dir}" ]; then
        echo -e "\n${YELLOW}Checking ${env} environment for GitHub configuration...${NC}"

        if (cd "${env_dir}" && pulumi stack ls --json &> /dev/null); then
            # Try to get GitHub org and repo from Pulumi config
            local_github_org=$(cd "${env_dir}" && pulumi config get githubOrg 2>/dev/null || echo "")
            local_github_repo=$(cd "${env_dir}" && pulumi config get githubRepo 2>/dev/null || echo "")

            if [ -n "${local_github_org}" ] && [ -n "${local_github_repo}" ]; then
                GITHUB_ORG="${local_github_org}"
                GITHUB_REPO="${local_github_repo}"
                echo -e "  ${GREEN}✅ Found GitHub configuration in ${env}:${NC}"
                echo -e "    Organization: ${GREEN}${GITHUB_ORG}${NC}"
                echo -e "    Repository: ${GREEN}${GITHUB_REPO}${NC}"
                break
            else
                echo -e "  ${YELLOW}⚠️  GitHub configuration not found in ${env}${NC}"
            fi
        else
            echo -e "  ${YELLOW}⚠️  Pulumi stack not found in ${env}${NC}"
        fi
    fi
done

if [ -z "${GITHUB_ORG}" ] || [ -z "${GITHUB_REPO}" ]; then
    echo -e "\n${RED}❌ Could not detect GitHub organization and repository from Pulumi configuration.${NC}"
    echo -e "\n${YELLOW}Please ensure you have configured githubOrg and githubRepo in at least one environment:${NC}"
    echo -e "cd environments/dev"
    echo -e "pulumi config set githubOrg \"your-github-org\""
    echo -e "pulumi config set githubRepo \"your-repo-name\""
    exit 1
fi

REPO_FULL_NAME="${GITHUB_ORG}/${GITHUB_REPO}"
echo -e "\n${GREEN}✅ Target Repository: ${REPO_FULL_NAME}${NC}"

# Verify the repository exists and we have access
echo -e "\n${BLUE}🔍 Verifying Repository Access${NC}"
echo -e "${BLUE}==============================${NC}"

if ! gh repo view "${REPO_FULL_NAME}" &> /dev/null; then
    echo -e "${RED}❌ Cannot access repository '${REPO_FULL_NAME}'.${NC}"
    echo -e "\n${YELLOW}Possible issues:${NC}"
    echo -e "1. Repository does not exist"
    echo -e "2. You don't have access to the repository"
    echo -e "3. GitHub organization name is incorrect"
    echo -e "4. Repository name is incorrect"
    echo -e "\n${BLUE}Current authentication:${NC}"
    gh auth status 2>&1 | head -3
    exit 1
fi

echo -e "${GREEN}✅ Repository access confirmed${NC}"

# Check if we have admin access to set secrets
echo -e "\n${BLUE}🔐 Checking Repository Permissions${NC}"
echo -e "${BLUE}===================================${NC}"

if ! gh api "repos/${REPO_FULL_NAME}" --jq '.permissions.admin' 2>/dev/null | grep -q "true"; then
    echo -e "${YELLOW}⚠️  You may not have admin access to set secrets.${NC}"
    echo -e "   Admin access is required to manage repository secrets and variables."
    echo -e "   Continuing anyway - errors will be shown if permissions are insufficient."
else
    echo -e "${GREEN}✅ Admin access confirmed${NC}"
fi

# Source the get-github-vars.sh script functions to extract infrastructure data
echo -e "\n${BLUE}📊 Extracting Infrastructure Configuration${NC}"
echo -e "${BLUE}===========================================${NC}"

# Get current AWS account info
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo "eu-west-3")
echo -e "${GREEN}✅ AWS Account: ${ACCOUNT_ID}${NC}"
echo -e "${GREEN}✅ AWS Region: ${REGION}${NC}"

# Source functions from get-github-vars.sh
source "${SCRIPT_DIR}/get-github-vars.sh" 2>/dev/null || {
    echo -e "${RED}❌ Could not source get-github-vars.sh functions${NC}"
    exit 1
}

# Function to safely set GitHub secret
set_github_secret() {
    local secret_name="$1"
    local secret_value="$2"
    local is_variable="$3"  # "true" for variables, "false" for secrets

    if [ -z "${secret_value}" ] || [ "${secret_value}" = "<role-not-found>" ] || [ "${secret_value}" = "<service-not-found>" ]; then
        echo -e "  ${YELLOW}⚠️  Skipping ${secret_name} - value not found${NC}"
        return 1
    fi

    if [ "${is_variable}" = "true" ]; then
        if gh variable set "${secret_name}" --body "${secret_value}" --repo "${REPO_FULL_NAME}" 2>/dev/null; then
            echo -e "  ${GREEN}✅ Variable ${secret_name} set successfully${NC}"
        else
            echo -e "  ${RED}❌ Failed to set variable ${secret_name}${NC}"
            return 1
        fi
    else
        if gh secret set "${secret_name}" --body "${secret_value}" --repo "${REPO_FULL_NAME}" 2>/dev/null; then
            echo -e "  ${GREEN}✅ Secret ${secret_name} set successfully${NC}"
        else
            echo -e "  ${RED}❌ Failed to set secret ${secret_name}${NC}"
            return 1
        fi
    fi
}

# Collect infrastructure data for deployed environments
echo -e "\n${YELLOW}🔍 Discovering deployed environments...${NC}"

DEPLOYED_ENVS=()
DEPLOYED_APP_NAMES=()

for env in "${ENVIRONMENTS[@]}"; do
    echo -e "\n${YELLOW}Checking ${env} environment...${NC}"

    # Get app name for this environment
    local_app_name=""
    if local_app_name=$(get_app_name "${env}" 2>/dev/null); then
        echo -e "  ${GREEN}✅ Detected app name: ${local_app_name}${NC}"
    else
        echo -e "  ${YELLOW}⚠️  Could not detect app name via Pulumi config${NC}"
        continue
    fi

    # Check if environment is deployed
    if check_environment "${env}" "${local_app_name}" &>/dev/null; then
        echo -e "  ${GREEN}✅ Environment '${env}' appears to be deployed${NC}"
        DEPLOYED_ENVS+=("${env}")
        DEPLOYED_APP_NAMES+=("${local_app_name}")
    else
        echo -e "  ${YELLOW}⚠️  Environment '${env}' not deployed or incomplete${NC}"
    fi
done

if [ ${#DEPLOYED_ENVS[@]} -eq 0 ]; then
    echo -e "\n${RED}❌ No deployed environments detected.${NC}"
    echo -e "Please deploy at least one environment before configuring GitHub secrets."
    exit 1
fi

echo -e "\n${GREEN}✅ Found ${#DEPLOYED_ENVS[@]} deployed environment(s): ${DEPLOYED_ENVS[*]}${NC}"

# Use the first detected app name for general configuration
APP_NAME="${DEPLOYED_APP_NAMES[0]}"

# Set common variables first
echo -e "\n${BLUE}📝 Setting Repository Variables${NC}"
echo -e "${BLUE}===============================${NC}"

set_github_secret "AWS_REGION" "${REGION}" "true"
set_github_secret "NODE_VERSION" "22" "true"
set_github_secret "APP_NAME" "${APP_NAME}" "true"

# Set common secrets
echo -e "\n${BLUE}🔐 Setting Repository Secrets${NC}"
echo -e "${BLUE}=============================${NC}"

set_github_secret "AWS_REGION" "${REGION}" "false"

# Set environment-specific secrets
for idx in "${!DEPLOYED_ENVS[@]}"; do
    env="${DEPLOYED_ENVS[$idx]}"
    env_app_name="${DEPLOYED_APP_NAMES[$idx]}"

    echo -e "\n${YELLOW}🔧 Setting secrets for ${env^^} environment (${env_app_name})...${NC}"

    # Environment name mapping for secrets
    ENV_UPPER=$(echo "${env}" | tr '[:lower:]' '[:upper:]')
    if [ "${env}" = "prod" ]; then
        ENV_SECRET_SUFFIX="PROD"
    else
        ENV_SECRET_SUFFIX="${ENV_UPPER}"
    fi

    # Get GitHub Actions Role ARN
    echo -e "  Getting GitHub Actions Role ARN..."
    if GITHUB_ROLE_ARN=$(get_github_role_arn "${env}" "${env_app_name}" 2>/dev/null); then
        set_github_secret "AWS_ROLE_ARN_${ENV_SECRET_SUFFIX}" "${GITHUB_ROLE_ARN}" "false"
    else
        echo -e "  ${RED}❌ Could not get GitHub Actions Role ARN for ${env}${NC}"
    fi

    # Get App Runner Service ARN
    echo -e "  Getting App Runner Service ARN..."
    if APPRUNNER_ARN=$(get_apprunner_arn "${env}" "${env_app_name}" 2>/dev/null); then
        set_github_secret "APP_RUNNER_SERVICE_ARN_${ENV_SECRET_SUFFIX}" "${APPRUNNER_ARN}" "false"
    else
        echo -e "  ${RED}❌ Could not get App Runner Service ARN for ${env}${NC}"
    fi

    # Surface ECR repository details for operator awareness (no GitHub secret required)
    echo -e "  Checking ECR repository..."
    if get_ecr_url "${env}" "${env_app_name}" >/dev/null 2>&1; then
        echo -e "  ${GREEN}✅ ECR repository detected for ${env}${NC}"
    else
        echo -e "  ${YELLOW}⚠️  No ECR repository detected for ${env}; ensure Pulumi deployment created it${NC}"
    fi
done

# Prompt for optional secrets
echo -e "\n${BLUE}📝 Optional Secrets Configuration${NC}"
echo -e "${BLUE}==================================${NC}"

echo -e "${YELLOW}The following secrets are optional but recommended:${NC}"
echo -e "\n1. ${GREEN}PROD_APPROVERS${NC} - GitHub usernames who can approve production deployments"
echo -e "2. ${GREEN}SLACK_WEBHOOK${NC} - Slack webhook URL for deployment notifications"

read -p "Would you like to set optional secrets now? (y/N): " setup_optional
if [[ "$setup_optional" =~ ^[Yy]$ ]]; then
    echo -e "\n${YELLOW}Setting up optional secrets...${NC}"

    read -p "Enter production approvers (comma-separated GitHub usernames): " prod_approvers
    if [ -n "${prod_approvers}" ]; then
        set_github_secret "PROD_APPROVERS" "${prod_approvers}" "false"
    fi

    read -p "Enter Slack webhook URL (optional): " slack_webhook
    if [ -n "${slack_webhook}" ]; then
        set_github_secret "SLACK_WEBHOOK" "${slack_webhook}" "false"
    fi
fi

# Summary
echo -e "\n${BLUE}📋 Configuration Summary${NC}"
echo -e "${BLUE}========================${NC}"

echo -e "\n${GREEN}✅ Repository configured: ${REPO_FULL_NAME}${NC}"
echo -e "${GREEN}✅ App name: ${APP_NAME}${NC}"
echo -e "${GREEN}✅ AWS region: ${REGION}${NC}"
echo -e "${GREEN}✅ Environments configured: ${DEPLOYED_ENVS[*]}${NC}"

echo -e "\n${BLUE}📂 Next Steps${NC}"
echo -e "${BLUE}=============${NC}"

echo -e "1. ${GREEN}Copy workflow files:${NC}"
echo -e "   ${YELLOW}cp setup-files/deploy.yml .github/workflows/deploy.yml${NC}"

echo -e "\n2. ${GREEN}Update workflow configuration:${NC}"
echo -e "   ${YELLOW}Edit .github/workflows/deploy.yml and update APP_NAME to: ${APP_NAME}${NC}"

echo -e "\n3. ${GREEN}Create a Dockerfile in your application repository${NC}"

echo -e "\n4. ${GREEN}Test the setup:${NC}"
echo -e "   ${YELLOW}Push to 'develop' branch to test dev deployment${NC}"
echo -e "   ${YELLOW}Push to 'main' branch to test staging deployment${NC}"
echo -e "   ${YELLOW}Create a release tag to test production deployment${NC}"

echo -e "\n${BLUE}🔍 Verification Commands${NC}"
echo -e "${BLUE}========================${NC}"

echo -e "List secrets: ${GREEN}gh secret list --repo ${REPO_FULL_NAME}${NC}"
echo -e "List variables: ${GREEN}gh variable list --repo ${REPO_FULL_NAME}${NC}"
echo -e "View repository: ${GREEN}gh repo view ${REPO_FULL_NAME}${NC}"

echo -e "\n${GREEN}✅ GitHub secrets configuration completed!${NC}"
