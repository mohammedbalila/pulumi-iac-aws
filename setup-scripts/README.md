# Setup Scripts

This directory packages the utilities that bootstrap AWS credentials for Pulumi, validate your workstation, and wire GitHub Actions to the infrastructure that Pulumi provisions. Use them together to go from a blank AWS account to a fully configured CI/CD pipeline in minutes.

## Prerequisites

Install these tools before running any script:

- `aws` CLI with administrator credentials (needed to create IAM principals and inspect deployments)
- `jq` for JSON parsing
- `pulumi` CLI (stacks are inspected and optionally deployed from these scripts)
- `node` + `npm` (TypeScript builds run as part of validation and deployment flows)
- `docker` (optional; the validator surfaces whether Docker is running because CI/CD builds rely on it)
- `gh` (GitHub CLI) **only** if you plan to run `configure-github-secrets.sh`

> Tip: rerun `./setup-scripts/validate-setup.sh` after installing dependencies to confirm everything is in place.

## Script Catalog

| Script | Purpose | Key prerequisites | Primary output |
| --- | --- | --- | --- |
| `interactive-setup.sh` | Guided wizard that chains validation, IAM provisioning, Pulumi deploys, and GitHub config hints. | AWS CLI admin credentials, Pulumi, jq, node/npm | Prompts, environment deployments, follow-up checklist |
| `validate-setup.sh` | Sanity-check tooling, AWS auth, project structure, and Pulumi stacks. | AWS CLI, Pulumi, jq, node/npm | Diagnostic report in terminal |
| `create-iac-user.sh` | Creates (or updates) the IAM user and policy Pulumi uses, then issues access keys. | AWS CLI admin credentials, jq | IAM user, managed policy, access keys |
| `get-github-vars.sh` | Discovers GitHub Actions role ARNs, App Runner ARNs, and ECR repositories for a stack. Generates documentation you can copy into GitHub. | AWS CLI authenticated as IaC user, jq, Pulumi (optional but enhances detection) | Regenerated `github-actions-config.md` summary |
| `configure-github-secrets.sh` | Uses the GitHub CLI to push secrets/variables into a repository based on Pulumi state. | AWS CLI, Pulumi, jq, authenticated `gh` CLI | Repository secrets/variables set remotely |
| `get-github-vars.sh` (sourced) | When sourced, exposes helper functions (`get_github_role_arn`, `check_environment`, etc.) used by other scripts. | Same as above | Reusable shell functions |

## Usage Flows

### Option A — One-command wizard (recommended)

```bash
chmod +x setup-scripts/interactive-setup.sh
./setup-scripts/interactive-setup.sh
```

The wizard:
- Verifies tooling via `validate-setup.sh`
- Offers to create/refresh the IaC IAM user via `create-iac-user.sh`
- Builds TypeScript and walks through Pulumi stack configuration per environment
- Points you at the GitHub configuration step once deployments succeed

You can rerun the wizard safely; it keeps existing stacks and IAM resources intact.

### Option B — Manual workflow

1. **Validate prerequisites**
   ```bash
   chmod +x setup-scripts/validate-setup.sh
   ./setup-scripts/validate-setup.sh
   ```
2. **Create (or update) the IaC IAM user**
   ```bash
   chmod +x setup-scripts/create-iac-user.sh
   ./setup-scripts/create-iac-user.sh
   ```
3. **Configure AWS credentials** using the access keys produced (environment variables or `aws configure --profile iac-user`).
4. **Build and deploy infrastructure**
   ```bash
   npm run build
   npm run dev:up        # add staging:up / prod:up as needed
   ```
5. **Gather GitHub settings**
   ```bash
   chmod +x setup-scripts/get-github-vars.sh
   ./setup-scripts/get-github-vars.sh --dev       # or --staging / --prod
   ```
   This regenerates `setup-scripts/github-actions-config.md` with secrets, variables, and workflow guidance.
6. **(Optional) Push secrets to GitHub automatically**
   ```bash
   chmod +x setup-scripts/configure-github-secrets.sh
   ./setup-scripts/configure-github-secrets.sh --dev
   ```
   Requires `gh auth login` against the target repository with admin permission.

## Script Details

### `validate-setup.sh`
- Confirms AWS CLI authentication, Pulumi availability, Node/npm versions, Docker status, and jq.
- Builds the TypeScript project to surface compiler issues early.
- Checks each environment directory for Pulumi stacks and notes deployment timestamps.
- Exercises baseline AWS permissions (EC2, ECR, IAM) so missing privileges are flagged immediately.

### `create-iac-user.sh`
- Creates the IAM user `iac-user` (override via `IAC_USER_NAME`).
- Manages the IaC policy (`IaCFullAccessPolicy` by default) with update-on-change semantics.
- Attaches the policy to the user and optionally rotates access keys.
- Prints export commands and AWS CLI profile instructions—copy them to your shell configuration right away.
- Cleans up the temporary policy document automatically.

### `get-github-vars.sh`
- Requires an environment flag (`--dev`, `--staging`, or `--prod`). Run it once per environment to capture ARNs.
- Uses Pulumi (if available) plus AWS CLI lookups to confirm that GitHub Actions roles, App Runner services, and ECR repositories exist.
- Writes a comprehensive cheat sheet to `setup-scripts/github-actions-config.md` and echoes highlights to stdout.
- Exposes helper functions when sourced; other scripts (like `configure-github-secrets.sh`) load these helpers instead of reimplementing AWS lookups.

