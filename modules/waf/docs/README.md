# WAF — Rationale and Practices

## Purpose
Protect the public ingress surface with AWS WAFv2 using managed rule groups and a rate‑based rule, associated to the App Runner service (regional scope).

## Key Design Choices
- Managed rule groups: `AWSManagedRulesCommonRuleSet` and `KnownBadInputs` for broad coverage.
- Rate limiting: IP‑based rate rule (default 2000 req/5min) to mitigate bursts/DoS.
- Visibility: CloudWatch metrics and sampled requests enabled for debugging.

## Best Practices & Standards
- Apply WAF to all internet‑facing production services.
- Start with AWS managed rules; add custom rules only for concrete threats.
- Keep rate limits realistic to avoid false positives; tune per environment.

## Configuration Knobs
- `rateLimit` and target `resourceArn`.

## Inputs
- `name`, `environment`
- `resourceArn` string (App Runner service ARN)
- `rateLimit?` number (requests per 5 minutes per IP)

## Outputs
- `webAclArn`

## Example (Pulumi)
```ts
import { AppWaf } from "../../modules/waf";

const waf = new AppWaf("edge", {
  name: "edge",
  environment: pulumi.getStack(),
  resourceArn: app.getServiceArn(),
  rateLimit: pulumi.getStack() === "prod" ? 5000 : 2000,
});
```

## Security Considerations
- WAF is a layer in depth; still require secure headers, authn/z, and input validation in the app.

## When to Choose Alternatives
- Need edge controls: use CloudFront+WAF for global edge protections instead of regional.

## Operational Notes
- Association is automatic; verify metrics and sampled requests during rollout.
