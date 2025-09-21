import * as aws from "@pulumi/aws";
import * as costexplorer from "@pulumi/aws/costexplorer";
import * as pulumi from "@pulumi/pulumi";
import { MonitoringArgs } from "../../shared/types";
import { commonTags } from "../../shared/config";

export class Monitoring extends pulumi.ComponentResource {
    public dashboard: aws.cloudwatch.Dashboard;
    public alarmTopic: aws.sns.Topic;
    public costBudget?: aws.budgets.Budget;
    public costAnomalyMonitor?: costexplorer.AnomalyMonitor;
    public costAnomalySubscription?: costexplorer.AnomalySubscription;

    constructor(name: string, args: MonitoringArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:monitoring:Monitoring", name, {}, opts);

        const tags = commonTags(args.environment);

        this.alarmTopic = new aws.sns.Topic(
            `${args.name}-alerts`,
            {
                name: `${args.name}-alerts-${args.environment}`,
                displayName: `${args.name} Alerts (${args.environment})`,
                tags: tags,
            },
            { parent: this },
        );

        if (args.alertEmail) {
            new aws.sns.TopicSubscription(
                `${args.name}-email-alert`,
                {
                    topic: this.alarmTopic.arn,
                    protocol: "email",
                    endpoint: args.alertEmail,
                },
                { parent: this },
            );
        }

        this.dashboard = this.createDashboard(args);
        this.createAppRunnerAlarms(args);
        this.createDatabaseAlarms(args);
        this.createLambdaAlarms(args);
        this.createSloAlarms(args);
        this.createCostMonitoring(args);

        this.registerOutputs({
            dashboardUrl: this.getDashboardUrl(),
            alarmTopicArn: this.alarmTopic.arn,
        });
    }

    private createDashboard(args: MonitoringArgs): aws.cloudwatch.Dashboard {
        const serviceName = this.getServiceName(args);
        const dbInstanceId = this.getDbInstanceId(args);
        const lambdaNames = this.getLambdaNames(args);
        const regionName = pulumi.output(aws.getRegion()).apply((r) => r.name);

        const dashboardBody = pulumi
            .all([serviceName, dbInstanceId, lambdaNames, regionName])
            .apply(([svc, db, lambdaList, region]) => {
                const widgets: any[] = [];

                if (svc) {
                    widgets.push({
                        type: "metric",
                        x: 0,
                        y: 0,
                        width: 12,
                        height: 6,
                        properties: {
                            metrics: [
                                ["AWS/AppRunner", "RequestCount", "ServiceName", svc],
                                [".", "ResponseTime", ".", "."],
                                [".", "ActiveInstances", ".", "."],
                                [".", "2xxStatusResponses", ".", "."],
                                [".", "4xxStatusResponses", ".", "."],
                                [".", "5xxStatusResponses", ".", "."],
                            ],
                            view: "timeSeries",
                            stacked: false,
                            region: region,
                            title: "App Runner Metrics",
                            period: 300,
                            stat: "Average",
                        },
                    });
                }

                if (db) {
                    widgets.push({
                        type: "metric",
                        x: 0,
                        y: 6,
                        width: 12,
                        height: 6,
                        properties: {
                            metrics: [
                                ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", db],
                                [".", "DatabaseConnections", ".", "."],
                                [".", "FreeStorageSpace", ".", "."],
                                [".", "ReadLatency", ".", "."],
                                [".", "WriteLatency", ".", "."],
                            ],
                            view: "timeSeries",
                            stacked: false,
                            region: region,
                            title: "RDS PostgreSQL Metrics",
                            period: 300,
                            stat: "Average",
                        },
                    });
                }

                if (lambdaList.length > 0) {
                    const lambdaMetrics = lambdaList.flatMap((functionName) => [
                        ["AWS/Lambda", "Duration", "FunctionName", functionName],
                        [".", "Invocations", ".", "."],
                        [".", "Errors", ".", "."],
                        [".", "Throttles", ".", "."],
                    ]);

                    widgets.push({
                        type: "metric",
                        x: 12,
                        y: 0,
                        width: 12,
                        height: 6,
                        properties: {
                            metrics: lambdaMetrics,
                            view: "timeSeries",
                            stacked: false,
                            region: region,
                            title: "Lambda Function Metrics",
                            period: 300,
                            stat: "Average",
                        },
                    });
                }

                widgets.push({
                    type: "metric",
                    x: 12,
                    y: 6,
                    width: 12,
                    height: 6,
                    properties: {
                        metrics: [["AWS/Billing", "EstimatedCharges", "Currency", "USD"]],
                        view: "timeSeries",
                        stacked: false,
                        region: "us-east-1",
                        title: "Estimated Charges (USD)",
                        period: 86400,
                        stat: "Maximum",
                    },
                });

                return JSON.stringify({ widgets });
            });

        return new aws.cloudwatch.Dashboard(
            `${args.name}-dashboard`,
            {
                dashboardName: `${args.name}-dashboard-${args.environment}`,
                dashboardBody: dashboardBody,
            },
            { parent: this },
        );
    }

