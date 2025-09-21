import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { AppRunnerArgs } from "../../shared/types";
import { commonTags } from "../../shared/config";

export class AppRunnerService extends pulumi.ComponentResource {
    public service: aws.apprunner.Service;
    public serviceUrl: pulumi.Output<string>;
    public autoScalingConfig: aws.apprunner.AutoScalingConfigurationVersion;
    public connectionArn: pulumi.Output<string>;
    public vpcConnector?: aws.apprunner.VpcConnector;
    private args: AppRunnerArgs;

    constructor(name: string, args: AppRunnerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:compute:AppRunnerService", name, {}, opts);

        this.args = args;
        const tags = commonTags(args.environment);

        // Create GitHub connection for source code access
        const connection = new aws.apprunner.Connection(
            `${args.name}-github-connection`,
            {
                connectionName: `${args.name}-github-connection`,
                providerType: "GITHUB",
                tags: tags,
            },
            { parent: this },
        );

        this.connectionArn = connection.arn;

        // Create auto-scaling configuration
        this.autoScalingConfig = new aws.apprunner.AutoScalingConfigurationVersion(
            `${args.name}-autoscaling`,
            {
                autoScalingConfigurationName: `${args.name}-autoscaling-${args.environment}`,

                // Cost optimization: Conservative scaling settings
                maxConcurrency: args.maxConcurrency || 25, // Requests per instance
                maxSize: args.maxSize || (args.environment === "prod" ? 5 : 2), // Max instances
                minSize: args.minSize || (args.environment === "prod" ? 1 : 0), // Min instances (0 for dev)

                tags: tags,
            },
            { parent: this },
        );

        // Determine resource allocation based on environment
        const cpu = args.cpu || (args.environment === "prod" ? "0.5 vCPU" : "0.25 vCPU");
        const memory = args.memory || (args.environment === "prod" ? "1 GB" : "0.5 GB");

        // Optionally create a VPC connector for private networking (e.g., access to RDS)
        let vpcConnectorArn: pulumi.Input<string> | undefined = undefined;
        if (
            args.vpcSubnetIds &&
            args.vpcSubnetIds.length > 0 &&
            args.vpcSecurityGroupIds &&
            args.vpcSecurityGroupIds.length > 0
        ) {
            this.vpcConnector = new aws.apprunner.VpcConnector(
                `${args.name}-vpc-connector`,
                {
                    vpcConnectorName: `${args.name}-vpc-connector-${args.environment}`,
                    subnets: args.vpcSubnetIds,
                    securityGroups: args.vpcSecurityGroupIds,
                    tags,
                },
                { parent: this },
            );
            vpcConnectorArn = this.vpcConnector.arn;
        }

        // Create App Runner service
        this.service = new aws.apprunner.Service(
            `${args.name}-service`,
            {
                serviceName: `${args.name}-service-${args.environment}`,

                sourceConfiguration: {
                    autoDeploymentsEnabled: true,
                    authenticationConfiguration: {
                        connectionArn: connection.arn,
                    },
                    codeRepository: {
                        repositoryUrl: args.repositoryUrl,
                        sourceCodeVersion: {
                            type: "BRANCH",
                            value: args.branch || "main",
                        },
                        codeConfiguration: {
                            configurationSource: "API", // Use Pulumi config instead of apprunner.yaml
                            codeConfigurationValues: {
                                runtime: "NODEJS_22", // Adjust based on your application
                                buildCommand: "npm ci && npm run build",
                                startCommand: "npm start",
                                runtimeEnvironmentVariables: {
                                    NODE_ENV: args.environment,
                                    DATABASE_URL: args.databaseUrl,
                                    PORT: "8080", // App Runner default port
                                    ...args.environmentVariables,
                                },
                            },
                        },
                    },
                },

                autoScalingConfigurationArn: this.autoScalingConfig.arn,

                // Network configuration
                // - Public ingress enabled
                // - Optional VPC egress via connector for private resources (e.g., RDS)
                networkConfiguration: {
                    egressConfiguration: vpcConnectorArn
                        ? {
                              egressType: "VPC",
                              vpcConnectorArn: vpcConnectorArn,
                          }
                        : { egressType: "DEFAULT" },
                    ingressConfiguration: {
                        isPubliclyAccessible: true,
                    },
                },

                // Health check configuration
                healthCheckConfiguration: {
                    healthyThreshold: 1,
                    interval: 10,
                    path: "/health", // Ensure your app has a health endpoint
                    protocol: "HTTP",
                    timeout: 5,
                    unhealthyThreshold: 5,
                },

                // Instance configuration - cost optimized
                instanceConfiguration: {
                    cpu: cpu,
                    memory: memory,
                    instanceRoleArn: this.createInstanceRole().arn,
                },

                // Observability configuration
                observabilityConfiguration:
                    args.environment === "prod"
                        ? {
                              observabilityEnabled: true,
                              observabilityConfigurationArn: this.createObservabilityConfig().arn,
                          }
                        : undefined,

                tags: {
                    ...tags,
                    Name: `${args.name}-service`,
                },
            },
            {
                parent: this,
                dependsOn: [connection], // Ensure connection is created first
            },
        );

        this.serviceUrl = this.service.serviceUrl;

        // Register outputs
        this.registerOutputs({
            serviceArn: this.service.arn,
            serviceUrl: this.serviceUrl,
            serviceName: this.service.serviceName,
            connectionArn: this.connectionArn,
            vpcConnectorArn: this.vpcConnector?.arn,
        });
    }

