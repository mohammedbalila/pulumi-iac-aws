# GitHub Actions Configuration

This file contains the necessary secrets and variables for your GitHub repository.

**Primary app name:** `aws-apprunner-api`
**Detected environments:** `dev (aws-apprunner-api)`
**AWS Account:** `703671895642`
**AWS Region:** `eu-west-3`
**Generated on:** `24 سبت, 2025 +04 08:50:22 م`

## Repository Secrets

Add these secrets to your GitHub repository:
`Settings > Secrets and variables > Actions > New repository secret`

### Required for All Environments

```
AWS_REGION = eu-west-3
```

### DEV Environment

```
AWS_ROLE_ARN_DEV = arn:aws:iam::703671895642:role/GitHubActions-aws-apprunner-api-dev
APP_RUNNER_SERVICE_ARN_DEV = arn:aws:apprunner:eu-west-3:703671895642:service/aws-apprunner-api-service-dev/59516c07d1b54a4f87642c1d4ec7d7a2
```

### Additional Secrets (Optional)

```
PROD_APPROVERS = your-github-username,team-lead-username
SLACK_WEBHOOK = https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
```

## Repository Variables

Add these variables to your GitHub repository:
`Settings > Secrets and variables > Actions > Variables tab`

```
AWS_REGION = eu-west-3
NODE_VERSION = 22
APP_NAME = aws-apprunner-api
```

## GitHub Actions Workflow Files

The following workflow files should be created in your repository:

### 1. Main Deployment Workflow

Create `.github/workflows/deploy.yml` based on the template in `setup-files/deploy.yml`

### 2. Environment Promotion Workflow (Optional)

Create `.github/workflows/promote-environments.yml` for manual promotions between environments.

## Resource Discovery Details

### ECR Repositories
To verify ECR repositories:
```bash
aws ecr describe-repositories --region eu-west-3 --query 'repositories[?contains(repositoryName, `aws-apprunner-api`)].{Name:repositoryName,URI:repositoryUri}' --output table
```

### IAM Roles
To verify GitHub Actions roles:
```bash
aws iam list-roles --query 'Roles[?contains(RoleName, `GitHubActions-aws-apprunner-api`)].{Name:RoleName,ARN:Arn}' --output table
```

### App Runner Services
To verify App Runner services:
```bash
aws apprunner list-services --region eu-west-3 --query 'ServiceSummaryList[?contains(ServiceName, `aws-apprunner-api`)].{Name:ServiceName,ARN:ServiceArn}' --output table
```

## Setup Instructions

1. **Add Secrets to GitHub Repository:**
   - Go to your repository settings
   - Navigate to "Secrets and variables" > "Actions"
   - Add each secret listed above

2. **Add Variables to GitHub Repository:**
   - In the same section, click on "Variables" tab
   - Add the repository variables listed above

3. **Create Workflow Files:**
   - Copy `setup-files/deploy.yml` to `.github/workflows/deploy.yml`
   - Update the APP_NAME variable in the workflow
   - Customize the workflow as needed for your application

4. **Test the Setup:**
   - Push a commit to the `develop` branch (deploys to dev)
   - Push a commit to the `main` branch (deploys to staging)
   - Create a release tag (deploys to production with approval)

## Deployment Workflow

### Development
- **Trigger:** Push to `develop` branch
- **Deploys to:** Dev environment
- **Approval:** None required

### Staging
- **Trigger:** Push to `main` branch
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

```bash
# Check all ECR repositories
aws ecr describe-repositories --region eu-west-3

# Check specific ECR repository
aws ecr describe-repositories --repository-names aws-apprunner-api-dev --region eu-west-3

# List images in repository
aws ecr list-images --repository-name aws-apprunner-api-dev --region eu-west-3

# Check App Runner services
aws apprunner list-services --region eu-west-3

# Check specific App Runner service
aws apprunner describe-service --service-arn <service-arn> --region eu-west-3

# Check IAM roles
aws iam list-roles --query 'Roles[?contains(RoleName, `aws-apprunner-api`)].{Name:RoleName,ARN:Arn}' --output table

# Get specific role details
aws iam get-role --role-name GitHubActions-aws-apprunner-api-dev
```

### Manual Resource Verification

If the script cannot find resources automatically, you can manually verify them:

1. **Find ECR repositories:**
   ```bash
   aws ecr describe-repositories --region eu-west-3 --output table
   ```

2. **Find IAM roles:**
   ```bash
   aws iam list-roles --output table | grep -i aws-apprunner-api
   ```

3. **Find App Runner services:**
   ```bash
   aws apprunner list-services --region eu-west-3 --output table
   ```

Then manually update the secrets in your GitHub repository with the correct ARNs.

