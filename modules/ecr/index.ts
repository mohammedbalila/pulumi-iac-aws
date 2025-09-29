import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { commonTags } from "../../shared/config";

export interface ECRArgs {
    name: string;
    environment: string;
    imageMutability?: "MUTABLE" | "IMMUTABLE";
    scanOnPush?: boolean;
    lifecyclePolicyText?: string;
    retentionDays?: number;
    seedWithPlaceholderImage?: boolean;
    placeholderImageTag?: string;
}

export class ECRRepository extends pulumi.ComponentResource {
    public repository: aws.ecr.Repository;
    public lifecyclePolicy?: aws.ecr.LifecyclePolicy;
    public repositoryPolicy?: aws.ecr.RepositoryPolicy;

    constructor(name: string, args: ECRArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:containers:ECRRepository", name, {}, opts);

        const tags = commonTags(args.environment);

        // Create ECR repository
        this.repository = new aws.ecr.Repository(
            `${args.name}-ecr`,
            {
                name: `${args.name}-${args.environment}`,
                imageScanningConfiguration: {
                    scanOnPush: args.scanOnPush ?? true,
                },
                imageTagMutability: args.imageMutability ?? "MUTABLE",
                encryptionConfigurations: [
                    {
                        encryptionType: "AES256", // Use AWS managed encryption for cost optimization
                    },
                ],
                tags: {
                    ...tags,
                    Name: `${args.name}-${args.environment}-ecr`,
                },
            },
            { parent: this },
        );

        // Create lifecycle policy for cost optimization
        const lifecyclePolicyText =
            args.lifecyclePolicyText ??
            this.getDefaultLifecyclePolicy(args.environment, args.retentionDays);

        this.lifecyclePolicy = new aws.ecr.LifecyclePolicy(
            `${args.name}-lifecycle-policy`,
            {
                repository: this.repository.name,
                policy: lifecyclePolicyText,
            },
            { parent: this },
        );

        // Create repository policy for cross-account access if needed
        if (args.environment === "prod") {
            this.repositoryPolicy = new aws.ecr.RepositoryPolicy(
                `${args.name}-repository-policy`,
                {
                    repository: this.repository.name,
                    policy: this.getRepositoryPolicy(),
                },
                { parent: this },
            );
        }

        // Register outputs
        this.registerOutputs({
            repositoryUrl: this.repository.repositoryUrl,
            repositoryArn: this.repository.arn,
            repositoryName: this.repository.name,
        });
    }

    private getDefaultLifecyclePolicy(environment: string, retentionDays?: number): string {
        // Environment-specific retention policies for cost optimization
        const environmentPolicies = {
            dev: {
                untaggedRetentionDays: retentionDays ?? 7,
                taggedRetentionCount: 5,
            },
            staging: {
                untaggedRetentionDays: retentionDays ?? 14,
                taggedRetentionCount: 10,
            },
            prod: {
                untaggedRetentionDays: retentionDays ?? 30,
                taggedRetentionCount: 20,
            },
        };

        const policy =
            environmentPolicies[environment as keyof typeof environmentPolicies] ||
            environmentPolicies.dev;

        return JSON.stringify({
            rules: [
                {
                    rulePriority: 1,
                    description: "Keep last N tagged images",
                    selection: {
                        tagStatus: "tagged",
                        tagPrefixList: ["v", "latest", "main", "develop", "staging", "prod"],
                        countType: "imageCountMoreThan",
                        countNumber: policy.taggedRetentionCount,
                    },
                    action: {
                        type: "expire",
                    },
                },
                {
                    rulePriority: 2,
                    description: "Delete untagged images older than N days",
                    selection: {
                        tagStatus: "untagged",
                        countType: "sinceImagePushed",
                        countUnit: "days",
                        countNumber: policy.untaggedRetentionDays,
                    },
                    action: {
                        type: "expire",
                    },
                },
            ],
        });
    }

    private getRepositoryPolicy(): Promise<string> {
        const currentAccount = aws.getCallerIdentity();

        return currentAccount.then((account) =>
            JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                    {
                        Sid: "AllowCrossAccountPull",
                        Effect: "Allow",
                        Principal: {
                            AWS: [
                                `arn:aws:iam::${account.accountId}:root`,
                                // Add other account IDs if needed for multi-account setup
                            ],
                        },
                        Action: [
                            "ecr:GetDownloadUrlForLayer",
                            "ecr:BatchGetImage",
                            "ecr:BatchCheckLayerAvailability",
                        ],
                    },
                    {
                        Sid: "AllowAppRunnerServiceRole",
                        Effect: "Allow",
                        Principal: {
                            Service: "build.apprunner.amazonaws.com",
                        },
                        Action: [
                            "ecr:GetDownloadUrlForLayer",
                            "ecr:BatchGetImage",
                            "ecr:BatchCheckLayerAvailability",
                        ],
                    },
                ],
            }),
        );
    }

    // Helper methods
    public getRepositoryUrl(): pulumi.Output<string> {
        return this.repository.repositoryUrl;
    }

    public getRepositoryArn(): pulumi.Output<string> {
        return this.repository.arn;
    }

    public getRepositoryName(): pulumi.Output<string> {
        return this.repository.name;
    }

    public getImageUri(tag: string = "latest"): pulumi.Output<string> {
        return this.repository.repositoryUrl.apply((url) => `${url}:${tag}`);
    }
}

// Factory function to create ECR repositories for all environments
export function createECRRepositories(
    appName: string,
    opts?: pulumi.ComponentResourceOptions,
): {
    dev: ECRRepository;
    staging: ECRRepository;
    prod: ECRRepository;
} {
    return {
        dev: new ECRRepository(
            `${appName}-dev-ecr`,
            {
                name: appName,
                environment: "dev",
                retentionDays: 7,
                imageMutability: "MUTABLE",
            },
            opts,
        ),
        staging: new ECRRepository(
            `${appName}-staging-ecr`,
            {
                name: appName,
                environment: "staging",
                retentionDays: 14,
                imageMutability: "MUTABLE",
            },
            opts,
        ),
        prod: new ECRRepository(
            `${appName}-prod-ecr`,
            {
                name: appName,
                environment: "prod",
                retentionDays: 30,
                imageMutability: "IMMUTABLE", // Production images should be immutable
            },
            opts,
        ),
    };
}
