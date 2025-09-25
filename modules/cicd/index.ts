import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { LambdaCicdPipelineArgs } from "../../shared/types";
import { commonTags } from "../../shared/config";

export class LambdaCicdPipeline extends pulumi.ComponentResource {
    public readonly artifactBucket: aws.s3.Bucket;
    public readonly codeBuildProject: aws.codebuild.Project;
    public readonly codePipeline: aws.codepipeline.Pipeline;
    public readonly codeDeployApplication: aws.codedeploy.Application;
    public readonly codeDeployDeploymentGroup: aws.codedeploy.DeploymentGroup;

    constructor(
        name: string,
        args: LambdaCicdPipelineArgs,
        opts?: pulumi.ComponentResourceOptions,
    ) {
        super("custom:cicd:LambdaCicdPipeline", name, {}, opts);

        const baseTags = commonTags(args.environment);
        const tags = {
            ...baseTags,
            Component: "cicd",
            Pipeline: `${args.name}-${args.environment}`,
        };

        const bucketArgs: aws.s3.BucketArgs = {
            versioning: { enabled: true },
            serverSideEncryptionConfiguration: {
                rule: {
                    applyServerSideEncryptionByDefault: {
                        sseAlgorithm: "AES256",
                    },
                },
            },
            forceDestroy: args.environment !== "prod",
            tags: tags,
        };

        if (args.artifactBucketName) {
            bucketArgs.bucket = args.artifactBucketName;
        }

        this.artifactBucket = new aws.s3.Bucket(`${name}-artifacts`, bucketArgs, { parent: this });

        new aws.s3.BucketPublicAccessBlock(
            `${name}-artifacts-pab`,
            {
                bucket: this.artifactBucket.id,
                blockPublicAcls: true,
                blockPublicPolicy: true,
                ignorePublicAcls: true,
                restrictPublicBuckets: true,
            },
            { parent: this },
        );

        const pipelineRole = new aws.iam.Role(
            `${name}-codepipeline-role`,
            {
                assumeRolePolicy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                        {
                            Effect: "Allow",
                            Action: "sts:AssumeRole",
                            Principal: {
                                Service: "codepipeline.amazonaws.com",
                            },
                        },
                    ],
                }),
                tags: tags,
            },
            { parent: this },
        );

        const codeBuildRole = new aws.iam.Role(
            `${name}-codebuild-role`,
            {
                assumeRolePolicy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                        {
                            Effect: "Allow",
                            Action: "sts:AssumeRole",
                            Principal: {
                                Service: "codebuild.amazonaws.com",
                            },
                        },
                    ],
                }),
                tags: tags,
            },
            { parent: this },
        );

        new aws.iam.RolePolicy(
            `${name}-codebuild-policy`,
            {
                role: codeBuildRole.id,
                policy: pulumi.all([this.artifactBucket.arn]).apply(([bucketArn]) =>
                    JSON.stringify({
                        Version: "2012-10-17",
                        Statement: [
                            {
                                Effect: "Allow",
                                Action: [
                                    "logs:CreateLogGroup",
                                    "logs:CreateLogStream",
                                    "logs:PutLogEvents",
                                ],
                                Resource: "*",
                            },
                            {
                                Effect: "Allow",
                                Action: [
                                    "s3:GetObject",
                                    "s3:GetObjectVersion",
                                    "s3:PutObject",
                                    "s3:ListBucket",
                                    "s3:GetBucketLocation",
                                ],
                                Resource: [bucketArn, `${bucketArn}/*`],
                            },
                        ],
                    }),
                ),
            },
            { parent: this },
        );

        const codeDeployRole = new aws.iam.Role(
            `${name}-codedeploy-role`,
            {
                assumeRolePolicy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                        {
                            Effect: "Allow",
                            Action: "sts:AssumeRole",
                            Principal: {
                                Service: "codedeploy.amazonaws.com",
                            },
                        },
                    ],
                }),
                tags: tags,
            },
            { parent: this },
        );

        new aws.iam.RolePolicyAttachment(
            `${name}-codedeploy-managed-policy`,
            {
                role: codeDeployRole.name,
                policyArn: "arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda",
            },
            { parent: this },
        );

        const buildSpec = args.buildSpec
            ? args.buildSpec
            : pulumi
                  .all([args.lambdaFunctionName, args.lambdaAliasName])
                  .apply(([functionName, aliasName]) => {
                      const appSpecContent = aliasName
                          ? `version: 0.0\\nResources:\\n  - lambdaFunction:\\n      Type: AWS::Lambda::Function\\n      Properties:\\n        Name: ${functionName}\\n        Alias: ${aliasName}\\n`
                          : `version: 0.0\\nResources:\\n  - lambdaFunction:\\n      Type: AWS::Lambda::Function\\n      Properties:\\n        Name: ${functionName}\\n`;

                      return [
                          "version: 0.2",
                          "phases:",
                          "  install:",
                          "    runtime-versions:",
                          "      nodejs: 22",
                          "  build:",
                          "    commands:",
                          "      - npm install",
                          "      - npm run build --if-present",
                          "      - zip -r lambda.zip .",
                          `      - printf '${appSpecContent}' > appspec.yml`,
                          "artifacts:",
                          "  files:",
                          "    - lambda.zip",
                          "    - appspec.yml",
                      ].join("\n");
                  });

        this.codeBuildProject = new aws.codebuild.Project(
            `${name}-build`,
            {
                name: `${args.name}-${args.environment}-build`,
                serviceRole: codeBuildRole.arn,
                artifacts: {
                    type: "CODEPIPELINE",
                },
                environment: {
                    computeType: "BUILD_GENERAL1_SMALL",
                    image: args.buildImage || "aws/codebuild/standard:7.0",
                    type: "LINUX_CONTAINER",
                    environmentVariables: [
                        {
                            name: "LAMBDA_FUNCTION_NAME",
                            value: args.lambdaFunctionName,
                        },
                        ...(args.lambdaAliasName
                            ? [
                                  {
                                      name: "LAMBDA_ALIAS_NAME",
                                      value: args.lambdaAliasName,
                                  },
                              ]
                            : []),
                    ],
                },
                source: {
                    type: "CODEPIPELINE",
                    buildspec: buildSpec,
                },
                tags: tags,
            },
            { parent: this },
        );

        this.codeDeployApplication = new aws.codedeploy.Application(
            `${name}-codedeploy-app`,
            {
                computePlatform: "Lambda",
                tags: tags,
            },
            { parent: this },
        );

        this.codeDeployDeploymentGroup = new aws.codedeploy.DeploymentGroup(
            `${name}-codedeploy-group`,
            {
                appName: this.codeDeployApplication.name,
                deploymentGroupName: `${args.name}-${args.environment}`,
                serviceRoleArn: codeDeployRole.arn,
                deploymentConfigName: "CodeDeployDefault.LambdaAllAtOnce",
                deploymentStyle: {
                    deploymentOption: "WITH_TRAFFIC_CONTROL",
                    deploymentType: "BLUE_GREEN",
                },
                autoRollbackConfiguration: {
                    enabled: true,
                    events: ["DEPLOYMENT_FAILURE"],
                },
                tags: tags,
            },
            { parent: this },
        );

        new aws.iam.RolePolicy(
            `${name}-codepipeline-policy`,
            {
                role: pipelineRole.id,
                policy: pulumi
                    .all([
                        this.artifactBucket.arn,
                        this.codeBuildProject.arn,
                        codeBuildRole.arn,
                        codeDeployRole.arn,
                        args.connectionArn,
                    ])
                    .apply(([bucketArn, projectArn, buildRoleArn, deployRoleArn, connectionArn]) =>
                        JSON.stringify({
                            Version: "2012-10-17",
                            Statement: [
                                {
                                    Effect: "Allow",
                                    Action: [
                                        "s3:GetObject",
                                        "s3:GetObjectVersion",
                                        "s3:PutObject",
                                        "s3:ListBucket",
                                        "s3:GetBucketLocation",
                                    ],
                                    Resource: [bucketArn, `${bucketArn}/*`],
                                },
                                {
                                    Effect: "Allow",
                                    Action: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
                                    Resource: [projectArn],
                                },
                                {
                                    Effect: "Allow",
                                    Action: [
                                        "codedeploy:CreateDeployment",
                                        "codedeploy:GetApplication",
                                        "codedeploy:GetApplicationRevision",
                                        "codedeploy:GetDeployment",
                                        "codedeploy:GetDeploymentConfig",
                                        "codedeploy:GetDeploymentGroup",
                                        "codedeploy:RegisterApplicationRevision",
                                    ],
                                    Resource: "*",
                                },
                                {
                                    Effect: "Allow",
                                    Action: ["iam:PassRole", "iam:GetRole"],
                                    Resource: [buildRoleArn, deployRoleArn],
                                },
                                {
                                    Effect: "Allow",
                                    Action: ["codestar-connections:UseConnection"],
                                    Resource: [connectionArn],
                                },
                            ],
                        }),
                    ),
            },
            { parent: this },
        );

        const sourceOutputArtifact = "source_output";
        const buildOutputArtifact = "build_output";

        this.codePipeline = new aws.codepipeline.Pipeline(
            `${name}-pipeline`,
            {
                roleArn: pipelineRole.arn,
                artifactStores: [
                    {
                        type: "S3",
                        location: this.artifactBucket.bucket,
                    },
                ],
                stages: [
                    {
                        name: "Source",
                        actions: [
                            {
                                name: "Source",
                                category: "Source",
                                owner: "AWS",
                                provider: "CodeStarSourceConnection",
                                version: "1",
                                outputArtifacts: [sourceOutputArtifact],
                                configuration: {
                                    ConnectionArn: args.connectionArn,
                                    FullRepositoryId: `${args.repositoryOwner}/${args.repositoryName}`,
                                    BranchName: args.branch || "main",
                                    OutputArtifactFormat: "CODE_ZIP",
                                },
                            },
                        ],
                    },
                    {
                        name: "Build",
                        actions: [
                            {
                                name: "Build",
                                category: "Build",
                                owner: "AWS",
                                provider: "CodeBuild",
                                version: "1",
                                inputArtifacts: [sourceOutputArtifact],
                                outputArtifacts: [buildOutputArtifact],
                                configuration: {
                                    ProjectName: this.codeBuildProject.name,
                                },
                            },
                        ],
                    },
                    {
                        name: "Deploy",
                        actions: [
                            {
                                name: "Deploy",
                                category: "Deploy",
                                owner: "AWS",
                                provider: "CodeDeploy",
                                version: "1",
                                inputArtifacts: [buildOutputArtifact],
                                configuration: {
                                    ApplicationName: this.codeDeployApplication.name,
                                    DeploymentGroupName:
                                        this.codeDeployDeploymentGroup.deploymentGroupName,
                                },
                            },
                        ],
                    },
                ],
                tags: tags,
            },
            { parent: this },
        );

        this.registerOutputs({
            pipelineName: this.codePipeline.name,
            pipelineArn: this.codePipeline.arn,
            artifactBucketName: this.artifactBucket.bucket,
        });
    }
}
