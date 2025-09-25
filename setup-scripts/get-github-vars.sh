#!/bin/bash

# GitHub Actions Setup Script
# This script fetches the necessary ARNs and values for GitHub Actions deployment using AWS CLI

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

github_vars_usage() {
    echo "Usage: $0 --dev | --staging | --prod" >&2
    exit 1
}

if command -v pulumi &> /dev/null; then
    PULUMI_AVAILABLE=true
else
    PULUMI_AVAILABLE=false
fi

# Function to check if environment is deployed using Pulumi
check_environment_with_pulumi() {
    local env_name=$1
    local env_dir="${PROJECT_ROOT}/environments/${env_name}"

    if [ ! -d "${env_dir}" ]; then
        return 1
    fi

    local stack_info
    if ! stack_info=$(cd "${env_dir}" && pulumi stack ls --json 2>/dev/null); then
        return 1
    fi

    # Check if stack exists and has been deployed
    if echo "${stack_info}" | jq -e ".[] | select(.name == \"${env_name}\")" >/dev/null; then
        local last_update
        last_update=$(echo "${stack_info}" | jq -r ".[] | select(.name == \"${env_name}\") | .lastUpdate" 2>/dev/null || echo "null")
        if [ "${last_update}" != "null" ] && [ -n "${last_update}" ]; then
            echo -e "  ${GREEN}✅ Pulumi stack deployed (${last_update})${NC}"
            return 0
        fi
    fi

    return 1
}

# Function to check if environment resources exist using AWS CLI
check_environment() {
    local env_name=$1
    local app_name=$2

    if [ -z "${app_name}" ]; then
        echo -e "  ${RED}❌ Skipping ${env_name} - unable to determine app name${NC}"
        return 1
    fi
    echo -e "  Checking for environment resources..."

    # First try Pulumi if available
    if [ "${PULUMI_AVAILABLE}" = true ]; then
        if check_environment_with_pulumi "${env_name}"; then
            return 0
        fi
        echo -e "  ${YELLOW}⚠️  Pulumi stack not found or not deployed, checking AWS resources...${NC}"
    fi

    # Check for ECR repository
    local ecr_repo_name="${app_name}-${env_name}"
    if aws ecr describe-repositories --repository-names "${ecr_repo_name}" --region "${REGION}" &> /dev/null; then
        echo -e "  ${GREEN}✅ ECR repository found: ${ecr_repo_name}${NC}"
        ECR_FOUND=true
    else
        echo -e "  ${YELLOW}⚠️  ECR repository not found: ${ecr_repo_name}${NC}"
        ECR_FOUND=false
    fi

    # Check for App Runner service
    local found_apprunner=false
    if aws apprunner list-services --region "${REGION}" &> /dev/null; then
        local services=$(aws apprunner list-services --region "${REGION}" --query 'ServiceSummaryList[].ServiceName' --output text)
        for service in $services; do
            if [[ "${service}" == *"${app_name}"* && "${service}" == *"${env_name}"* ]]; then
                echo -e "  ${GREEN}✅ App Runner service found: ${service}${NC}"
                found_apprunner=true
                break
            fi
        done
    fi

    if [ "${found_apprunner}" = false ]; then
        echo -e "  ${YELLOW}⚠️  App Runner service not found for ${env_name}${NC}"
    fi

    # Check for IAM role (GitHub Actions role) - use correct naming pattern
    local role_name="${app_name}-${env_name}-github-actions-role"
    if aws iam get-role --role-name "${role_name}" &> /dev/null; then
        echo -e "  ${GREEN}✅ GitHub Actions role found: ${role_name}${NC}"
        ROLE_FOUND=true
    else
        echo -e "  ${YELLOW}⚠️  GitHub Actions role not found: ${role_name}${NC}"
        ROLE_FOUND=false
    fi

    # Consider environment deployed if we have at least ECR and role
    if [ "${ECR_FOUND}" = true ] && [ "${ROLE_FOUND}" = true ]; then
        return 0
    else
        return 1
    fi
}