    private createAppRunnerAlarms(args: MonitoringArgs): void {
        if (!args.serviceName) return;

        const tags = commonTags(args.environment);
        this.getServiceName(args).apply((serviceName) => {
            if (!serviceName) {
                return;
            }

            new aws.cloudwatch.MetricAlarm(
                `${args.name}-apprunner-response-time`,
                {
                    name: `${args.name}-apprunner-high-response-time-${args.environment}`,
                    alarmDescription: "App Runner service response time is high",
                    metricName: "ResponseTime",
                    namespace: "AWS/AppRunner",
                    statistic: "Average",
                    period: 300,
                    evaluationPeriods: 2,
                    threshold: args.environment === "prod" ? 1000 : 2000,
                    comparisonOperator: "GreaterThanThreshold",
                    dimensions: { ServiceName: serviceName },
                    alarmActions: [this.alarmTopic.arn],
                    tags: tags,
                },
                { parent: this },
            );

            new aws.cloudwatch.MetricAlarm(
                `${args.name}-apprunner-error-rate`,
                {
                    name: `${args.name}-apprunner-high-error-rate-${args.environment}`,
                    alarmDescription: "App Runner service error rate is high",
                    metricName: "5xxStatusResponses",
                    namespace: "AWS/AppRunner",
                    statistic: "Sum",
                    period: 300,
                    evaluationPeriods: 2,
                    threshold: 10,
                    comparisonOperator: "GreaterThanThreshold",
                    dimensions: { ServiceName: serviceName },
                    alarmActions: [this.alarmTopic.arn],
                    tags: tags,
                },
                { parent: this },
            );
        });
    }

    private createDatabaseAlarms(args: MonitoringArgs): void {
        if (!args.dbInstanceId) return;

        const tags = commonTags(args.environment);
        this.getDbInstanceId(args).apply((dbInstanceId) => {
            if (!dbInstanceId) {
                return;
            }

            new aws.cloudwatch.MetricAlarm(
                `${args.name}-db-cpu-utilization`,
                {
                    name: `${args.name}-db-high-cpu-${args.environment}`,
                    alarmDescription: "Database CPU utilization is high",
                    metricName: "CPUUtilization",
                    namespace: "AWS/RDS",
                    statistic: "Average",
                    period: 300,
                    evaluationPeriods: 2,
                    threshold: args.environment === "prod" ? 80 : 90,
                    comparisonOperator: "GreaterThanThreshold",
                    dimensions: { DBInstanceIdentifier: dbInstanceId },
                    alarmActions: [this.alarmTopic.arn],
                    tags: tags,
                },
                { parent: this },
            );

            new aws.cloudwatch.MetricAlarm(
                `${args.name}-db-free-storage`,
                {
                    name: `${args.name}-db-low-storage-${args.environment}`,
                    alarmDescription: "Database free storage space is low",
                    metricName: "FreeStorageSpace",
                    namespace: "AWS/RDS",
                    statistic: "Average",
                    period: 300,
                    evaluationPeriods: 1,
                    threshold: 2147483648,
                    comparisonOperator: "LessThanThreshold",
                    dimensions: { DBInstanceIdentifier: dbInstanceId },
                    alarmActions: [this.alarmTopic.arn],
                    tags: tags,
                },
                { parent: this },
            );

            new aws.cloudwatch.MetricAlarm(
                `${args.name}-db-connections`,
                {
                    name: `${args.name}-db-high-connections-${args.environment}`,
                    alarmDescription: "Database connection count is high",
                    metricName: "DatabaseConnections",
                    namespace: "AWS/RDS",
                    statistic: "Average",
                    period: 300,
                    evaluationPeriods: 2,
                    threshold: args.environment === "prod" ? 80 : 40,
                    comparisonOperator: "GreaterThanThreshold",
                    dimensions: { DBInstanceIdentifier: dbInstanceId },
                    alarmActions: [this.alarmTopic.arn],
                    tags: tags,
                },
                { parent: this },
            );
        });
    }

