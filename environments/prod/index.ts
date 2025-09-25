import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Networking } from "../../modules/networking";
import { Database } from "../../modules/database";
import { AppRunnerService } from "../../modules/compute";
import { LambdaGroup } from "../../modules/lambda";
import { Monitoring } from "../../modules/monitoring";
import { AppWaf } from "../../modules/waf";
import { ECRRepository } from "../../modules/ecr";
import { GitHubActionsRole } from "../../modules/cicd/github-actions-role";
import { getEnvironmentConfig } from "../../shared/config";
import { buildDatabaseConnectionString } from "../../shared/database";
import { derivePlaceholderSeedConfig } from "../../shared/ecr";
import {
    APPLICATION_CONSTANTS,
    DATABASE_CONSTANTS,
    APP_RUNNER_CONSTANTS,
    LAMBDA_CONSTANTS,
    ECR_CONSTANTS,
    NETWORKING_CONSTANTS,
    WAF_CONSTANTS,
    CLOUDFRONT_CONSTANTS,
    GITHUB_CONSTANTS,
    FEATURE_FLAGS,
    BACKUP_CONSTANTS,
} from "../../shared/constants";

// Get configuration for this environment
const config = new pulumi.Config();
const envConfig = getEnvironmentConfig("prod");

// Configuration values
const appName =
    config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.APP_NAME) ||
    APPLICATION_CONSTANTS.DEFAULT_APP_NAME;
const dbUsername =
    config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.DB_USERNAME) ||
    APPLICATION_CONSTANTS.DEFAULT_DB_USERNAME;
const dbPassword = config.requireSecret(APPLICATION_CONSTANTS.CONFIG_KEYS.DB_PASSWORD);
const dbName = `${appName.replace(/-/g, "_")}_prod`;
const alertEmail = config.require(APPLICATION_CONSTANTS.CONFIG_KEYS.ALERT_EMAIL); // Required for production
const enableCloudFront =
    config.getBoolean(APPLICATION_CONSTANTS.CONFIG_KEYS.ENABLE_CLOUDFRONT) || false;
const enableWaf = config.getBoolean(APPLICATION_CONSTANTS.CONFIG_KEYS.ENABLE_WAF) ?? true; // default on for prod
const enableCostBudget = config.getBoolean(APPLICATION_CONSTANTS.CONFIG_KEYS.ENABLE_COST_BUDGET);
const enableCostAnomaly =
    config.getBoolean(APPLICATION_CONSTANTS.CONFIG_KEYS.ENABLE_COST_ANOMALY) || false;

const configuredEcrImageUri = config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.ECR_IMAGE_URI);
const placeholderSeedConfig = derivePlaceholderSeedConfig(configuredEcrImageUri);

if (placeholderSeedConfig.warning) {
    pulumi.log.warn(placeholderSeedConfig.warning);
}

// GitHub configuration for CI/CD
const githubOrg =
    config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.GITHUB_ORG) ||
    APPLICATION_CONSTANTS.DEFAULT_GITHUB_ORG;
const githubRepo =
    config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.GITHUB_REPO) ||
    APPLICATION_CONSTANTS.DEFAULT_GITHUB_REPO;

// Get current AWS account and region
const currentAccount = aws.getCallerIdentity();
const currentRegion = aws.getRegion();

// Create ECR repository for this environment
const ecrRepository = new ECRRepository(
    `${appName}-prod-${APPLICATION_CONSTANTS.RESOURCE_TYPES.ECR_REPOSITORY}`,
    {
        name: appName,
        environment: "prod",
        retentionDays: ECR_CONSTANTS.RETENTION_DAYS.PROD,
        imageMutability: ECR_CONSTANTS.IMAGE_MUTABILITY.IMMUTABLE,
        scanOnPush: true,
        seedWithPlaceholderImage: placeholderSeedConfig.enabled,
        placeholderImageTag: placeholderSeedConfig.tag,
    },
);

const placeholderSeedResource = ecrRepository.getPlaceholderSeedResource();