# Function to get GitHub Actions role ARN using AWS CLI
get_github_role_arn() {
    local env_name=$1
    local app_name=$2

    # Use the correct naming pattern from GitHubActionsRole class
    local role_name="${app_name}-${env_name}-github-actions-role"

    if aws iam get-role --role-name "${role_name}" --query 'Role.Arn' --output text 2>/dev/null; then
        return 0
    fi

    # Try alternative patterns as fallback
    local role_patterns=(
        "${app_name}-${env_name}-github-actions"
        "${app_name}-${env_name}-github-actions-role"
        "${app_name}-github-actions-${env_name}"
        "github-actions-${app_name}-${env_name}"
    )

    for role_name in "${role_patterns[@]}"; do
        if aws iam get-role --role-name "${role_name}" --query 'Role.Arn' --output text 2>/dev/null; then
            return 0
        fi
    done

    # If specific patterns don't work, search for roles containing the app name and env
    local roles=$(aws iam list-roles --query 'Roles[?contains(RoleName, `'${app_name}'`) && contains(RoleName, `'${env_name}'`)].Arn' --output text 2>/dev/null)
    if [ -n "${roles}" ]; then
        # Take the first matching role
        echo "${roles}" | head -n1
        return 0
    fi

    return 1
}

# Function to get App Runner service ARN using AWS CLI
get_apprunner_arn() {
    local env_name=$1
    local app_name=$2

    # List all App Runner services and find the one matching our pattern
    if ! aws apprunner list-services --region "${REGION}" &> /dev/null; then
        return 1
    fi

    local services=$(aws apprunner list-services --region "${REGION}" --query 'ServiceSummaryList[].[ServiceName,ServiceArn]' --output text)

    while IFS=$'\t' read -r service_name service_arn; do
        if [[ "${service_name}" == *"${app_name}"* && "${service_name}" == *"${env_name}"* ]]; then
            echo "${service_arn}"
            return 0
        fi
    done <<< "${services}"

    return 1
}

get_app_name() {
    local env_name=$1

    # Try to get from Pulumi stack outputs if Pulumi is available
    if [ "${PULUMI_AVAILABLE}" = true ]; then
        local env_dir="${PROJECT_ROOT}/environments/${env_name}"
        if [ -d "${env_dir}" ]; then
            if (cd "${env_dir}" && pulumi stack ls --json 2>/dev/null | jq -e ".[] | select(.name == \"${env_name}\")" >/dev/null); then
                local app_name
                app_name=$(cd "${env_dir}" && pulumi config get appName 2>/dev/null || echo "null")
                if [ -n "${app_name}" ] && [ "${app_name}" != "null" ]; then
                    echo "${app_name}"
                    return 0
                fi
            fi
        fi
    fi

    return 1
}

# Function to get ECR repository URL using AWS CLI
get_ecr_url() {
    local env_name=$1
    local app_name=$2

    local repo_name="${app_name}-${env_name}"

    if aws ecr describe-repositories --repository-names "${repo_name}" --region "${REGION}" --query 'repositories[0].repositoryUri' --output text 2>/dev/null; then
        return 0
    fi

    return 1
}

if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
    return
fi

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
            github_vars_usage
            ;;
    esac

    if [ $# -gt 1 ] && [ -n "${SELECTED_ENV}" ]; then
        echo -e "${RED}❌ Please specify only one environment flag${NC}" >&2
        github_vars_usage
    fi

    shift
done

if [ -z "${SELECTED_ENV}" ]; then
    echo -e "${RED}❌ Environment flag required (--dev | --staging | --prod)${NC}" >&2
    github_vars_usage
fi

ENVIRONMENTS=("${SELECTED_ENV}")
ENV_LABEL=$(echo "${SELECTED_ENV}" | tr '[:lower:]' '[:upper:]')

echo -e "${BLUE}🚀 GitHub Actions Setup Helper (AWS CLI)${NC}"
echo -e "${BLUE}=======================================${NC}"
echo -e "Target environment: ${GREEN}${ENV_LABEL}${NC}"

# Check if AWS CLI is installed and configured
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI is not installed. Please install it first.${NC}"
    exit 1
fi

# Check if AWS credentials are configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}❌ AWS credentials are not configured. Please run 'aws configure' first.${NC}"
    exit 1
fi

if [ "${PULUMI_AVAILABLE}" = true ]; then
    echo -e "${GREEN}✅ Pulumi CLI available for deployment verification${NC}"
else
    echo -e "${YELLOW}⚠️  Pulumi CLI not found - using AWS CLI only${NC}"
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${RED}❌ jq is not installed. Please install it first.${NC}"
    echo -e "   Ubuntu/Debian: ${GREEN}sudo apt-get install jq${NC}"
    echo -e "   macOS: ${GREEN}brew install jq${NC}"
    echo -e "   CentOS/RHEL: ${GREEN}sudo yum install jq${NC}"
    exit 1
fi

# Get current AWS account info
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo "eu-west-3")
echo -e "${GREEN}✅ AWS Account: ${ACCOUNT_ID}${NC}"
echo -e "${GREEN}✅ AWS Region: ${REGION}${NC}"