    private createLambdaAlarms(args: MonitoringArgs): void {
        if (!args.lambdaFunctionNames || args.lambdaFunctionNames.length === 0) return;

        const tags = commonTags(args.environment);
        this.forEachLambdaName(args, (functionName) => {
            new aws.cloudwatch.MetricAlarm(
                `${args.name}-lambda-${functionName}-errors`,
                {
                    name: `${args.name}-lambda-${functionName}-errors-${args.environment}`,
                    alarmDescription: `Lambda function ${functionName} error rate is high`,
                    metricName: "Errors",
                    namespace: "AWS/Lambda",
                    statistic: "Sum",
                    period: 300,
                    evaluationPeriods: 2,
                    threshold: 5,
                    comparisonOperator: "GreaterThanThreshold",
                    dimensions: { FunctionName: functionName },
                    alarmActions: [this.alarmTopic.arn],
                    tags: tags,
                },
                { parent: this },
            );

            new aws.cloudwatch.MetricAlarm(
                `${args.name}-lambda-${functionName}-duration`,
                {
                    name: `${args.name}-lambda-${functionName}-duration-${args.environment}`,
                    alarmDescription: `Lambda function ${functionName} duration is high`,
                    metricName: "Duration",
                    namespace: "AWS/Lambda",
                    statistic: "Average",
                    period: 300,
                    evaluationPeriods: 2,
                    threshold: 25000,
                    comparisonOperator: "GreaterThanThreshold",
                    dimensions: { FunctionName: functionName },
                    alarmActions: [this.alarmTopic.arn],
                    tags: tags,
                },
                { parent: this },
            );

            new aws.cloudwatch.MetricAlarm(
                `${args.name}-lambda-${functionName}-throttles`,
                {
                    name: `${args.name}-lambda-${functionName}-throttles-${args.environment}`,
                    alarmDescription: `Lambda function ${functionName} is being throttled`,
                    metricName: "Throttles",
                    namespace: "AWS/Lambda",
                    statistic: "Sum",
                    period: 300,
                    evaluationPeriods: 1,
                    threshold: 1,
                    comparisonOperator: "GreaterThanOrEqualToThreshold",
                    dimensions: { FunctionName: functionName },
                    alarmActions: [this.alarmTopic.arn],
                    tags: tags,
                },
                { parent: this },
            );
        });
    }

