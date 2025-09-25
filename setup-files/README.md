# Setup Files

This directory holds templates that operators copy into other systems while bootstrapping CI/CD around the Pulumi stacks:

- `deploy.yml` – reference GitHub Actions workflow used by the setup scripts. After you gather the required secrets/variables, copy this file into your application repository at `.github/workflows/deploy.yml` and adjust it for your app.
- `policy.json` and `current-policy.json` – baseline IAM policies that pair with the setup scripts (`create-iac-user.sh`, etc.). They are not applied automatically; review and adapt them before attaching to users/roles.

Pulumi itself does not read any files in `setup-files/`; they exist so teams have version-controlled examples to reuse when configuring CI and IAM outside the main IaC program.
