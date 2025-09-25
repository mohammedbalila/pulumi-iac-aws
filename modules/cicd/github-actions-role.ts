import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { commonTags } from "../../shared/config";

export interface GitHubActionsRoleArgs {
    name: string;
    environment: string;
    githubOrg: string;
    githubRepo: string;
    githubBranches?: string[];
    githubEnvironments?: string[];
    ecrRepositoryArns: pulumi.Input<string>[];
    additionalPolicyArns?: string[];
}

export class GitHubActionsRole extends pulumi.ComponentResource {
    public role: aws.iam.Role;
    public oidcProvider: aws.iam.OpenIdConnectProvider;

    constructor(name: string, args: GitHubActionsRoleArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:security:GitHubActionsRole", name, {}, opts);

        const hasBranchSubjects =
            Array.isArray(args.githubBranches) && args.githubBranches.length > 0;
        const hasEnvironmentSubjects =
            Array.isArray(args.githubEnvironments) && args.githubEnvironments.length > 0;

        if (!hasBranchSubjects && !hasEnvironmentSubjects) {
            throw new Error(
                "GitHubActionsRole requires at least one GitHub branch or environment to be specified.",
            );
        }

        const tags = commonTags(args.environment);

        // Create OIDC provider for GitHub Actions
        this.oidcProvider = new aws.iam.OpenIdConnectProvider(
            `${args.name}-github-oidc`,
            {
                url: "https://token.actions.githubusercontent.com",
                clientIdLists: ["sts.amazonaws.com"],
                thumbprintLists: [
                    "6938fd4d98bab03faadb97b34396831e3780aea1", // GitHub Actions thumbprint
                    "1c58a3a8518e8759bf075b76b750d4f2df264fcd", // Backup thumbprint
                ],
                tags: {
                    ...tags,
                    Name: `${args.name}-github-oidc`,
                },
            },
            { parent: this },
        );

        // Create IAM role that can be assumed by GitHub Actions
        this.role = new aws.iam.Role(
            `${args.name}-github-actions-role`,
            {
                name: `GitHubActions-${args.name}-${args.environment}`,
                assumeRolePolicy: this.createAssumeRolePolicy(args),
                managedPolicyArns: [
                    // Basic permissions for GitHub Actions
                    "arn:aws:iam::aws:policy/ReadOnlyAccess",
                    ...(args.additionalPolicyArns || []),
                ],
                inlinePolicies: [
                    {
                        name: "ECRAndAppRunnerPolicy",
                        policy: this.createInlinePolicy(args),
                    },
                ],
                tags: {
                    ...tags,
                    Name: `GitHubActions-${args.name}-${args.environment}`,
                },
            },
            { parent: this },
        );

        // Register outputs
        this.registerOutputs({
            roleArn: this.role.arn,
            roleName: this.role.name,
            oidcProviderArn: this.oidcProvider.arn,
        });
    }

