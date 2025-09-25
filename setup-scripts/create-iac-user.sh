#!/bin/bash

# IAC User Setup Script
# This script creates the IAM user, policy, and access keys needed for Pulumi deployments

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
IAC_USER_NAME="${IAC_USER_NAME:-iac-user}"
IAC_POLICY_NAME="${IAC_POLICY_NAME:-IaCFullAccessPolicy}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BLUE}🚀 Starting IAC User Setup${NC}"
echo -e "${BLUE}================================${NC}"

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

# Get current AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo -e "${GREEN}✅ Using AWS Account: ${ACCOUNT_ID}${NC}"

# Create the IAM policy JSON
echo -e "${YELLOW}📝 Creating IAM policy...${NC}"
cat > "${SCRIPT_DIR}/iac-policy.json" << 'EOF'
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "ec2:*",
                "rds:*",
                "apprunner:*",
                "lambda:*",
                "logs:*",
                "cloudwatch:*",
                "events:*",
                "sns:*",
                "sqs:*",
                "ecr:*",
                "iam:CreateRole",
                "iam:DeleteRole",
                "iam:GetRole",
                "iam:UpdateRole",
                "iam:ListRoles",
                "iam:CreatePolicy",
                "iam:DeletePolicy",
                "iam:GetPolicy",
                "iam:ListPolicies",
                "iam:CreatePolicyVersion",
                "iam:DeletePolicyVersion",
                "iam:AttachRolePolicy",
                "iam:DetachRolePolicy",
                "iam:ListAttachedRolePolicies",
                "iam:ListRolePolicies",
                "iam:PutRolePolicy",
                "iam:DeleteRolePolicy",
                "iam:GetRolePolicy",
                "iam:CreateInstanceProfile",
                "iam:DeleteInstanceProfile",
                "iam:GetInstanceProfile",
                "iam:AddRoleToInstanceProfile",
                "iam:RemoveRoleFromInstanceProfile",
                "iam:TagRole",
                "iam:UntagRole",
                "iam:TagPolicy",
                "iam:UntagPolicy",
                "iam:TagInstanceProfile",
                "iam:UntagInstanceProfile",
                "iam:PassRole",
                "iam:CreateOpenIDConnectProvider",
                "iam:DeleteOpenIDConnectProvider",
                "iam:GetOpenIDConnectProvider",
                "iam:UpdateOpenIDConnectProviderThumbprint",
                "iam:AddClientIDToOpenIDConnectProvider",
                "iam:RemoveClientIDFromOpenIDConnectProvider",
                "iam:TagOpenIDConnectProvider",
                "iam:UntagOpenIDConnectProvider",
                "iam:ListOpenIDConnectProviders",
                "budgets:*",
                "ce:*",
                "wafv2:*",
                "cloudfront:*",
                "ssm:*",
                "kms:Decrypt",
                "kms:DescribeKey",
                "kms:Encrypt",
                "kms:GenerateDataKey",
                "kms:ReEncrypt*",
                "kms:CreateGrant",
                "kms:RetireGrant",
                "sts:GetCallerIdentity",
                "sts:AssumeRole",
                "backup:*"
            ],
            "Resource": "*"
        }
    ]
}
EOF

# Check if user already exists
if aws iam get-user --user-name "${IAC_USER_NAME}" &> /dev/null; then
    echo -e "${YELLOW}⚠️  User '${IAC_USER_NAME}' already exists${NC}"
    read -p "Do you want to continue and update the policy? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${RED}❌ Aborted by user${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}👤 Creating IAM user: ${IAC_USER_NAME}${NC}"
    aws iam create-user --user-name "${IAC_USER_NAME}" --tags Key=Purpose,Value=PulumiInfrastructure Key=CreatedBy,Value=SetupScript
    echo -e "${GREEN}✅ User created successfully${NC}"
fi

# Check if policy already exists
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${IAC_POLICY_NAME}"
if aws iam get-policy --policy-arn "${POLICY_ARN}" &> /dev/null; then
    echo -e "${YELLOW}⚠️  Policy '${IAC_POLICY_NAME}' already exists${NC}"

    # Create a new policy version
    echo -e "${YELLOW}📝 Creating new policy version...${NC}"
    NEW_VERSION=$(aws iam create-policy-version \
        --policy-arn "${POLICY_ARN}" \
        --policy-document file://"${SCRIPT_DIR}/iac-policy.json" \
        --set-as-default \
        --query 'PolicyVersion.VersionId' \
        --output text)
    echo -e "${GREEN}✅ Policy updated to version: ${NEW_VERSION}${NC}"
else
    echo -e "${YELLOW}📝 Creating IAM policy: ${IAC_POLICY_NAME}${NC}"
    aws iam create-policy \
        --policy-name "${IAC_POLICY_NAME}" \
        --policy-document file://"${SCRIPT_DIR}/iac-policy.json" \
        --description "Full access policy for Pulumi Infrastructure as Code deployments" \
        --tags Key=Purpose,Value=PulumiInfrastructure Key=CreatedBy,Value=SetupScript
    echo -e "${GREEN}✅ Policy created successfully${NC}"
fi

# Attach policy to user
echo -e "${YELLOW}🔗 Attaching policy to user...${NC}"
aws iam attach-user-policy \
    --user-name "${IAC_USER_NAME}" \
    --policy-arn "${POLICY_ARN}"
echo -e "${GREEN}✅ Policy attached successfully${NC}"