// Create GitHub Actions role for CI/CD
const githubActionsRole = new GitHubActionsRole(
    `${appName}-prod-${APPLICATION_CONSTANTS.RESOURCE_TYPES.GITHUB_ACTIONS_ROLE}`,
    {
        name: appName,
        environment: "prod",
        githubOrg: githubOrg,
        githubRepo: githubRepo,
        githubBranches: GITHUB_CONSTANTS.BRANCHES.PROD,
        githubEnvironments: GITHUB_CONSTANTS.ENVIRONMENTS.PROD,
        ecrRepositoryArns: [ecrRepository.getRepositoryArn()],
    },
);

// Create networking infrastructure
const networking = new Networking(`${appName}-prod`, {
    name: appName,
    environment: "prod",
    cidrBlock: NETWORKING_CONSTANTS.CIDR_BLOCKS.PROD,
    availabilityZoneCount: NETWORKING_CONSTANTS.AVAILABILITY_ZONES.PROD,
    useFckNat: config.getBoolean(APPLICATION_CONSTANTS.CONFIG_KEYS.USE_FCK_NAT) ?? false, // Default to NAT Gateway for production
});

// Security groups for App Runner and Lambda to reach private resources (e.g., RDS)
const apprunnerSg = new aws.ec2.SecurityGroup(`${appName}-prod-apprunner-sg`, {
    description: "App Runner egress SG",
    vpcId: networking.vpc.id,
    egress: [
        {
            fromPort: NETWORKING_CONSTANTS.PORTS.ALL,
            toPort: NETWORKING_CONSTANTS.PORTS.ALL,
            protocol: NETWORKING_CONSTANTS.PROTOCOLS.ALL,
            cidrBlocks: ["0.0.0.0/0"],
        },
    ],
    tags: envConfig.tags,
});

const lambdaSg = new aws.ec2.SecurityGroup(`${appName}-prod-lambda-sg`, {
    description: "Lambda egress SG",
    vpcId: networking.vpc.id,
    egress: [
        {
            fromPort: NETWORKING_CONSTANTS.PORTS.ALL,
            toPort: NETWORKING_CONSTANTS.PORTS.ALL,
            protocol: NETWORKING_CONSTANTS.PROTOCOLS.ALL,
            cidrBlocks: ["0.0.0.0/0"],
        },
    ],
    tags: envConfig.tags,
});

// Create production-grade database
const database = new Database(`${appName}-prod-db`, {
    name: appName,
    environment: "prod",
    subnetIds: networking.getPrivateSubnetIds(),
    securityGroupId: networking.vpc.defaultSecurityGroupId,
    allowedSecurityGroupIds: [apprunnerSg.id, lambdaSg.id],
    dbName: dbName,
    username: dbUsername,
    password: dbPassword,
    instanceClass: DATABASE_CONSTANTS.INSTANCE_CLASSES.SMALL,
    allocatedStorage: DATABASE_CONSTANTS.DEFAULT_STORAGE.PROD,
    maxAllocatedStorage: DATABASE_CONSTANTS.MAX_STORAGE.PROD,
});

const databaseConnectionString = buildDatabaseConnectionString({
    username: dbUsername,
    password: dbPassword,
    host: database.getAddress(),
    port: database.getPort(),
    database: dbName,
});

// Construct ECR image URI
const ecrImageUri = pulumi
    .all([currentAccount, currentRegion, appName])
    .apply(([account, region, name]) => {
        if (configuredEcrImageUri) {
            return configuredEcrImageUri;
        }
        // Default to latest tag if not specified
        return `${account.accountId}.dkr.ecr.${region.name}.amazonaws.com/${name}-prod:latest`;
    });