    private createSloAlarms(args: MonitoringArgs): void {
        const tags = commonTags(args.environment);

        if (args.serviceName) {
            this.getServiceName(args).apply((serviceName) => {
                if (!serviceName) {
                    return;
                }

                new aws.cloudwatch.MetricAlarm(
                    `${args.name}-apprunner-p95-rt`,
                    {
                        name: `${args.name}-apprunner-p95-response-${args.environment}`,
                        alarmDescription: "App Runner p95 response time SLO",
                        metricName: "ResponseTime",
                        namespace: "AWS/AppRunner",
                        extendedStatistic: "p95",
                        period: 300,
                        evaluationPeriods: 2,
                        threshold: args.environment === "prod" ? 1000 : 2000,
                        comparisonOperator: "GreaterThanThreshold",
                        dimensions: { ServiceName: serviceName },
                        alarmActions: [this.alarmTopic.arn],
                        tags: tags,
                    },
                    { parent: this },
                );

                new aws.cloudwatch.MetricAlarm(
                    `${args.name}-apprunner-error-rate-pct`,
                    {
                        name: `${args.name}-apprunner-error-rate-pct-${args.environment}`,
                        alarmDescription: "App Runner 5xx error rate exceeds SLO",
                        comparisonOperator: "GreaterThanThreshold",
                        threshold: args.environment === "prod" ? 1 : 5,
                        evaluationPeriods: 2,
                        treatMissingData: "notBreaching",
                        metricQueries: [
                            {
                                id: "m5xx",
                                metric: {
                                    metricName: "5xxStatusResponses",
                                    namespace: "AWS/AppRunner",
                                    dimensions: { ServiceName: serviceName },
                                    period: 300,
                                    stat: "Sum",
                                },
                                returnData: false,
                            },
                            {
                                id: "mreq",
                                metric: {
                                    metricName: "RequestCount",
                                    namespace: "AWS/AppRunner",
                                    dimensions: { ServiceName: serviceName },
                                    period: 300,
                                    stat: "Sum",
                                },
                                returnData: false,
                            },
                            {
                                id: "e1",
                                expression: "100 * m5xx / mreq",
                                label: "Error rate %",
                                returnData: true,
                            },
                        ],
                        alarmActions: [this.alarmTopic.arn],
                        tags: tags,
                    },
                    { parent: this },
                );
            });
        }

        if (args.lambdaFunctionNames && args.lambdaFunctionNames.length > 0) {
            this.forEachLambdaName(args, (functionName) => {
                new aws.cloudwatch.MetricAlarm(
                    `${args.name}-lambda-${functionName}-p95`,
                    {
                        name: `${args.name}-lambda-${functionName}-p95-${args.environment}`,
                        alarmDescription: `Lambda ${functionName} p95 duration SLO`,
                        metricName: "Duration",
                        namespace: "AWS/Lambda",
                        extendedStatistic: "p95",
                        period: 300,
                        evaluationPeriods: 2,
                        threshold: args.environment === "prod" ? 1000 : 2000,
                        comparisonOperator: "GreaterThanThreshold",
                        dimensions: { FunctionName: functionName },
                        alarmActions: [this.alarmTopic.arn],
                        tags: tags,
                    },
                    { parent: this },
                );

                new aws.cloudwatch.MetricAlarm(
                    `${args.name}-lambda-${functionName}-error-rate-pct`,
                    {
                        name: `${args.name}-lambda-${functionName}-error-rate-pct-${args.environment}`,
                        alarmDescription: `Lambda ${functionName} error rate exceeds SLO`,
                        comparisonOperator: "GreaterThanThreshold",
                        threshold: args.environment === "prod" ? 1 : 5,
                        evaluationPeriods: 2,
                        treatMissingData: "notBreaching",
                        metricQueries: [
                            {
                                id: "merr",
                                metric: {
                                    metricName: "Errors",
                                    namespace: "AWS/Lambda",
                                    dimensions: { FunctionName: functionName },
                                    period: 300,
                                    stat: "Sum",
                                },
                                returnData: false,
                            },
                            {
                                id: "minv",
                                metric: {
                                    metricName: "Invocations",
                                    namespace: "AWS/Lambda",
                                    dimensions: { FunctionName: functionName },
                                    period: 300,
                                    stat: "Sum",
                                },
                                returnData: false,
                            },
                            {
                                id: "e1",
                                expression: "100 * merr / minv",
                                label: "Error rate %",
                                returnData: true,
                            },
                        ],
                        alarmActions: [this.alarmTopic.arn],
                        tags: tags,
                    },
                    { parent: this },
                );
            });
        }
    }

