# Monitoring — Rationale and Practices

## Purpose

Provide SLO‑oriented monitoring and cost visibility via CloudWatch dashboards/alarms, SNS notifications, Budgets, and Cost Explorer anomaly detection.

## Key Design Choices

- SLO alarms: p95 latency and error‑rate % for App Runner and Lambda complement traditional alarms.
- Dashboard includes service, DB, Lambda, and cost widgets for a single pane of glass.
- Budgets notify at 80% actual and 100% forecast; anomaly monitor for daily spikes by service.
- Email subscription optional per environment.

## Best Practices & Standards

- Observability: percentiles over averages; treat missing data as not breaching for rate metrics.
- Cost awareness: budgets and anomalies are first‑class; tags filter costs by environment.
- Operations: alarms notify a centralized SNS; integrate with email or downstream tools.

## Configuration Knobs

- `serviceName`, `dbInstanceId`, `lambdaFunctionNames`, `alertEmail`.
- Thresholds vary by environment (stricter in prod).

## Inputs

- `name`, `environment`
- `serviceName?` string (App Runner)
- `dbInstanceId?` string (RDS)
- `lambdaFunctionNames?` string[]
- `alertEmail?` string

## Outputs

- `dashboardUrl`, `alarmTopicArn`

## Example (Pulumi)

```ts
import { Monitoring } from "../../modules/monitoring";

const mon = new Monitoring("obs", {
    name: "obs",
    environment: pulumi.getStack(),
    serviceName: app.service.serviceName,
    dbInstanceId: db.instance.id,
    lambdaFunctionNames: [fn.getFunctionName()],
    alertEmail: "alerts@example.com",
});

export const dashboard = mon.getDashboardUrl();
```

## Security Considerations

- No secrets stored; SNS topics are tagged; email subscription requires click‑through confirmation.

## When to Choose Alternatives

- Additional SLOs: add metric math expressions for custom error budgets/latency targets.
- External tools: export metrics to third‑party APMs if required by org standards.

## Operational Notes

- Dashboard URL is output for quick console access; ensure region is correct for billing metrics.
