# Compute (App Runner) — Rationale and Practices

## Purpose
Expose a public HTTP service via AWS App Runner with optional private egress to VPC resources (e.g., RDS), and cost‑aware auto‑scaling.

## Key Design Choices
- GitHub connection managed by infra for consistent deployments.
- AutoScaling: conservative defaults; dev can scale to zero, prod keeps at least one instance.
- Instance sizing by environment (CPU/Memory) with overrides available.
- Optional VPC Connector for private access to DBs; ingress remains public.
- Health checks (`/health`) standardize readiness.
- Observability (X‑Ray) enabled in prod for tracing.
- Minimal, scoped instance IAM: ECR pull, optional SSM read, X‑Ray writes.

## Best Practices & Standards
- Twelve‑Factor readiness: immutable deployments, env vars, health checks.
- Security: public ingress at service; private DB access via VPC Connector; principle of least privilege in IAM.
- Cost: minimal capacity in non‑prod; right‑size resources before adding more instances.

## Configuration Knobs
- Scaling: `maxConcurrency`, `minSize`, `maxSize`.
- Sizing: `cpu`, `memory`.
- Networking: `vpcSubnetIds`, `vpcSecurityGroupIds` for private egress.
- Secrets: optional `ssmParameterPaths` grants read access to prefixed parameters.

## Inputs
- `name` string, `environment` string
- `repositoryUrl` string, `branch?` string
- `databaseUrl` string
- `environmentVariables?` map
- `maxConcurrency?` number, `maxSize?` number, `minSize?` number
- `cpu?` string, `memory?` string
- `vpcSubnetIds?` string[], `vpcSecurityGroupIds?` string[]
- `ssmParameterPaths?` string[]

## Outputs
- `serviceArn`, `serviceUrl`, `serviceName`
- `connectionArn`, `vpcConnectorArn?`

## Example (Pulumi)
```ts
import { AppRunnerService } from "../../modules/compute";

const svc = new AppRunnerService("web", {
  name: "web",
  environment: pulumi.getStack(),
  repositoryUrl: "https://github.com/acme/web",
  branch: "main",
  databaseUrl: pulumi.secret(db.connectionString),
  vpcSubnetIds: net.getPrivateSubnetIds(),
  vpcSecurityGroupIds: [db.getSecurityGroupId()],
  maxConcurrency: 25,
  minSize: pulumi.getStack() === "prod" ? 1 : 0,
  maxSize: pulumi.getStack() === "prod" ? 5 : 2,
  ssmParameterPaths: [pulumi.interpolate`/app/${pulumi.getStack()}/`],
});

export const url = svc.getServiceUrl();
```

## Security Considerations
- No public DB exposure; restrict DB SG to App Runner/Lambda SGs.
- Limit SSM access to specific parameter prefixes; include KMS decrypt for SSM managed key.

## When to Choose Alternatives
- Need more control/L7 features: consider ALB + ECS/Fargate.
- Private ingress or enterprise edge: front with CloudFront + WAF.

## Operational Notes
- `connectionArn` created by infra to avoid manual console links.
- Health check tuning (`interval`, `timeout`) may be required for heavy cold starts.