# Check if access keys already exist
EXISTING_KEYS=$(aws iam list-access-keys --user-name "${IAC_USER_NAME}" --query 'AccessKeyMetadata[?Status==`Active`].AccessKeyId' --output text)
if [ -n "${EXISTING_KEYS}" ]; then
    echo -e "${YELLOW}⚠️  Active access keys already exist for user '${IAC_USER_NAME}':${NC}"
    echo -e "${YELLOW}   ${EXISTING_KEYS}${NC}"
    read -p "Do you want to create new access keys? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}ℹ️  Skipping access key creation${NC}"
        ACCESS_KEY_ID="${EXISTING_KEYS// */}"  # Get first key if multiple
        SECRET_ACCESS_KEY="<existing-secret-key>"
    else
        # Create new access keys
        echo -e "${YELLOW}🔑 Creating new access keys...${NC}"
        KEY_OUTPUT=$(aws iam create-access-key --user-name "${IAC_USER_NAME}")
        ACCESS_KEY_ID=$(echo "${KEY_OUTPUT}" | jq -r '.AccessKey.AccessKeyId')
        SECRET_ACCESS_KEY=$(echo "${KEY_OUTPUT}" | jq -r '.AccessKey.SecretAccessKey')
        echo -e "${GREEN}✅ New access keys created${NC}"
    fi
else
    # Create access keys
    echo -e "${YELLOW}🔑 Creating access keys...${NC}"
    KEY_OUTPUT=$(aws iam create-access-key --user-name "${IAC_USER_NAME}")
    ACCESS_KEY_ID=$(echo "${KEY_OUTPUT}" | jq -r '.AccessKey.AccessKeyId')
    SECRET_ACCESS_KEY=$(echo "${KEY_OUTPUT}" | jq -r '.AccessKey.SecretAccessKey')
    echo -e "${GREEN}✅ Access keys created successfully${NC}"
fi

# Clean up temporary policy file
rm -f "${SCRIPT_DIR}/iac-policy.json"

# Output results
echo -e "\n${GREEN}🎉 Setup Complete!${NC}"
echo -e "${GREEN}===================${NC}"
echo -e "\n${BLUE}📋 IAM User Details:${NC}"
echo -e "User Name: ${GREEN}${IAC_USER_NAME}${NC}"
echo -e "Policy ARN: ${GREEN}${POLICY_ARN}${NC}"
echo -e "Account ID: ${GREEN}${ACCOUNT_ID}${NC}"

echo -e "\n${BLUE}🔐 AWS Credentials:${NC}"
echo -e "${YELLOW}⚠️  Store these credentials securely - the secret key won't be shown again!${NC}"
echo -e "\nAccess Key ID: ${GREEN}${ACCESS_KEY_ID}${NC}"
if [ "${SECRET_ACCESS_KEY}" != "<existing-secret-key>" ]; then
    echo -e "Secret Access Key: ${GREEN}${SECRET_ACCESS_KEY}${NC}"
else
    echo -e "Secret Access Key: ${YELLOW}${SECRET_ACCESS_KEY}${NC}"
fi

echo -e "\n${BLUE}🛠️  Environment Variables:${NC}"
echo -e "Export these in your shell or add to your ~/.bashrc or ~/.zshrc:"
echo -e "\n${GREEN}export AWS_ACCESS_KEY_ID=\"${ACCESS_KEY_ID}\"${NC}"
if [ "${SECRET_ACCESS_KEY}" != "<existing-secret-key>" ]; then
    echo -e "${GREEN}export AWS_SECRET_ACCESS_KEY=\"${SECRET_ACCESS_KEY}\"${NC}"
else
    echo -e "${GREEN}export AWS_SECRET_ACCESS_KEY=\"<your-existing-secret-key>\"${NC}"
fi
echo -e "${GREEN}export AWS_REGION=\"\${AWS_REGION:-eu-west-3}\"${NC}"

echo -e "\n${BLUE}📝 AWS CLI Configuration:${NC}"
echo -e "Alternatively, configure AWS CLI profile:"
echo -e "\n${GREEN}aws configure --profile ${IAC_USER_NAME}${NC}"
echo -e "Access Key ID: ${ACCESS_KEY_ID}"
if [ "${SECRET_ACCESS_KEY}" != "<existing-secret-key>" ]; then
    echo -e "Secret Access Key: ${SECRET_ACCESS_KEY}"
else
    echo -e "Secret Access Key: <your-existing-secret-key>"
fi
echo -e "Default region: eu-west-3"
echo -e "Default output: json"

echo -e "\n${BLUE}⏭️  Next Steps:${NC}"
echo -e "1. Set the AWS credentials as environment variables or configure AWS CLI"
echo -e "2. Run: ${GREEN}npm run build${NC} to compile TypeScript"
echo -e "3. Deploy infrastructure: ${GREEN}npm run dev:up${NC} (or staging:up, prod:up)"
echo -e "4. Run: ${GREEN}./setup-scripts/get-github-vars.sh${NC} to get GitHub Actions variables"

echo -e "\n${BLUE}🔗 Useful Links:${NC}"
echo -e "• IAM User: https://console.aws.amazon.com/iam/home#/users/${IAC_USER_NAME}"
echo -e "• IAM Policy: https://console.aws.amazon.com/iam/home#/policies/${POLICY_ARN}"
echo -e "• Documentation: README.md and IAC-USER-PERMISSIONS.md"

echo -e "\n${GREEN}✅ Setup script completed successfully!${NC}"