# Check deployed environments and collect app names
echo -e "\n${BLUE}🔍 Checking Infrastructure Deployment Status${NC}"
echo -e "${BLUE}=============================================${NC}"

DEPLOYED_ENVS=()
DEPLOYED_APP_NAMES=()

for env in "${ENVIRONMENTS[@]}"; do
    echo -e "\n${YELLOW}Checking ${env} environment...${NC}"

    local_app_name=""
    if local_app_name=$(get_app_name "${env}" 2>/dev/null); then
        echo -e "  ${GREEN}✅ Detected app name: ${local_app_name}${NC}"
    else
        echo -e "  ${YELLOW}⚠️  Could not detect app name via Pulumi config${NC}"
    fi

    if [ -z "${local_app_name}" ]; then
        read -p "  Enter application name for ${env} (leave blank to skip): " local_app_name
        if [ -z "${local_app_name}" ]; then
            echo -e "  ${RED}❌ Skipping ${env} - unable to determine app name${NC}"
            continue
        fi
    fi

    if check_environment "${env}" "${local_app_name}"; then
        echo -e "${GREEN}✅ Environment '${env}' appears to be deployed${NC}"
        DEPLOYED_ENVS+=("${env}")
        DEPLOYED_APP_NAMES+=("${local_app_name}")
    else
        echo -e "${RED}❌ Environment '${env}' resources not found or incomplete${NC}"
        echo -e "   Deploy with: ${GREEN}npm run ${env}:up${NC}"
    fi
done