### `configure-github-secrets.sh`
- Wraps `gh secret set` / `gh variable set` with Pulumi- and AWS-derived values.
- Requires a single environment flag and validates toolchain availability (`aws`, `pulumi`, `jq`, `gh`).
- Verifies repository access and ensures the caller has admin rights before attempting to mutate secrets.
- Populates `AWS_REGION`, `APP_NAME`, `NODE_VERSION`, and per-environment role/service ARNs; skips items whose source values are missing to avoid false positives.
- Useful after running `pulumi up` so GitHub Actions jobs can assume the correct AWS role without manual copying.

### `interactive-setup.sh`
- Provides an end-to-end onboarding experience, with opt-in prompts at each milestone.
- Delegates to `validate-setup.sh`, `create-iac-user.sh`, and Pulumi commands while surfacing next steps (e.g., configuring GitHub secrets).
- Safe to run multiple times; it detects existing stacks and will not overwrite your GitHub secrets automatically.

## Script Configuration

Both IAM scripts honour environment variables so you can adapt naming conventions:

```bash
export IAC_USER_NAME="my-iac-user"
export IAC_POLICY_NAME="MyIaCPolicy"
./setup-scripts/create-iac-user.sh
```

Default values:

| Variable | Default | Description |
| --- | --- | --- |
| `IAC_USER_NAME` | `iac-user` | IAM username created for Pulumi |
| `IAC_POLICY_NAME` | `IaCFullAccessPolicy` | Managed policy attached to the user |
| `AWS_REGION` | `eu-west-3` | Region assumed by scripts when one is not configured |

## Generated Files

### `github-actions-config.md`

Each run of `get-github-vars.sh` (and scripts that consume it) regenerates this file with:

- Required GitHub repository secrets and variables
- Environment-specific ARN mappings
- Workflow file recommendations (e.g., copy `setup-files/deploy.yml`)
- Troubleshooting commands and manual verification steps

Treat it as the latest source of truth when configuring GitHub Actions.

## Security Best Practices

### IAM Permissions

The bundled policy balances least privilege with the actions required by Pulumi-managed resources:

- EC2, VPC, and networking (for FCK-NAT and security groups)
- RDS, App Runner, Lambda, CloudWatch, Events, SNS/SQS
- ECR image push/pull operations
- IAM CRUD for roles/policies associated with GitHub OIDC
- Budgets/Cost Explorer, WAF, CloudFront, SSM, KMS, AWS Backup

### Access Key Hygiene

- Store keys outside of Git repositories (shell profiles, AWS credentials file, or secrets manager)
- Rotate keys regularly and delete unused keys
- Prefer workload IAM roles for runtime services—long-lived users are only for bootstrapping

### GitHub Actions Hardening

- Use OIDC-based roles (provided by the Pulumi stacks) instead of static AWS keys
- Create GitHub environments with reviewers for production deploys
- Align branch protection rules with the trust policy subjects (`ref:refs/heads/*` and `environment:*` entries)

## Troubleshooting

### Frequent Issues

1. **`aws` CLI not found** — install from the [AWS CLI documentation](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).
2. **`jq` missing** — install via your package manager (`sudo apt-get install jq`, `brew install jq`, etc.).
3. **`pulumi` missing** — run `curl -fsSL https://get.pulumi.com | sh` and add `$HOME/.pulumi/bin` to your `PATH`.
4. **`gh` CLI missing** — install from <https://cli.github.com/>; authenticate with `gh auth login`.
5. **"User already exists"** — the IAM script will prompt whether to update the policy or rotate keys; choose the desired action.
6. **"Environment not deployed"** — build and deploy first (`npm run build`, `npm run dev:up` / `staging:up` / `prod:up`).

### Permission Errors

1. Ensure the caller used to bootstrap (usually your admin profile) has full IAM permissions.
2. Confirm the IaC user exists and the policy is attached (`aws iam list-attached-user-policies`).
3. Verify access keys are active (`aws iam list-access-keys`).
4. Run `./setup-scripts/validate-setup.sh` again to surface missing capabilities.

### Debug Commands

```bash
aws sts get-caller-identity
aws iam list-users
aws iam list-attached-user-policies --user-name iac-user
pulumi stack ls
pulumi stack output
```

Use the additional commands printed inside `github-actions-config.md` for App Runner, IAM, and ECR lookups.

## Integration with CI/CD

After bootstrapping:

1. Copy workflow templates from `setup-files/` into `.github/workflows/` and adjust the `APP_NAME` variable.
2. Add secrets/variables using the generated config file or `configure-github-secrets.sh`.
3. Configure GitHub branch protection and environment approval rules to mirror the IAM trust policy.
4. Push to `develop`, `main`, or create a release tag to test dev/staging/prod workflows respectively.

## Support

If you get stuck:

1. Re-run the validator script for live diagnostics.
2. Inspect `github-actions-config.md` for missing ARNs or instructions.
3. Cross-reference the wider documentation: `IAC-USER-PERMISSIONS.md`, `CICD-IMPLEMENTATION-GUIDE.md`, and `CLAUDE.md`.

## Contributing

- Exercise the scripts against fresh AWS accounts and alternate regions.
- Harden error handling and user feedback where you spot gaps.
- Extend GitHub automation (e.g., add support for repository-level environments) as requirements evolve.

All scripts are idempotent—feel free to re-run them whenever you change infrastructure or credentials.
