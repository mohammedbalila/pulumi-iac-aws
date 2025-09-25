import * as aws from "@pulumi/aws";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
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

const placeholderContextPath = path.resolve(__dirname, "../../shared/placeholder-app");

const hashDirectory = (dir: string): string => {
    const hash = crypto.createHash("sha256");

    const walk = (current: string) => {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        entries
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach((entry) => {
                const entryPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    walk(entryPath);
                } else if (entry.isFile()) {
                    hash.update(entry.name);
                    hash.update(fs.readFileSync(entryPath));
                }
            });
    };

    walk(dir);

    return hash.digest("hex");
};

const placeholderContextExists = fs.existsSync(placeholderContextPath);
const placeholderContextHash = placeholderContextExists
    ? hashDirectory(placeholderContextPath)
    : undefined;

export class ECRRepository extends pulumi.ComponentResource {
    public repository: aws.ecr.Repository;
    public lifecyclePolicy?: aws.ecr.LifecyclePolicy;
    public repositoryPolicy?: aws.ecr.RepositoryPolicy;
    private placeholderSeed?: command.local.Command;

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

        if (args.seedWithPlaceholderImage ?? true) {
            this.seedRepositoryWithPlaceholder(args.name, args.placeholderImageTag);
        }

        // Register outputs
        this.registerOutputs({
            repositoryUrl: this.repository.repositoryUrl,
            repositoryArn: this.repository.arn,
            repositoryName: this.repository.name,
        });
    }

    public getPlaceholderSeedResource(): command.local.Command | undefined {
        return this.placeholderSeed;
    }

    private seedRepositoryWithPlaceholder(baseName: string, placeholderTag?: string): void {
        if (!placeholderContextExists) {
            pulumi.log.warn("Placeholder image context not found. Skipping ECR seeding.", this);
            return;
        }

        const imageTag =
            placeholderTag && placeholderTag.trim().length > 0 ? placeholderTag : "latest";
        const region = pulumi.output(aws.getRegion());

        const createScript = pulumi
            .all([region, this.repository.repositoryUrl])
            .apply(([regionResult, repoUrl]) => {
                const registry = repoUrl.split("/")[0];
                return [
                    "set -euo pipefail",
                    `aws ecr get-login-password --region ${regionResult.name} | docker login --username AWS --password-stdin ${registry}`,
                    `docker build -t ${repoUrl}:${imageTag} .`,
                    `docker push ${repoUrl}:${imageTag}`,
                ].join("\n");
            });

        const deleteScript = this.repository.repositoryUrl.apply(
            (repoUrl) => `docker rmi ${repoUrl}:${imageTag} || true`,
        );

        this.placeholderSeed = new command.local.Command(
            `${baseName}-seed-placeholder-image`,
            {
                create: createScript,
                delete: deleteScript,
                interpreter: ["bash", "-c"],
                dir: placeholderContextPath,
                environment: {
                    AWS_PAGER: "",
                },
                triggers: [this.repository.repositoryUrl, imageTag, placeholderContextHash ?? ""],
            },
            {
                parent: this,
                dependsOn: [this.repository],
            },
        );
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
