# Lambda — Rationale and Practices

## Purpose
Define a secure, cost‑aware Lambda function baseline with least‑privilege IAM, environment‑scoped logging, optional VPC access, and production‑grade reliability toggles.

## Key Design Choices
- IAM policy scoped to the function’s own CloudWatch Logs group and streams.
- Optional read access to SSM parameter prefixes; includes KMS decrypt for SSM managed key.
- DLQ created and attached in prod; reserved concurrency capped in dev to control spend.
- Tracing: Active in prod, PassThrough in non‑prod.
- Log retention tuned by env (shorter in non‑prod).

## Best Practices & Standards
- Security: least‑privilege IAM; VPC ENI permissions only when needed; private subnet access optional.
- Cost: small `memorySize` defaults, sensible `timeout`, reserved concurrency limits in dev.
- Operability: standardized log groups and environment variables.

## Configuration Knobs
- `runtime`, `handler`, `code` (archive), `timeout`, `memorySize`.
- VPC: `subnetIds`, `securityGroupIds` when accessing private resources.
- Secrets: `ssmParameterPaths` for runtime configuration.

## Inputs
- `name`, `environment`
- `runtime`, `handler`, `code` (pulumi.asset.Archive)
- `environmentVariables?`, `timeout?`, `memorySize?`
- `subnetIds?`, `securityGroupIds?` (for VPC access)
- `ssmParameterPaths?` string[]

## Outputs
- `functionArn`, `functionName`, `roleArn`

## Example (Pulumi)
```ts
import * as pulumi from "@pulumi/pulumi";
import { LambdaFunction } from "../../modules/lambda";

const fn = new LambdaFunction("jobs", {
  name: "jobs",
  environment: pulumi.getStack(),
  runtime: "nodejs22.x",
  handler: "index.handler",
  code: new pulumi.asset.AssetArchive({
    "index.js": new pulumi.asset.StringAsset("exports.handler=async()=>({statusCode:200,body:'ok'})"),
  }),
  environmentVariables: { LOG_LEVEL: "debug" },
  subnetIds: net.getPrivateSubnetIds(),
  securityGroupIds: [lambdaSgId],
  ssmParameterPaths: [pulumi.interpolate`/app/${pulumi.getStack()}/`],
});
```

## Security Considerations
- Keep SSM parameter paths narrow; prefer `/project/env/...` patterns.
- Use SGs that only permit required egress; ingress not applicable for Lambda.

## When to Choose Alternatives
- Heavy networking or long‑running tasks: ECS/Fargate or App Runner might fit better.

## Operational Notes
- Add API Gateway or EventBridge via the helper methods when HTTP or scheduled triggers are needed.
