# Environment Profiles

This stack supports dev, staging, and prod with different defaults for cost, reliability, and observability.

## dev
- Scale: minimal; App Runner low CPU/memory, min instances 0–1.
- Networking: fck‑nat enabled by default to avoid NAT GW fixed cost.
- Database: single‑AZ, short backups, no deletion protection.
- Lambda: lower memory, reserved concurrency caps; tracing passthrough; shorter log retention.
- Monitoring: looser thresholds; budgets lower (e.g., $50), alerts still wired.

## staging
- Mirrors dev sizing unless parity is required for specific tests.
- Optional: enable NAT GW or Multi‑AZ RDS when testing prod‑like failovers.
- Monitoring: thresholds a bit stricter than dev to catch regressions.

## prod
- Scale: App Runner min >= 1, higher max; X‑Ray enabled.
- Networking: NAT Gateways per AZ preferred; no fck‑nat.
- Database: Multi‑AZ, longer backups, deletion protection on, Performance Insights enabled.
- Lambda: DLQ enabled; tracing active; longer log retention.
- Monitoring: strict SLO thresholds, full alarm set, budgets higher (e.g., $200+) and anomaly checks.
