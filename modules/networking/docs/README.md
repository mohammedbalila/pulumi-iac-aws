# Networking Module — Rationale and Practices

## Purpose
Provision a right‑sized VPC with public/private subnets, internet gateway, and configurable egress via either NAT Gateway or fck‑nat, with clean routing and tagging.

## Key Design Choices
- Compact addressing: VPC `/24` split into `/26` subnets to minimize IP waste while supporting multi‑AZ.
- AZ count: defaults to 2 for HA where needed without over‑provisioning.
- Egress strategy toggle:
  - NAT Gateway: simpler managed egress; recommended for prod.
  - fck‑nat: EC2‑based NAT substitute for substantial fixed‑cost savings in dev/stage.
- Public/private route tables and explicit associations per subnet.

## Best Practices & Standards
- AWS: segregate public/private subnets, NAT for private egress, least privilege SGs.
- Cost: prefer fck‑nat for non‑prod, NAT GW per AZ for prod workloads requiring managed reliability.
- Operations: `sourceDestCheck=false` on NAT instances, instance types sized by env (`t4g.nano` non‑prod).

## Configuration Knobs
- `cidrBlock`, `availabilityZoneCount`, `useFckNat`.
- Outputs: VPC ID, public/private subnet IDs, NAT cost info helper.

## Inputs
- `name` string — base name for resources.
- `environment` string — `dev|staging|prod` for tagging and defaults.
- `cidrBlock?` string — VPC CIDR (default `10.0.0.0/24`).
- `availabilityZoneCount?` number — default 2.
- `useFckNat?` boolean — toggle fck‑nat vs NAT GW.

## Outputs
- `vpcId` string
- `publicSubnetIds` string[]
- `privateSubnetIds` string[]

## Example (Pulumi)
```ts
import { Networking } from "../../modules/networking";

const net = new Networking("app", {
  name: "app",
  environment: pulumi.getStack(),
  cidrBlock: "10.1.0.0/24",
  availabilityZoneCount: 2,
  useFckNat: pulumi.getStack() !== "prod",
});

export const vpcId = net.vpc.id;
export const privateSubnets = net.getPrivateSubnetIds();
```

## Security Considerations
- fck‑nat SG restricts inbound to VPC CIDR; all egress allowed.
- No direct inbound to private subnets; public subnets only host IGW and optional NAT resources.

## When to Choose Alternatives
- Need higher resilience: prefer managed NAT Gateways per AZ.
- Need more IPs: increase VPC CIDR or add subnets with larger masks.

## Operational Notes
- Changing `useFckNat` flips egress model; plan applies will replace route tables accordingly.
- Tagging via `commonTags(env)` ensures consistent ownership and cost tracking.