    private createCostMonitoring(args: MonitoringArgs): void {
        const tags = commonTags(args.environment);
        const budgetAmount = args.environment === "prod" ? "200" : "50";

        this.costBudget = new aws.budgets.Budget(
            `${args.name}-cost-budget`,
            {
                name: `${args.name}-monthly-budget-${args.environment}`,
                budgetType: "COST",
                limitAmount: budgetAmount,
                limitUnit: "USD",
                timeUnit: "MONTHLY",
                timePeriodStart: `${new Date().toISOString().substring(0, 7)}-01_00:00`,
                costFilters: [
                    {
                        name: "TagKeyValue",
                        values: [pulumi.interpolate`Environment$${args.environment}`],
                    },
                ],
                notifications: [
                    {
                        comparisonOperator: "GREATER_THAN",
                        threshold: 80,
                        thresholdType: "PERCENTAGE",
                        notificationType: "ACTUAL",
                        subscriberEmailAddresses: args.alertEmail ? [args.alertEmail] : [],
                    },
                    {
                        comparisonOperator: "GREATER_THAN",
                        threshold: 100,
                        thresholdType: "PERCENTAGE",
                        notificationType: "FORECASTED",
                        subscriberEmailAddresses: args.alertEmail ? [args.alertEmail] : [],
                    },
                ],
                tags: tags,
            },
            { parent: this },
        );

        this.costAnomalyMonitor = new costexplorer.AnomalyMonitor(
            `${args.name}-cost-anomaly`,
            {
                name: `${args.name}-cost-anomaly-${args.environment}`,
                monitorType: "DIMENSIONAL",
                monitorDimension: "SERVICE",
                tags: tags,
            },
            { parent: this },
        );

        if (args.alertEmail) {
            this.costAnomalySubscription = new costexplorer.AnomalySubscription(
                `${args.name}-anomaly-subscription`,
                {
                    name: `${args.name}-anomaly-subscription-${args.environment}`,
                    frequency: "DAILY",
                    monitorArnLists: [this.costAnomalyMonitor.arn],
                    subscribers: [
                        {
                            type: "EMAIL",
                            address: args.alertEmail,
                        },
                    ],
                    tags: tags,
                },
                { parent: this },
            );
        }
    }

    private getServiceName(args: MonitoringArgs): pulumi.Output<string | undefined> {
        return pulumi.output(args.serviceName ?? undefined);
    }

    private getDbInstanceId(args: MonitoringArgs): pulumi.Output<string | undefined> {
        return pulumi.output(args.dbInstanceId ?? undefined);
    }

    private getLambdaNames(args: MonitoringArgs): pulumi.Output<string[]> {
        if (!args.lambdaFunctionNames || args.lambdaFunctionNames.length === 0) {
            return pulumi.output([]);
        }

        return pulumi
            .all(args.lambdaFunctionNames.map((name) => pulumi.output(name)))
            .apply((names) => names.filter((n): n is string => !!n));
    }

    private forEachLambdaName(args: MonitoringArgs, cb: (functionName: string) => void): void {
        this.getLambdaNames(args).apply((names) => {
            names.forEach((fn) => cb(fn));
        });
    }

    public getDashboardUrl(): pulumi.Output<string> {
        const region = aws.getRegion();
        return pulumi
            .all([this.dashboard.dashboardName, region])
            .apply(
                ([name, r]) =>
                    `https://${r.name}.console.aws.amazon.com/cloudwatch/home?region=${r.name}#dashboards:name=${name}`,
            );
    }

    public getAlarmTopicArn(): pulumi.Output<string> {
        return this.alarmTopic.arn;
    }

    public getBudgetName(): pulumi.Output<string> {
        return this.costBudget ? this.costBudget.name : pulumi.output("");
    }
}
