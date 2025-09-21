import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { LambdaArgs } from "../../shared/types";
import { commonTags } from "../../shared/config";

export class LambdaFunction extends pulumi.ComponentResource {
    public function: aws.lambda.Function;
    public role: aws.iam.Role;
    public logGroup: aws.cloudwatch.LogGroup;
    public alias?: aws.lambda.Alias;

    constructor(name: string, args: LambdaArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:lambda:LambdaFunction", name, {}, opts);

        const tags = commonTags(args.environment);

        // Create IAM role for Lambda
        this.role = new aws.iam.Role(
            `${args.name}-lambda-role`,
            {
                assumeRolePolicy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                        {
                            Action: "sts:AssumeRole",
                            Effect: "Allow",
                            Principal: {
                                Service: "lambda.amazonaws.com",
                            },
                        },
                    ],
                }),
                tags: tags,
            },
            { parent: this },
        );

        // Create scoped execution policy: restrict CloudWatch Logs access to this function's log group
        const acct = aws.getCallerIdentity();
        const region = aws.getRegion();
        const logGroupName = pulumi.interpolate`/aws/lambda/${args.name}-${args.environment}`;
        const logGroupArn = pulumi
            .all([acct, region, logGroupName])
            .apply(([a, r, lg]) => `arn:aws:logs:${r.name}:${a.accountId}:log-group:${lg}`);
        const logStreamArn = pulumi
            .all([acct, region, logGroupName])
            .apply(
                ([a, r, lg]) =>
                    `arn:aws:logs:${r.name}:${a.accountId}:log-group:${lg}:log-stream:*`,
            );

        const basePolicyDoc = pulumi.all([logGroupArn, logStreamArn]).apply(([lgArn, lsArn]) => ({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: [
                        "logs:CreateLogStream",
                        "logs:PutLogEvents",
                        "logs:DescribeLogStreams",
                    ],
                    Resource: [lgArn, lsArn],
                },
                // VPC ENI permissions (resource-level constraints not supported for these)
                {
                    Effect: "Allow",
                    Action: [
                        "ec2:CreateNetworkInterface",
                        "ec2:DescribeNetworkInterfaces",
                        "ec2:DeleteNetworkInterface",
                    ],
                    Resource: "*",
                },
            ],
        }));

        // Optionally allow reading SSM parameters in specified paths for runtime secrets
        const maybeAugmentedPolicyDoc = pulumi.all([basePolicyDoc]).apply(([doc]) => {
            if (args.ssmParameterPaths && args.ssmParameterPaths.length > 0) {
                const acct = aws.getCallerIdentity();
                const region = aws.getRegion();
                const paramArns = args.ssmParameterPaths.map((p) =>
                    pulumi
                        .all([p, acct, region])
                        .apply(
                            ([path, a, r]) =>
                                `arn:aws:ssm:${r.name}:${a.accountId}:parameter${path.endsWith("*") ? path : path + "*"}`,
                        ),
                );
                const kmsArn = pulumi
                    .all([acct, region])
                    .apply(([a, r]) => `arn:aws:kms:${r.name}:${a.accountId}:alias/aws/ssm`);
                return pulumi.all([paramArns, kmsArn]).apply(([arns, k]) => ({
                    ...doc,
                    Statement: [
                        ...doc.Statement,
                        {
                            Effect: "Allow",
                            Action: ["ssm:GetParameter", "ssm:GetParameters"],
                            Resource: arns,
                        },
                        { Effect: "Allow", Action: ["kms:Decrypt"], Resource: k },
                    ],
                }));
            }
            return doc;
        });

        const scopedPolicy = new aws.iam.Policy(
            `${args.name}-lambda-policy`,
            {
                policy: maybeAugmentedPolicyDoc.apply((doc) => JSON.stringify(doc)),
            },
            { parent: this },
        );

        new aws.iam.RolePolicyAttachment(
            `${args.name}-scoped-policy-attach`,
            {
                role: this.role.name,
                policyArn: scopedPolicy.arn,
            },
            { parent: this },
        );

        // Create CloudWatch log group
        this.logGroup = new aws.cloudwatch.LogGroup(
            `${args.name}-lambda-logs`,
            {
                name: `/aws/lambda/${args.name}-${args.environment}`,
                retentionInDays: args.environment === "prod" ? 14 : 7, // Cost optimization
                tags: tags,
            },
            { parent: this },
        );

        const functionName = `${args.name}-${args.environment}`;

        // Create Lambda function
        const publishFunction = args.publish ?? !!args.aliasName;

        this.function = new aws.lambda.Function(
            `${args.name}-lambda`,
            {
                name: functionName,
                code: args.code,
                handler: args.handler,
                runtime: args.runtime,
                role: this.role.arn,
                publish: publishFunction || undefined,

                // Performance and cost optimization
                timeout: args.timeout || 30, // 30 seconds default
                memorySize: args.memorySize || 128, // Start with minimum for cost optimization

                // Environment variables
                environment: {
                    variables: {
                        NODE_ENV: args.environment,
                        LOG_LEVEL: args.environment === "prod" ? "info" : "debug",
                        ...args.environmentVariables,
                    },
                },

                // Advanced configuration
                reservedConcurrentExecutions: args.environment === "prod" ? undefined : 5, // Limit for dev

                // Monitoring
                tracingConfig: {
                    mode: args.environment === "prod" ? "Active" : "PassThrough",
                },

                // Dead letter queue for production
                deadLetterConfig:
                    args.environment === "prod"
                        ? {
                              targetArn: this.createDLQ(functionName).arn,
                          }
                        : undefined,

                // VPC configuration when accessing private resources (e.g., RDS)
                vpcConfig:
                    args.subnetIds &&
                    args.subnetIds.length > 0 &&
                    args.securityGroupIds &&
                    args.securityGroupIds.length > 0
                        ? {
                              subnetIds: args.subnetIds,
                              securityGroupIds: args.securityGroupIds,
                          }
                        : undefined,

                tags: {
                    ...tags,
                    Name: `${args.name}-lambda`,
                    Runtime: args.runtime,
                },
            },
            {
                parent: this,
                dependsOn: [this.logGroup], // Ensure log group exists first
            },
        );

        if (args.aliasName) {
            this.alias = new aws.lambda.Alias(
                `${args.name}-lambda-alias`,
                {
                    name: args.aliasName,
                    functionName: this.function.name,
                    functionVersion: this.function.version,
                    description: `Alias for ${functionName}`,
                },
                { parent: this },
            );
        }

        // Register outputs
        this.registerOutputs({
            functionArn: this.function.arn,
            functionName: this.function.name,
            roleArn: this.role.arn,
            aliasArn: this.alias?.arn,
            version: this.function.version,
        });
    }

    private createDLQ(functionName: string): aws.sqs.Queue {
        const dlq = new aws.sqs.Queue(
            `${functionName}-dlq`,
            {
                name: `${functionName}-dlq`,
                messageRetentionSeconds: 1209600, // 14 days
                tags: commonTags("shared"),
            },
            { parent: this },
        );

        // Grant Lambda permission to send to DLQ
        const dlqPolicy = new aws.iam.Policy(
            `${functionName}-dlq-policy`,
            {
                policy: pulumi.interpolate`{
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": [
                            "sqs:SendMessage"
                        ],
                        "Resource": "${dlq.arn}"
                    }
                ]
            }`,
            },
            { parent: this },
        );

        new aws.iam.RolePolicyAttachment(
            `${functionName}-dlq-policy-attach`,
            {
                role: this.role.name,
                policyArn: dlqPolicy.arn,
            },
            { parent: this },
        );

        return dlq;
    }

    // Helper methods
    public getFunctionArn(): pulumi.Output<string> {
        return this.function.arn;
    }

    public getFunctionName(): pulumi.Output<string> {
        return this.function.name;
    }

    public addPermission(
        name: string,
        action: string,
        principal: string,
        sourceArn?: pulumi.Input<string>,
    ): aws.lambda.Permission {
        return new aws.lambda.Permission(
            `${name}-permission`,
            {
                function: this.function.name,
                action: action,
                principal: principal,
                sourceArn: sourceArn,
            },
            { parent: this },
        );
    }
}