// Create App Runner service with ECR source
const appService = new AppRunnerService(
    `${appName}-prod-${APPLICATION_CONSTANTS.RESOURCE_TYPES.APP_RUNNER_SERVICE}`,
    {
        name: appName,
        environment: "prod",

        // ECR configuration
        ecrImageUri: ecrImageUri,

        // Application configuration
        databaseUrl: databaseConnectionString,
        environmentVariables: {
            [APPLICATION_CONSTANTS.ENV_VARS.API_BASE_URL]:
                config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.API_BASE_URL) || "",
            [APPLICATION_CONSTANTS.ENV_VARS.LOG_LEVEL]: APPLICATION_CONSTANTS.LOG_LEVELS.WARN,
            [APPLICATION_CONSTANTS.ENV_VARS.FEATURE_FLAGS]: JSON.stringify({
                ...FEATURE_FLAGS.PROD,
                enableNewFeature:
                    config.getBoolean(APPLICATION_CONSTANTS.CONFIG_KEYS.ENABLE_NEW_FEATURE) ||
                    FEATURE_FLAGS.PROD.enableNewFeature,
            }),
            // Add production-specific environment variables
            [APPLICATION_CONSTANTS.ENV_VARS.REDIS_URL]:
                config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.REDIS_URL) || "",
            [APPLICATION_CONSTANTS.ENV_VARS.SENTRY_DSN]:
                config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.SENTRY_DSN) || "",
        },

        // Scaling configuration for production
        maxConcurrency: APP_RUNNER_CONSTANTS.SCALING.PROD.MAX_CONCURRENCY,
        maxSize: APP_RUNNER_CONSTANTS.SCALING.PROD.MAX_SIZE,
        minSize: APP_RUNNER_CONSTANTS.SCALING.PROD.MIN_SIZE,
        cpu: APP_RUNNER_CONSTANTS.CPU_OPTIONS.HALF,
        memory: APP_RUNNER_CONSTANTS.MEMORY_OPTIONS.ONE_GB,

        // VPC networking for private access to RDS
        vpcSubnetIds: networking.getPrivateSubnetIds(),
        vpcSecurityGroupIds: [apprunnerSg.id],
    },
    {
        dependsOn: placeholderSeedResource ? [placeholderSeedResource] : undefined,
    },
);

// Create Lambda functions
const lambdaGroup = new LambdaGroup(`${appName}-prod-lambdas`);

// Example Lambda function - replace with your actual functions
const exampleLambda = lambdaGroup.addFunction(`${appName}-prod-example`, {
    name: `${appName}-example`,
    environment: "prod",
    runtime: APPLICATION_CONSTANTS.RUNTIMES.NODEJS_22,
    handler: LAMBDA_CONSTANTS.HANDLERS.DEFAULT,
    code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(`
            exports.handler = async (event) => {
                const startTime = Date.now();

                try {
                    console.log('Processing event in production');

                    // Your production lambda logic here
                    const result = {
                        statusCode: 200,
                        body: JSON.stringify({
                            message: 'Production Lambda executed successfully',
                            environment: 'production',
                            timestamp: new Date().toISOString(),
                            executionTime: Date.now() - startTime
                        })
                    };

                    return result;
                } catch (error) {
                    console.error('Lambda execution failed:', error);
                    return {
                        statusCode: 500,
                        body: JSON.stringify({
                            error: 'Internal server error',
                            timestamp: new Date().toISOString()
                        })
                    };
                }
            };
        `),
    }),
    environmentVariables: {
        [APPLICATION_CONSTANTS.ENV_VARS.DATABASE_URL]: databaseConnectionString,
        [APPLICATION_CONSTANTS.ENV_VARS.ENVIRONMENT]: "prod",
        [APPLICATION_CONSTANTS.ENV_VARS.LOG_LEVEL]: APPLICATION_CONSTANTS.LOG_LEVELS.WARN,
    },
    timeout: LAMBDA_CONSTANTS.TIMEOUTS.DEFAULT,
    memorySize: LAMBDA_CONSTANTS.MEMORY_SIZES.MEDIUM,
    // VPC networking for private access to RDS
    subnetIds: networking.getPrivateSubnetIds(),
    securityGroupIds: [lambdaSg.id],
});

