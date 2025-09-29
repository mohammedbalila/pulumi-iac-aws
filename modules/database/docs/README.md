# Database (RDS PostgreSQL) — Rationale and Practices

## Purpose

Provision a cost‑aware PostgreSQL instance with secure private networking, environment‑sensitive availability and backups, and explicit access from allowed security groups.

## Key Design Choices

- Storage: GP3 with encryption; `allocatedStorage` minimal with `maxAllocatedStorage` autoscale.
- Availability: Multi‑AZ only in prod; single‑AZ in dev/stage for cost.
- Backups: longer retention in prod; maintenance windows defined.
- Networking: private subnets only; SG ingress limited to allowed service security groups (e.g., App Runner).
- Parameter group: enable `pg_stat_statements`, bounded `max_connections`, and verbose logs only in non‑prod.

## Best Practices & Standards

- Security: no public access; encrypted storage; least privilege SG references.
- Reliability: backups enabled; deletion protection in prod; maintenance windows set.
- Cost: right‑size instance class (`db.t3.micro` non‑prod, `db.t4g.small` prod by default).

## Configuration Knobs

- `instanceClass`, `allocatedStorage`, `maxAllocatedStorage`.
- `allowedSecurityGroupIds` to permit multiple callers (preferred over single SG input).
- `dbName`, `username`, `password` are required; pass secrets via Pulumi config.

## Inputs

- `name`, `environment`
- `subnetIds` string[] (private)
- `securityGroupId` string or `allowedSecurityGroupIds` string[]
- `dbName`, `username`, `password`
- `instanceClass?`, `allocatedStorage?`, `maxAllocatedStorage?`

## Outputs

- `instanceId`, `endpoint`, `connectionString`

## Example (Pulumi)

```ts
import { Database } from "../../modules/database";

const db = new Database("db", {
    name: "db",
    environment: pulumi.getStack(),
    subnetIds: net.getPrivateSubnetIds(),
    allowedSecurityGroupIds: [appRunnerSgId],
    dbName: "appdb",
    username: "app",
    password: pulumi.secret(cfg.require("dbPassword")),
    instanceClass: pulumi.getStack() === "prod" ? "db.t4g.small" : "db.t3.micro",
});

export const dbEndpoint = db.getEndpoint();
```

## Security Considerations

- Restrict SG ingress to service SGs rather than CIDR; avoid public exposure entirely.
- Use SSM/Secrets Manager for credentials; avoid embedding in source.

## When to Choose Alternatives

- Higher availability in non‑prod for parity testing: turn on Multi‑AZ in staging.
- Heavy workloads: move to `r`/`m` instances, enable Performance Insights retention.

## Operational Notes

- Final snapshot on deletion only in prod; ensure naming/retention meet compliance.