    private createAssumeRolePolicy(args: GitHubActionsRoleArgs): pulumi.Output<string> {
        return this.oidcProvider.arn.apply((oidcArn) => {
            const providerUrl = oidcArn.split("/").slice(1).join("/");
            const branchSubjects = (args.githubBranches || []).map(
                (branch) => `repo:${args.githubOrg}/${args.githubRepo}:ref:refs/heads/${branch}`,
            );
            const environmentSubjects = (args.githubEnvironments || []).map(
                (environment) =>
                    `repo:${args.githubOrg}/${args.githubRepo}:environment:${environment}`,
            );

            const subjectConditions = Array.from(
                new Set([...branchSubjects, ...environmentSubjects]),
            );

            return JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: "Allow",
                        Principal: {
                            Federated: oidcArn,
                        },
                        Action: "sts:AssumeRoleWithWebIdentity",
                        Condition: {
                            StringEquals: {
                                [`${providerUrl}:aud`]: "sts.amazonaws.com",
                            },
                            StringLike: {
                                [`${providerUrl}:sub`]: subjectConditions,
                            },
                        },
                    },
                ],
            });
        });
    }

    private createInlinePolicy(args: GitHubActionsRoleArgs): pulumi.Output<string> {
        const currentAccount = aws.getCallerIdentity();
        const currentRegion = aws.getRegion();

        if (!args.ecrRepositoryArns || args.ecrRepositoryArns.length === 0) {
            throw new Error("GitHubActionsRole requires at least one ECR repository ARN.");
        }

        return pulumi
            .all([currentAccount, currentRegion, pulumi.all(args.ecrRepositoryArns)])
            .apply(([account, region, ecrArns]) =>
                JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                        // ECR permissions for pushing images
                        {
                            Effect: "Allow",
                            Action: ["ecr:GetAuthorizationToken"],
                            Resource: "*",
                        },
                        {
                            Effect: "Allow",
                            Action: [
                                "ecr:BatchCheckLayerAvailability",
                                "ecr:GetDownloadUrlForLayer",
                                "ecr:BatchGetImage",
                                "ecr:InitiateLayerUpload",
                                "ecr:UploadLayerPart",
                                "ecr:CompleteLayerUpload",
                                "ecr:PutImage",
                            ],
                            Resource: ecrArns,
                        },
                        // App Runner permissions for deployments
                        {
                            Effect: "Allow",
                            Action: [
                                "apprunner:DescribeService",
                                "apprunner:UpdateService",
                                "apprunner:StartDeployment",
                                "apprunner:ListOperations",
                                "apprunner:DescribeOperation",
                            ],
                            Resource: [
                                `arn:aws:apprunner:${region.name}:${account.accountId}:service/${args.name}-*`,
                            ],
                        },
                        // Pulumi state management (if using S3 backend)
                        {
                            Effect: "Allow",
                            Action: [
                                "s3:GetObject",
                                "s3:PutObject",
                                "s3:DeleteObject",
                                "s3:ListBucket",
                            ],
                            Resource: [
                                `arn:aws:s3:::pulumi-${account.accountId}-${region.name}`,
                                `arn:aws:s3:::pulumi-${account.accountId}-${region.name}/*`,
                            ],
                        },
                        // CloudWatch logs for monitoring deployments
                        {
                            Effect: "Allow",
                            Action: [
                                "logs:CreateLogGroup",
                                "logs:CreateLogStream",
                                "logs:PutLogEvents",
                                "logs:DescribeLogGroups",
                                "logs:DescribeLogStreams",
                            ],
                            Resource: [
                                `arn:aws:logs:${region.name}:${account.accountId}:log-group:/aws/apprunner/${args.name}-*`,
                                `arn:aws:logs:${region.name}:${account.accountId}:log-group:/aws/apprunner/${args.name}-*:*`,
                            ],
                        },
                        // SSM for parameter access (if needed)
                        {
                            Effect: "Allow",
                            Action: [
                                "ssm:GetParameter",
                                "ssm:GetParameters",
                                "ssm:GetParametersByPath",
                            ],
                            Resource: [
                                `arn:aws:ssm:${region.name}:${account.accountId}:parameter/${args.name}/${args.environment}/*`,
                            ],
                        },
                        // KMS for decrypting secrets
                        {
                            Effect: "Allow",
                            Action: ["kms:Decrypt", "kms:DescribeKey"],
                            Resource: [
                                `arn:aws:kms:${region.name}:${account.accountId}:alias/aws/ssm`,
                                `arn:aws:kms:${region.name}:${account.accountId}:alias/aws/secretsmanager`,
                            ],
                        },
                    ],
                }),
            );
    }

    // Helper methods
    public getRoleArn(): pulumi.Output<string> {
        return this.role.arn;
    }

    public getRoleName(): pulumi.Output<string> {
        return this.role.name;
    }

    public getOIDCProviderArn(): pulumi.Output<string> {
        return this.oidcProvider.arn;
    }
}

// Factory function to create GitHub Actions roles for all environments
export function createGitHubActionsRoles(
    appName: string,
    githubOrg: string,
    githubRepo: string,
    ecrRepositoryArns: {
        dev: pulumi.Input<string>;
        staging: pulumi.Input<string>;
        prod: pulumi.Input<string>;
    },
    opts?: pulumi.ComponentResourceOptions,
): {
    dev: GitHubActionsRole;
    staging: GitHubActionsRole;
    prod: GitHubActionsRole;
} {
    return {
        dev: new GitHubActionsRole(
            `${appName}-dev-github-role`,
            {
                name: appName,
                environment: "dev",
                githubOrg,
                githubRepo,
                githubBranches: ["develop"],
                githubEnvironments: ["dev"],
                ecrRepositoryArns: [ecrRepositoryArns.dev],
            },
            opts,
        ),
        staging: new GitHubActionsRole(
            `${appName}-staging-github-role`,
            {
                name: appName,
                environment: "staging",
                githubOrg,
                githubRepo,
                githubBranches: ["staging"],
                githubEnvironments: ["staging"],
                ecrRepositoryArns: [ecrRepositoryArns.staging],
            },
            opts,
        ),
        prod: new GitHubActionsRole(
            `${appName}-prod-github-role`,
            {
                name: appName,
                environment: "prod",
                githubOrg,
                githubRepo,
                githubBranches: ["main"],
                githubEnvironments: ["prod"],
                ecrRepositoryArns: [ecrRepositoryArns.prod],
                additionalPolicyArns: [
                    // Production may need additional permissions
                    "arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess",
                ],
            },
            opts,
        ),
    };
}
