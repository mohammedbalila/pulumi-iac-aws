import * as pulumi from "@pulumi/pulumi";

export interface EnvironmentConfig {
    name: string;
    region: string;
    tags: Record<string, string>;
}

export interface NetworkingArgs {
    name: string;
    environment: string;
    cidrBlock?: string;
    availabilityZoneCount?: number;
    useFckNat?: boolean; // Use fck-nat instead of NAT Gateway for cost savings
}

export interface DatabaseArgs {
    name: string;
    environment: string;
    subnetIds: pulumi.Input<string>[];
    securityGroupId: pulumi.Input<string>;
    // Optionally allow multiple SGs to access the DB (preferred over default SG)
    allowedSecurityGroupIds?: pulumi.Input<string>[];
    dbName: string;
    username: string;
    password: pulumi.Input<string>;
    instanceClass?: string;
    allocatedStorage?: number;
    maxAllocatedStorage?: number;
}

export interface AppRunnerArgs {
    name: string;
    environment: string;
    // ECR source configuration (required for CI/CD)
    ecrImageUri: pulumi.Input<string>;
    // Application configuration
    databaseUrl: pulumi.Input<string>;
    environmentVariables?: Record<string, pulumi.Input<string>>;
    maxConcurrency?: number;
    maxSize?: number;
    minSize?: number;
    cpu?: string;
    memory?: string;
    // Start command for container
    startCommand?: string;
    // Optional VPC networking for private access (e.g., RDS)
    vpcSubnetIds?: pulumi.Input<string>[];
    vpcSecurityGroupIds?: pulumi.Input<string>[];
    // Optional: SSM parameter prefixes to allow read access for runtime secrets
    ssmParameterPaths?: pulumi.Input<string>[];
}

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

export interface ECRConfig {
    repositoryName: string;
    imageTagMutability?: "MUTABLE" | "IMMUTABLE";
    scanOnPush?: boolean;
    maxImages?: number;
    untaggedImageRetentionDays?: number;
    allowedAccounts?: string[];
}

export interface LambdaArgs {
    name: string;
    environment: string;
    runtime: string;
    handler: string;
    code: pulumi.asset.Archive;
    environmentVariables?: Record<string, pulumi.Input<string>>;
    timeout?: number;
    memorySize?: number;
    // Optional VPC configuration when accessing private resources
    subnetIds?: pulumi.Input<string>[];
    securityGroupIds?: pulumi.Input<string>[];
    // Optional: SSM parameter prefixes to allow read access for runtime secrets
    ssmParameterPaths?: pulumi.Input<string>[];
    // Optional alias configuration for traffic shifting / deployments
    aliasName?: string;
    publish?: boolean;
    reservedConcurrentExecutions?: number;
}

export interface LambdaCicdPipelineArgs {
    name: string;
    environment: string;
    repositoryOwner: string;
    repositoryName: string;
    branch?: string;
    connectionArn: pulumi.Input<string>;
    lambdaFunctionName: pulumi.Input<string>;
    lambdaAliasName?: pulumi.Input<string>;
    artifactBucketName?: string;
    buildImage?: string;
    buildSpec?: pulumi.Input<string>;
}

export interface MonitoringArgs {
    name: string;
    environment: string;
    serviceName?: pulumi.Input<string>;
    dbInstanceId?: pulumi.Input<string>;
    lambdaFunctionNames?: pulumi.Input<string>[];
    alertEmail?: string;
    enableCostBudget?: boolean;
    enableCostAnomaly?: boolean;
}