    private createInstanceRole(): aws.iam.Role {
        // Create IAM role for App Runner service
        const role = new aws.iam.Role(
            `${this.getName()}-instance-role`,
            {
                assumeRolePolicy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                        {
                            Action: "sts:AssumeRole",
                            Effect: "Allow",
                            Principal: {
                                Service: "tasks.apprunner.amazonaws.com",
                            },
                        },
                    ],
                }),
                tags: commonTags("shared"),
            },
            { parent: this },
        );

        // Attach ECR access policy for App Runner to pull images if needed
        new aws.iam.RolePolicyAttachment(
            `${this.getName()}-basic-policy`,
            {
                role: role.name,
                policyArn:
                    "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess",
            },
            { parent: this },
        );

        // Attach X-Ray write access when observability is enabled
        new aws.iam.RolePolicyAttachment(
            `${this.getName()}-xray-write`,
            {
                role: role.name,
                policyArn: "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
            },
            { parent: this },
        );

        // Optional: Allow reading SSM parameters in specified paths for runtime secrets
        if (this.args && this.args.ssmParameterPaths && this.args.ssmParameterPaths.length > 0) {
            const acct = aws.getCallerIdentity();
            const region = aws.getRegion();
            const paramArns = this.args.ssmParameterPaths.map((p: pulumi.Input<string>) =>
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

            const ssmPolicy = new aws.iam.Policy(
                `${this.getName()}-apprunner-ssm-read`,
                {
                    policy: pulumi.all([paramArns, kmsArn]).apply(([arns, k]) =>
                        JSON.stringify({
                            Version: "2012-10-17",
                            Statement: [
                                {
                                    Effect: "Allow",
                                    Action: ["ssm:GetParameter", "ssm:GetParameters"],
                                    Resource: arns,
                                },
                                { Effect: "Allow", Action: ["kms:Decrypt"], Resource: k },
                            ],
                        }),
                    ),
                },
                { parent: this },
            );

            new aws.iam.RolePolicyAttachment(
                `${this.getName()}-apprunner-ssm-read-attach`,
                {
                    role: role.name,
                    policyArn: ssmPolicy.arn,
                },
                { parent: this },
            );
        }

        return role;
    }

    private createObservabilityConfig(): aws.apprunner.ObservabilityConfiguration {
        return new aws.apprunner.ObservabilityConfiguration(
            `${this.getName()}-observability`,
            {
                observabilityConfigurationName: `${this.getName()}-observability`,
                traceConfiguration: {
                    vendor: "AWSXRAY",
                },
                tags: commonTags("shared"),
            },
            { parent: this },
        );
    }

    // Helper methods
    public getServiceUrl(): pulumi.Output<string> {
        return this.serviceUrl;
    }

    public getServiceArn(): pulumi.Output<string> {
        return this.service.arn;
    }

    public getConnectionArn(): pulumi.Output<string> {
        return this.connectionArn;
    }

    private getName(): string {
        return pulumi.getStack();
    }
}

// Alternative Fargate implementation (commented out, but available if needed)
/*
export class FargateService extends pulumi.ComponentResource {
    public cluster: aws.ecs.Cluster;
    public service: aws.ecs.Service;
    public taskDefinition: aws.ecs.TaskDefinition;
    public loadBalancer: aws.lb.LoadBalancer;

    constructor(name: string, args: FargateArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:compute:FargateService", name, {}, opts);

        // ECS Cluster
        this.cluster = new aws.ecs.Cluster(`${name}-cluster`, {
            name: `${name}-cluster`,
            settings: [{
                name: "containerInsights",
                value: args.environment === "prod" ? "enabled" : "disabled",
            }],
        }, { parent: this });

        // Task Definition
        this.taskDefinition = new aws.ecs.TaskDefinition(`${name}-task`, {
            family: `${name}-task`,
            networkMode: "awsvpc",
            requiresCompatibilities: ["FARGATE"],
            cpu: "256", // 0.25 vCPU
            memory: "512", // 0.5 GB
            executionRoleArn: this.createExecutionRole().arn,
            taskRoleArn: this.createTaskRole().arn,

            containerDefinitions: JSON.stringify([{
                name: name,
                image: args.imageUri,
                portMappings: [{
                    containerPort: 8080,
                    protocol: "tcp",
                }],
                environment: [
                    { name: "NODE_ENV", value: args.environment },
                    { name: "DATABASE_URL", value: args.databaseUrl },
                ],
                logConfiguration: {
                    logDriver: "awslogs",
                    options: {
                        "awslogs-group": `/aws/ecs/${name}`,
                        "awslogs-region": aws.getRegion().then(r => r.name),
                        "awslogs-stream-prefix": "ecs",
                    },
                },
            }]),
        }, { parent: this });

        // ... rest of Fargate implementation
    }
}
*/
