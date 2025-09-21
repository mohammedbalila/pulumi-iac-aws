# Rationale and Standards

This document explains the design choices in this Pulumi (TypeScript) stack, how they map to AWS and IaC best practices, and where to tune behavior per environment.

## Goals
- Deliver a pragmatic, cost‑aware baseline for small/medium services.
- Keep modules composable (networking, compute, database, lambda, monitoring, waf).
- Encode sensible dev/staging defaults; raise reliability and observability in prod.

## Cross‑Cutting Choices
- Language & Framework: Pulumi with TypeScript for strong types and reuse. Modules are `ComponentResource`s with clear inputs/outputs (see `shared/types.ts`).
- Tagging: All resources use `commonTags(env)` for `Environment`, `Project`, and discoverability.
- Environments: `dev`, `staging`, `prod` stacks with conservative scaling in non‑prod.
- Secrets: Runtime secrets loaded via SSM (optional per module), avoiding hard‑coded values.
- Cost posture: Prefer minimal sizing by default, scale up only in prod (examples below).

## Module Highlights and Rationale
- Networking
  - Small VPC CIDR (`/24`) and `/26` subnets reduce wasted IPs while leaving room for growth.
  - Toggle between NAT Gateway and fck‑nat EC2 for outbound egress. fck‑nat is the dev/stage default to cut NAT Gateway fixed costs; NAT GW remains an option where managed reliability is preferred.
  - Per‑AZ route tables and explicit public/private segregation follow AWS VPC best practices.
- Compute (App Runner)
  - Public ingress ends at App Runner; optional VPC Connector enables private egress (e.g., to RDS) without public DB exposure.
  - Auto scaling config targets concurrency; dev can scale to zero, prod keeps at least one instance.
  - Observability (X‑Ray) enabled in prod; health checks standardize readiness endpoint.
- Database (RDS PostgreSQL)
  - GP3 storage, encryption on; Multi‑AZ only in prod; backups longer in prod.
  - Security group model enforces ingress from known SGs (App Runner, Lambda), no public access.
  - Parameter group includes `pg_stat_statements` for performance insight.
- Lambda
  - Per‑function IAM policy scopes CloudWatch Logs to the specific log group; optional SSM read.
  - DLQ only in prod; tracing active in prod; reserved concurrency limited in dev to control cost.
  - Optional VPC config when accessing private resources.
- Monitoring
  - SLO‑oriented alarms (p95 latency and error rate percent) complement traditional alarms.
  - CloudWatch dashboard includes App Runner, Lambda, RDS, and cost widgets.
  - Budgets and Cost Explorer anomaly monitoring notify via SNS/email.
- WAF
  - AWS managed rule groups + rate‑based rule; regional scope for App Runner.

## Best Practices Alignment
- AWS Well‑Architected: security groups least privilege, encryption at rest, health checks, alarms, backup windows, multi‑AZ in prod, cost visibility.
- Pulumi: `ComponentResource` composition, typed inputs/outputs, `registerOutputs`, avoiding imperative SDK calls in business logic.
- Security: no public RDS, scoped IAM policies, tracing/logging only with necessary permissions.
- Cost: scale‑to‑zero for dev where possible, fck‑nat toggle, minimal sizes in non‑prod, log retention tuned.

## When to Adjust
- Throughput spiky or sustained: raise App Runner `maxSize`/`maxConcurrency` and CPU/memory.
- Higher reliability: use NAT Gateways per AZ; consider RDS Multi‑AZ in staging for parity testing.
- Strict compliance: add WAF custom rules, narrower SGs, longer log retention, KMS CMKs.
- Private ingress: front App Runner with CloudFront + WAF or an ALB with private origins.

## References
- AWS Well‑Architected Framework
- Pulumi best practices (components, config/secrets)
- AWS service docs: App Runner, RDS, Lambda, CloudWatch, WAF

