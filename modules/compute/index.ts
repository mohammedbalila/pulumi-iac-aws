import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as crypto from "crypto";
import { AppRunnerArgs } from "../../shared/types";
import { commonTags } from "../../shared/config";

const MIN_NAME_LENGTH = 4;
const DEFAULT_BASE_SEGMENT = "apprunner";
const FALLBACK_SEGMENT = "app0";

const sanitizeSegment = (value: string) =>
    value
        .replace(/[^A-Za-z0-9-_]/g, "-")
        .replace(/[-_]{2,}/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "");

const ensureValidStart = (value: string) => {
    const trimmed = value.replace(/^[^A-Za-z0-9]+/, "");
    return trimmed || FALLBACK_SEGMENT;
};

const shrinkWithHash = (value: string, maxLength: number) => {
    if (value.length <= maxLength) {
        return value;
    }

    if (maxLength <= MIN_NAME_LENGTH) {
        return value.slice(0, maxLength);
    }

    const hashLength = Math.min(6, Math.max(2, maxLength - 2));
    const prefixLength = Math.max(1, maxLength - hashLength - 1);
    const hash = crypto.createHash("sha1").update(value).digest("hex").slice(0, hashLength);
    const prefix = value.slice(0, prefixLength).replace(/-+$/, "");
    const safePrefix = prefix || FALLBACK_SEGMENT.slice(0, prefixLength);
    const combined = `${safePrefix}-${hash}`;
    return combined.length > maxLength ? combined.slice(0, maxLength) : combined;
};

const buildName = (base: string, suffix: string, maxLength: number) => {
    const baseSegment = ensureValidStart(sanitizeSegment(base) || DEFAULT_BASE_SEGMENT);
    const suffixSegment = sanitizeSegment(suffix);

    let normalizedBase = baseSegment;
    let normalizedSuffix = suffixSegment;

    const hasSuffix = normalizedSuffix.length > 0;

    if (hasSuffix) {
        let baseBudget = maxLength - normalizedSuffix.length - 1;

        if (baseBudget < MIN_NAME_LENGTH) {
            const suffixAllowance = Math.max(0, maxLength - MIN_NAME_LENGTH - 1);
            if (suffixAllowance <= 0) {
                normalizedSuffix = "";
                baseBudget = maxLength;
            } else {
                normalizedSuffix = normalizedSuffix.slice(-suffixAllowance);
                baseBudget = MIN_NAME_LENGTH;
            }
        }

        normalizedBase = shrinkWithHash(normalizedBase, baseBudget);

        const availableForSuffix = maxLength - normalizedBase.length - 1;
        if (availableForSuffix <= 0) {
            normalizedSuffix = "";
        } else if (normalizedSuffix.length > availableForSuffix) {
            normalizedSuffix = normalizedSuffix.slice(-availableForSuffix);
        }
    } else {
        normalizedBase = shrinkWithHash(normalizedBase, maxLength);
    }

    let combined =
        normalizedSuffix && normalizedSuffix.length > 0
            ? `${normalizedBase}-${normalizedSuffix}`
            : normalizedBase;

    combined = sanitizeSegment(combined);
    combined = ensureValidStart(combined);

    if (combined.length > maxLength) {
        combined = combined.slice(0, maxLength).replace(/-+$/, "");
        combined = ensureValidStart(combined);
    }

    if (combined.length < MIN_NAME_LENGTH) {
        combined = (combined + "0000").slice(0, MIN_NAME_LENGTH);
    }

    return combined;
};

export class AppRunnerService extends pulumi.ComponentResource {
    public service: aws.apprunner.Service;
    public serviceUrl: pulumi.Output<string>;
    public autoScalingConfig: aws.apprunner.AutoScalingConfigurationVersion;
    // Removed connectionArn field - ECR-based deployment only
    public vpcConnector?: aws.apprunner.VpcConnector;
    private args: AppRunnerArgs;

    constructor(name: string, args: AppRunnerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:compute:AppRunnerService", name, {}, opts);

        this.args = args;
        const tags = commonTags(args.environment);

        // Validate source configuration - ECR image URI is required
        if (!args.ecrImageUri) {
            throw new pulumi.RunError(
                "App Runner services require ECR image URI for source configuration.",
            );
        }

        // ECR-based deployment only

        // Create auto-scaling configuration
        const autoScalingName = buildName(args.name, `autoscaling-${args.environment}`, 32);
        this.autoScalingConfig = new aws.apprunner.AutoScalingConfigurationVersion(
            `${args.name}-autoscaling`,
            {
                autoScalingConfigurationName: autoScalingName,

                // Cost optimization: Conservative scaling settings
                maxConcurrency: args.maxConcurrency || 25, // Requests per instance
                maxSize: args.maxSize || (args.environment === "prod" ? 5 : 2), // Max instances
                minSize: args.minSize ?? (args.environment === "prod" ? 2 : 0), // Scale to zero outside prod

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
            const vpcConnectorName = buildName(args.name, `vpc-connector-${args.environment}`, 32);
            this.vpcConnector = new aws.apprunner.VpcConnector(
                `${args.name}-vpc-connector`,
                {
                    vpcConnectorName: vpcConnectorName,
                    subnets: args.vpcSubnetIds,
                    securityGroups: args.vpcSecurityGroupIds,
                    tags,
                },
                { parent: this },
            );
            vpcConnectorArn = this.vpcConnector.arn;
        }

        // Create App Runner service
        const serviceName = buildName(args.name, `service-${args.environment}`, 40);
        this.service = new aws.apprunner.Service(
            `${args.name}-service`,
            {
                serviceName: serviceName,

                sourceConfiguration: this.createSourceConfiguration(),

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
                dependsOn: [], // Ensure connection is created first
            },
        );

        this.serviceUrl = this.service.serviceUrl;

        // Register outputs
        this.registerOutputs({
            serviceArn: this.service.arn,
            serviceUrl: this.serviceUrl,
            serviceName: this.service.serviceName,
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
                    policy: pulumi
                        .all([pulumi.all(paramArns), kmsArn])
                        .apply(([arns, k]) =>
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

    private createAccessRole(): aws.iam.Role {
        // Create IAM role for App Runner to access ECR
        const accessRole = new aws.iam.Role(
            `${this.getName()}-access-role`,
            {
                assumeRolePolicy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                        {
                            Action: "sts:AssumeRole",
                            Effect: "Allow",
                            Principal: {
                                Service: "build.apprunner.amazonaws.com",
                            },
                        },
                    ],
                }),
                tags: commonTags("shared"),
            },
            { parent: this },
        );

        // Attach the AWS-managed policy for ECR access
        new aws.iam.RolePolicyAttachment(
            `${this.getName()}-ecr-access-policy`,
            {
                role: accessRole.name,
                policyArn:
                    "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess",
            },
            { parent: this },
        );

        return accessRole;
    }

    private createSourceConfiguration(): any {
        // ECR-based deployment only
        return {
            autoDeploymentsEnabled: false, // Manual deployments via CI/CD
            authenticationConfiguration: {
                accessRoleArn: this.createAccessRole().arn,
            },
            imageRepository: {
                imageIdentifier: this.args.ecrImageUri,
                imageConfiguration: {
                    port: "8080", // App Runner default port
                    runtimeEnvironmentVariables: {
                        NODE_ENV: this.args.environment,
                        DATABASE_URL: this.args.databaseUrl,
                        PORT: "8080",
                        ...this.args.environmentVariables,
                    },
                    startCommand: this.args.startCommand || "npm start",
                },
                imageRepositoryType: "ECR",
            },
        };
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

    // Removed getConnectionArn() as GitHub integration is no longer supported

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