// Utility class for managing multiple Lambda functions
export class LambdaGroup extends pulumi.ComponentResource {
    public functions: Map<string, LambdaFunction> = new Map();

    constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
        super("custom:lambda:LambdaGroup", name, {}, opts);
    }

    public addFunction(name: string, args: LambdaArgs): LambdaFunction {
        const lambdaFunction = new LambdaFunction(name, args, { parent: this });
        this.functions.set(name, lambdaFunction);
        return lambdaFunction;
    }

    public getFunction(name: string): LambdaFunction | undefined {
        return this.functions.get(name);
    }

    public getAllFunctions(): LambdaFunction[] {
        return Array.from(this.functions.values());
    }

    // Create API Gateway integration for HTTP triggers
    public createApiGateway(name: string, environment: string): aws.apigatewayv2.Api {
        const api = new aws.apigatewayv2.Api(
            `${name}-api`,
            {
                name: `${name}-api-${environment}`,
                protocolType: "HTTP",
                description: `HTTP API for ${name} Lambda functions`,
                corsConfiguration: {
                    allowCredentials: false,
                    allowHeaders: ["content-type", "authorization"],
                    allowMethods: ["*"],
                    allowOrigins: ["*"],
                    maxAge: 86400,
                },
                tags: commonTags(environment),
            },
            { parent: this },
        );

        // Create deployment
        const deployment = new aws.apigatewayv2.Deployment(
            `${name}-deployment`,
            {
                apiId: api.id,
                description: `Deployment for ${name} API`,
            },
            { parent: this },
        );

        // Create stage
        new aws.apigatewayv2.Stage(
            `${name}-stage`,
            {
                apiId: api.id,
                deploymentId: deployment.id,
                name: environment,
                description: `${environment} stage for ${name} API`,
                autoDeploy: true,
            },
            { parent: this },
        );

        return api;
    }

    // Create EventBridge rule for scheduled triggers
    public createScheduledRule(
        name: string,
        scheduleExpression: string,
        environment: string,
    ): aws.cloudwatch.EventRule {
        return new aws.cloudwatch.EventRule(
            `${name}-schedule`,
            {
                name: `${name}-schedule-${environment}`,
                description: `Scheduled trigger for ${name}`,
                scheduleExpression: scheduleExpression,
                tags: commonTags(environment),
            },
            { parent: this },
        );
    }
}