if [ ${#DEPLOYED_ENVS[@]} -eq 0 ]; then
    echo -e "\n${RED}❌ No deployed environments detected.${NC}"
    echo -e "\n${YELLOW}Possible issues:${NC}"
    echo -e "1. Infrastructure not deployed yet"
    echo -e "2. Pulumi configuration missing 'appName'"
    echo -e "3. Resources deployed in different region"
    echo -e "\n${BLUE}Deployment Commands:${NC}"
    echo -e "1. Build project: ${GREEN}npm run build${NC}"
    echo -e "2. Deploy dev: ${GREEN}npm run dev:up${NC}"
    echo -e "3. Deploy staging: ${GREEN}npm run staging:up${NC}"
    echo -e "4. Deploy prod: ${GREEN}npm run prod:up${NC}"
    echo -e "\n${BLUE}Verification Commands:${NC}"
    echo -e "Check ECR repos: ${GREEN}aws ecr describe-repositories --region ${REGION}${NC}"
    echo -e "Check IAM roles: ${GREEN}aws iam list-roles --region ${REGION}${NC}"
    echo -e "Check App Runner: ${GREEN}aws apprunner list-services --region ${REGION}${NC}"
    exit 1
fi

echo -e "\n${GREEN}✅ Found ${#DEPLOYED_ENVS[@]} deployed environment(s): ${DEPLOYED_ENVS[*]}${NC}"

# Use the first detected app name as a reference for general instructions
REFERENCE_APP_NAME="${DEPLOYED_APP_NAMES[0]}"
APP_NAME="${REFERENCE_APP_NAME}"

# Build a readable summary of detected environments and app names
ENV_APP_SUMMARY=""
for idx in "${!DEPLOYED_ENVS[@]}"; do
    env="${DEPLOYED_ENVS[$idx]}"
    app="${DEPLOYED_APP_NAMES[$idx]}"
    if [ -n "${ENV_APP_SUMMARY}" ]; then
        ENV_APP_SUMMARY="${ENV_APP_SUMMARY}, "
    fi
    ENV_APP_SUMMARY="${ENV_APP_SUMMARY}${env} (${app})"
done

DEPLOYED_ROLE_ARNS=()
DEPLOYED_APPRUNNER_ARNS=()
DEPLOYED_ROLE_FOUND=()
DEPLOYED_SERVICE_FOUND=()

# Collect GitHub Actions variables
echo -e "\n${BLUE}📋 Collecting GitHub Actions Variables${NC}"
echo -e "${BLUE}=====================================${NC}"

# Create output file
OUTPUT_FILE="${SCRIPT_DIR}/github-actions-config.md"
cat > "${OUTPUT_FILE}" << EOF
# GitHub Actions Configuration

This file contains the necessary secrets and variables for your GitHub repository.

**Primary app name:** \`${APP_NAME}\`
**Detected environments:** \`${ENV_APP_SUMMARY}\`
**AWS Account:** \`${ACCOUNT_ID}\`
**AWS Region:** \`${REGION}\`
**Generated on:** \`$(date)\`

## Repository Secrets

Add these secrets to your GitHub repository:
\`Settings > Secrets and variables > Actions > New repository secret\`

EOF

echo -e "\n${YELLOW}📝 Generating GitHub Actions configuration...${NC}"

# Common secrets
cat >> "${OUTPUT_FILE}" << EOF
### Required for All Environments

\`\`\`
AWS_REGION = ${REGION}
\`\`\`

EOF

# Environment-specific secrets
for idx in "${!DEPLOYED_ENVS[@]}"; do
    env="${DEPLOYED_ENVS[$idx]}"
    env_app_name="${DEPLOYED_APP_NAMES[$idx]}"

    echo -e "\n${YELLOW}Getting data for ${env} environment...${NC}"

    # Get GitHub Actions Role ARN
    echo -e "  Getting GitHub Actions Role ARN..."
    if GITHUB_ROLE_ARN=$(get_github_role_arn "${env}" "${env_app_name}"); then
        role_found="true"
        echo -e "  ${GREEN}✅ GitHub Actions Role ARN found${NC}"
    else
        role_found="false"
        echo -e "  ${RED}❌ Could not get GitHub Actions Role ARN${NC}"
        echo -e "  ${YELLOW}   Searching for any role containing '${env_app_name}' and '${env}'...${NC}"
        # Continue anyway, we might still find other resources
        GITHUB_ROLE_ARN="<role-not-found>"
    fi

    # Get App Runner Service ARN
    echo -e "  Getting App Runner Service ARN..."
    if APPRUNNER_ARN=$(get_apprunner_arn "${env}" "${env_app_name}"); then
        service_found="true"
        echo -e "  ${GREEN}✅ App Runner Service ARN found${NC}"
    else
        service_found="false"
        echo -e "  ${RED}❌ Could not get App Runner Service ARN${NC}"
        echo -e "  ${YELLOW}   Searching for any service containing '${env_app_name}' and '${env}'...${NC}"
        APPRUNNER_ARN="<service-not-found>"
    fi

    DEPLOYED_ROLE_ARNS+=("${GITHUB_ROLE_ARN}")
    DEPLOYED_APPRUNNER_ARNS+=("${APPRUNNER_ARN}")
    DEPLOYED_ROLE_FOUND+=("${role_found}")
    DEPLOYED_SERVICE_FOUND+=("${service_found}")

    # Environment name mapping for secrets
    ENV_UPPER=$(echo "${env}" | tr '[:lower:]' '[:upper:]')
    if [ "${env}" = "prod" ]; then
        ENV_SECRET_SUFFIX="PROD"
    else
        ENV_SECRET_SUFFIX="${ENV_UPPER}"
    fi

    # Add to output file
    cat >> "${OUTPUT_FILE}" << EOF
### ${ENV_UPPER} Environment

\`\`\`
AWS_ROLE_ARN_${ENV_SECRET_SUFFIX} = ${GITHUB_ROLE_ARN}
APP_RUNNER_SERVICE_ARN_${ENV_SECRET_SUFFIX} = ${APPRUNNER_ARN}
\`\`\`

EOF

done

# Add additional secrets section
cat >> "${OUTPUT_FILE}" << EOF
### Additional Secrets (Optional)

\`\`\`
PROD_APPROVERS = your-github-username,team-lead-username
SLACK_WEBHOOK = https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
\`\`\`

## Repository Variables

Add these variables to your GitHub repository:
\`Settings > Secrets and variables > Actions > Variables tab\`

\`\`\`
AWS_REGION = ${REGION}
NODE_VERSION = 22
APP_NAME = ${APP_NAME}
\`\`\`

## GitHub Actions Workflow Files

The following workflow files should be created in your repository:

### 1. Main Deployment Workflow

Create \`.github/workflows/deploy.yml\` based on the template in \`setup-files/deploy.yml\`

### 2. Environment Promotion Workflow (Optional)

Create \`.github/workflows/promote-environments.yml\` for manual promotions between environments.

## Resource Discovery Details

### ECR Repositories
To verify ECR repositories:
\`\`\`bash
aws ecr describe-repositories --region ${REGION} --query 'repositories[?contains(repositoryName, \`${APP_NAME}\`)].{Name:repositoryName,URI:repositoryUri}' --output table
\`\`\`

### IAM Roles
To verify GitHub Actions roles:
\`\`\`bash
aws iam list-roles --query 'Roles[?contains(RoleName, \`GitHubActions-${APP_NAME}\`)].{Name:RoleName,ARN:Arn}' --output table
\`\`\`

### App Runner Services
To verify App Runner services:
\`\`\`bash
aws apprunner list-services --region ${REGION} --query 'ServiceSummaryList[?contains(ServiceName, \`${APP_NAME}\`)].{Name:ServiceName,ARN:ServiceArn}' --output table
\`\`\`

## Setup Instructions

1. **Add Secrets to GitHub Repository:**
   - Go to your repository settings
   - Navigate to "Secrets and variables" > "Actions"
   - Add each secret listed above

2. **Add Variables to GitHub Repository:**
   - In the same section, click on "Variables" tab
   - Add the repository variables listed above

3. **Create Workflow Files:**
   - Copy \`setup-files/deploy.yml\` to \`.github/workflows/deploy.yml\`
   - Update the APP_NAME variable in the workflow
   - Customize the workflow as needed for your application

4. **Test the Setup:**
   - Push a commit to the \`develop\` branch (deploys to dev)
   - Push a commit to the \`main\` branch (deploys to staging)
   - Create a release tag (deploys to production with approval)

## Deployment Workflow

### Development
- **Trigger:** Push to \`develop\` branch
- **Deploys to:** Dev environment
- **Approval:** None required

### Staging
- **Trigger:** Push to \`main\` branch
- **Deploys to:** Staging environment
- **Approval:** None required

### Production
- **Trigger:** GitHub release (tag creation)
- **Deploys to:** Production environment
- **Approval:** Required (2 approvers from PROD_APPROVERS list)

## Troubleshooting

### Common Issues

1. **Resource Not Found**
   - Verify the app name matches what was used during deployment
   - Check that resources exist in the correct AWS region
   - Ensure you have proper AWS permissions to list resources

2. **Role Assumption Failures**
   - Verify the GitHub Actions role ARNs are correct
   - Check that the repository name matches the one configured in Pulumi
   - Ensure the branch protection rules match the role trust policy

3. **ECR Push Failures**
   - Verify ECR repository names are correct
   - Check that the GitHub Actions role has ECR permissions
   - Ensure the AWS region is correct

4. **App Runner Update Failures**
   - Verify App Runner service ARNs are correct
   - Check that the image exists in ECR before deployment
   - Review App Runner service logs for deployment errors

### Debug Commands

\`\`\`bash
# Check all ECR repositories
aws ecr describe-repositories --region ${REGION}

# Check specific ECR repository
aws ecr describe-repositories --repository-names ${APP_NAME}-dev --region ${REGION}

# List images in repository
aws ecr list-images --repository-name ${APP_NAME}-dev --region ${REGION}

# Check App Runner services
aws apprunner list-services --region ${REGION}

# Check specific App Runner service
aws apprunner describe-service --service-arn <service-arn> --region ${REGION}

# Check IAM roles
aws iam list-roles --query 'Roles[?contains(RoleName, \`${APP_NAME}\`)].{Name:RoleName,ARN:Arn}' --output table

# Get specific role details
aws iam get-role --role-name GitHubActions-${APP_NAME}-dev
\`\`\`

### Manual Resource Verification

If the script cannot find resources automatically, you can manually verify them:

1. **Find ECR repositories:**
   \`\`\`bash
   aws ecr describe-repositories --region ${REGION} --output table
   \`\`\`

2. **Find IAM roles:**
   \`\`\`bash
   aws iam list-roles --output table | grep -i ${APP_NAME}
   \`\`\`

3. **Find App Runner services:**
   \`\`\`bash
   aws apprunner list-services --region ${REGION} --output table
   \`\`\`

Then manually update the secrets in your GitHub repository with the correct ARNs.

EOF

echo -e "\n${GREEN}✅ Configuration file created: ${OUTPUT_FILE}${NC}"

# Display the configuration in terminal as well
echo -e "\n${BLUE}📋 GitHub Repository Secrets${NC}"
echo -e "${BLUE}============================${NC}"

echo -e "\n${YELLOW}🔐 Add these secrets to your GitHub repository:${NC}"
echo -e "${YELLOW}Settings > Secrets and variables > Actions > New repository secret${NC}"

echo -e "\n${GREEN}AWS_REGION${NC} = ${REGION}"

for idx in "${!DEPLOYED_ENVS[@]}"; do
    env="${DEPLOYED_ENVS[$idx]}"
    env_app_name="${DEPLOYED_APP_NAMES[$idx]}"
    env_role="${DEPLOYED_ROLE_ARNS[$idx]}"
    env_service="${DEPLOYED_APPRUNNER_ARNS[$idx]}"
    env_role_status="${DEPLOYED_ROLE_FOUND[$idx]}"
    env_service_status="${DEPLOYED_SERVICE_FOUND[$idx]}"

    echo -e "\n${YELLOW}${env^^} Environment (${env_app_name}):${NC}"

    ENV_UPPER=$(echo "${env}" | tr '[:lower:]' '[:upper:]')
    if [ "${env}" = "prod" ]; then
        ENV_SECRET_SUFFIX="PROD"
    else
        ENV_SECRET_SUFFIX="${ENV_UPPER}"
    fi

    if [ "${env_role_status}" = "true" ]; then
        echo -e "${GREEN}AWS_ROLE_ARN_${ENV_SECRET_SUFFIX}${NC} = ${env_role}"
    else
        echo -e "${RED}AWS_ROLE_ARN_${ENV_SECRET_SUFFIX}${NC} = ${env_role}"
    fi

    if [ "${env_service_status}" = "true" ]; then
        echo -e "${GREEN}APP_RUNNER_SERVICE_ARN_${ENV_SECRET_SUFFIX}${NC} = ${env_service}"
    else
        echo -e "${RED}APP_RUNNER_SERVICE_ARN_${ENV_SECRET_SUFFIX}${NC} = ${env_service}"
    fi

    echo -e "${BLUE}ℹ️  Confirm ECR repository exists: ${env_app_name}-${env}${NC}"
done

echo -e "\n${BLUE}📋 Repository Variables${NC}"
echo -e "${BLUE}======================${NC}"
echo -e "${YELLOW}Add these as repository variables (not secrets):${NC}"
echo -e "${GREEN}AWS_REGION${NC} = ${REGION}"
echo -e "${GREEN}NODE_VERSION${NC} = 22"
echo -e "${GREEN}APP_NAME${NC} = ${APP_NAME}"

echo -e "\n${BLUE}📝 Next Steps${NC}"
echo -e "${BLUE}=============${NC}"
echo -e "1. Add the secrets and variables to your GitHub repository"
echo -e "2. Copy ${GREEN}setup-files/deploy.yml${NC} to ${GREEN}.github/workflows/deploy.yml${NC}"
echo -e "3. Update APP_NAME in the workflow file to: ${GREEN}${APP_NAME}${NC}"
echo -e "4. Customize the workflow file for your application"
echo -e "5. Create a Dockerfile in your application repository"
echo -e "6. Push to ${GREEN}develop${NC} branch to test dev deployment"

echo -e "\n${BLUE}📄 Configuration Details${NC}"
echo -e "${BLUE}========================${NC}"
echo -e "Full configuration saved to: ${GREEN}${OUTPUT_FILE}${NC}"
echo -e "View the file for complete setup instructions and troubleshooting tips."

echo -e "\n${BLUE}🔍 Manual Verification Commands${NC}"
echo -e "${BLUE}===============================${NC}"
echo -e "Verify ECR repos: ${GREEN}aws ecr describe-repositories --region ${REGION} --query 'repositories[?contains(repositoryName, \`${APP_NAME}\`)].repositoryName' --output table${NC}"
echo -e "Verify IAM roles: ${GREEN}aws iam list-roles --query 'Roles[?contains(RoleName, \`${APP_NAME}\`)].RoleName' --output table${NC}"
echo -e "Verify App Runner: ${GREEN}aws apprunner list-services --region ${REGION} --query 'ServiceSummaryList[?contains(ServiceName, \`${APP_NAME}\`)].ServiceName' --output table${NC}"

echo -e "\n${GREEN}✅ GitHub Actions setup helper completed!${NC}"