// Data processing Lambda (example)
const dataProcessorLambda = lambdaGroup.addFunction(`${appName}-prod-data-processor`, {
    name: `${appName}-data-processor`,
    environment: "prod",
    runtime: APPLICATION_CONSTANTS.RUNTIMES.NODEJS_22,
    handler: LAMBDA_CONSTANTS.HANDLERS.PROCESSOR,
    code: new pulumi.asset.AssetArchive({
        "processor.js": new pulumi.asset.StringAsset(`
            exports.handler = async (event) => {
                console.log('Processing data batch:', event.Records?.length || 'No records');

                // Your data processing logic here
                return {
                    statusCode: 200,
                    processedRecords: event.Records?.length || 0,
                    timestamp: new Date().toISOString()
                };
            };
        `),
    }),
    environmentVariables: {
        [APPLICATION_CONSTANTS.ENV_VARS.DATABASE_URL]: databaseConnectionString,
        [APPLICATION_CONSTANTS.ENV_VARS.ENVIRONMENT]: "prod",
    },
    timeout: LAMBDA_CONSTANTS.TIMEOUTS.LONG_RUNNING,
    memorySize: LAMBDA_CONSTANTS.MEMORY_SIZES.LARGE,
    // VPC networking for private access to RDS
    subnetIds: networking.getPrivateSubnetIds(),
    securityGroupIds: [lambdaSg.id],
});

// Create comprehensive monitoring and alerting for production
const monitoring = new Monitoring(
    `${appName}-prod-${APPLICATION_CONSTANTS.RESOURCE_TYPES.MONITORING}`,
    {
        name: appName,
        environment: "prod",
        serviceName: appService.service.serviceName,
        dbInstanceId: database.instance.identifier,
        lambdaFunctionNames: [
            exampleLambda.getFunctionName(),
            dataProcessorLambda.getFunctionName(),
        ],
        alertEmail: alertEmail,
        enableCostBudget: enableCostBudget ?? true,
        enableCostAnomaly: enableCostAnomaly,
    },
);

// WAF for public App Runner
let wafArn: pulumi.Output<string> | undefined = undefined;
if (enableWaf) {
    const waf = new AppWaf(`${appName}-prod-${APPLICATION_CONSTANTS.RESOURCE_TYPES.WAF}`, {
        name: appName,
        environment: "prod",
        resourceArn: appService.getServiceArn(),
        rateLimit: WAF_CONSTANTS.RATE_LIMITS.PROD,
    });
    wafArn = waf.webAcl.arn;
}

// Optional CloudFront distribution in front of App Runner
let cloudFrontDomainName: pulumi.Output<string> | undefined = undefined;
if (enableCloudFront) {
    const originDomain = appService
        .getServiceUrl()
        .apply((u) => u.replace(/^https?:\/\//, "").replace(/\/$/, ""));
    const dist = new aws.cloudfront.Distribution(
        `${appName}-prod-${APPLICATION_CONSTANTS.RESOURCE_TYPES.CLOUDFRONT}`,
        {
            enabled: true,
            isIpv6Enabled: true,
            origins: [
                {
                    domainName: originDomain,
                    originId: "apprunner-origin",
                    customOriginConfig: {
                        httpPort: CLOUDFRONT_CONSTANTS.ORIGIN_CONFIG.HTTP_PORT,
                        httpsPort: CLOUDFRONT_CONSTANTS.ORIGIN_CONFIG.HTTPS_PORT,
                        originProtocolPolicy:
                            CLOUDFRONT_CONSTANTS.ORIGIN_CONFIG.ORIGIN_PROTOCOL_POLICY,
                        originSslProtocols: CLOUDFRONT_CONSTANTS.ORIGIN_CONFIG.ORIGIN_SSL_PROTOCOLS,
                    },
                },
            ],
            defaultCacheBehavior: {
                targetOriginId: "apprunner-origin",
                viewerProtocolPolicy: CLOUDFRONT_CONSTANTS.CACHE_BEHAVIOR.VIEWER_PROTOCOL_POLICY,
                allowedMethods: CLOUDFRONT_CONSTANTS.CACHE_BEHAVIOR.ALLOWED_METHODS,
                cachedMethods: CLOUDFRONT_CONSTANTS.CACHE_BEHAVIOR.CACHED_METHODS,
                forwardedValues: {
                    queryString: true,
                    headers: ["*"],
                    cookies: { forward: "all" },
                },
                compress: true,
            },
            priceClass: CLOUDFRONT_CONSTANTS.CACHE_BEHAVIOR.PRICE_CLASS,
            restrictions: { geoRestriction: { restrictionType: "none" } },
            viewerCertificate: { cloudfrontDefaultCertificate: true },
            tags: envConfig.tags,
        },
    );
    cloudFrontDomainName = dist.domainName;
}

// Create additional production-specific resources
const _backupRole = new aws.iam.Role(
    `${appName}-${APPLICATION_CONSTANTS.RESOURCE_TYPES.BACKUP_ROLE}`,
    {
        assumeRolePolicy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Action: "sts:AssumeRole",
                    Effect: "Allow",
                    Principal: {
                        Service: "backup.amazonaws.com",
                    },
                },
            ],
        }),
        managedPolicyArns: [
            "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
            "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores",
        ],
        tags: envConfig.tags,
    },
);

// Backup vault for production data
const backupVault = new aws.backup.Vault(
    `${appName}-prod-${APPLICATION_CONSTANTS.RESOURCE_TYPES.BACKUP_VAULT}`,
    {
        name: `${appName}-prod-backup-vault`,
        tags: envConfig.tags,
    },
);

// Backup plan for production database
const _backupPlan = new aws.backup.Plan(
    `${appName}-prod-${APPLICATION_CONSTANTS.RESOURCE_TYPES.BACKUP_PLAN}`,
    {
        name: `${appName}-prod-backup-plan`,
        rules: [
            {
                ruleName: "daily-backup",
                targetVaultName: backupVault.name,
                schedule: BACKUP_CONSTANTS.SCHEDULE.DAILY,
                startWindow: BACKUP_CONSTANTS.WINDOWS.START_WINDOW_MINUTES,
                completionWindow: BACKUP_CONSTANTS.WINDOWS.COMPLETION_WINDOW_MINUTES,
                lifecycle: {
                    coldStorageAfter: BACKUP_CONSTANTS.LIFECYCLE.COLD_STORAGE_AFTER_DAYS,
                    deleteAfter: BACKUP_CONSTANTS.LIFECYCLE.DELETE_AFTER_DAYS,
                },
                recoveryPointTags: envConfig.tags,
            },
        ],
        tags: envConfig.tags,
    },
);

// Export important values
export const outputs = {
    // Networking
    vpcId: networking.vpc.id,
    publicSubnetIds: networking.getPublicSubnetIds(),
    privateSubnetIds: networking.getPrivateSubnetIds(),
    natCostInfo: networking.getNatCostInfo(),

    // Database
    databaseEndpoint: database.getEndpoint(),
    // Database connection string intentionally omitted from stack outputs to avoid leaking secrets
    dbSecurityGroupId: database.getSecurityGroupId(),

    // App Runner
    appServiceUrl: appService.getServiceUrl(),
    appServiceArn: appService.getServiceArn(),

    // ECR and CI/CD
    ecrRepositoryUrl: ecrRepository.getRepositoryUrl(),
    ecrRepositoryArn: ecrRepository.getRepositoryArn(),
    githubActionsRoleArn: githubActionsRole.getRoleArn(),

    // Lambda Functions
    exampleLambdaArn: exampleLambda.getFunctionArn(),
    dataProcessorLambdaArn: dataProcessorLambda.getFunctionArn(),

    // Monitoring & Backup
    dashboardUrl: monitoring.getDashboardUrl(),
    budgetName: monitoring.getBudgetName(),
    backupVaultArn: backupVault.arn,
    wafArn: wafArn,
    cloudFrontDomainName: cloudFrontDomainName,

    // Environment info
    environment: "prod",
    region: currentRegion.then((r) => r.name),
    accountId: currentAccount.then((a) => a.accountId),
    tags: envConfig.tags,
};

// Export individual outputs for easy access
export const vpcId = outputs.vpcId;
export const databaseEndpoint = outputs.databaseEndpoint;
export const appServiceUrl = outputs.appServiceUrl;
export const dashboardUrl = outputs.dashboardUrl;
export const backupVaultArn = outputs.backupVaultArn;
export const ecrRepositoryUrl = outputs.ecrRepositoryUrl;
export const githubActionsRoleArn = outputs.githubActionsRoleArn;
export const exampleLambdaArn = outputs.exampleLambdaArn;
export const dataProcessorLambdaArn = outputs.dataProcessorLambdaArn;
