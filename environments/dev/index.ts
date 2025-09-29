import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Networking } from "../../modules/networking";
import { Database } from "../../modules/database";
import { AppRunnerService } from "../../modules/compute";
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
    ECR_CONSTANTS,
    NETWORKING_CONSTANTS,
    WAF_CONSTANTS,
    CLOUDFRONT_CONSTANTS,
    GITHUB_CONSTANTS,
    FEATURE_FLAGS,
} from "../../shared/constants";

// Get configuration for this environment
const config = new pulumi.Config();
const envConfig = getEnvironmentConfig("dev");

// Configuration values
const appName =
    config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.APP_NAME) ||
    APPLICATION_CONSTANTS.DEFAULT_APP_NAME;
const dbUsername =
    config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.DB_USERNAME) ||
    APPLICATION_CONSTANTS.DEFAULT_DB_USERNAME;
const dbPassword = config.requireSecret(APPLICATION_CONSTANTS.CONFIG_KEYS.DB_PASSWORD);
const dbName = `${appName.replace(/-/g, "_")}_dev`;
const alertEmail = config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.ALERT_EMAIL);
const enableCloudFront =
    config.getBoolean(APPLICATION_CONSTANTS.CONFIG_KEYS.ENABLE_CLOUDFRONT) || false;
const enableWaf = config.getBoolean(APPLICATION_CONSTANTS.CONFIG_KEYS.ENABLE_WAF) || false;
const enableCostBudget =
    config.getBoolean(APPLICATION_CONSTANTS.CONFIG_KEYS.ENABLE_COST_BUDGET) ?? false;
const enableCostAnomaly =
    config.getBoolean(APPLICATION_CONSTANTS.CONFIG_KEYS.ENABLE_COST_ANOMALY) ?? false;

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
    `${appName}-dev-${APPLICATION_CONSTANTS.RESOURCE_TYPES.ECR_REPOSITORY}`,
    {
        name: appName,
        environment: "dev",
        retentionDays: ECR_CONSTANTS.RETENTION_DAYS.DEV,
        imageMutability: ECR_CONSTANTS.IMAGE_MUTABILITY.MUTABLE,
        scanOnPush: true,
        seedWithPlaceholderImage: placeholderSeedConfig.enabled,
        placeholderImageTag: placeholderSeedConfig.tag,
    },
);

// Create GitHub Actions role for CI/CD

const githubActionsRole = new GitHubActionsRole(
    `${appName}-dev-${APPLICATION_CONSTANTS.RESOURCE_TYPES.GITHUB_ACTIONS_ROLE}`,
    {
        name: appName,
        environment: "dev",
        githubOrg: githubOrg,
        githubRepo: githubRepo,
        githubBranches: GITHUB_CONSTANTS.BRANCHES.DEV,
        githubEnvironments: GITHUB_CONSTANTS.ENVIRONMENTS.DEV,
        ecrRepositoryArns: [ecrRepository.getRepositoryArn()],
    },
);

// Create networking infrastructure with fck-nat for cost savings
const networking = new Networking(`${appName}-dev`, {
    name: appName,
    environment: "dev",
    cidrBlock: NETWORKING_CONSTANTS.CIDR_BLOCKS.DEV,
    availabilityZoneCount: NETWORKING_CONSTANTS.AVAILABILITY_ZONES.DEV,
    useFckNat: config.getBoolean(APPLICATION_CONSTANTS.CONFIG_KEYS.USE_FCK_NAT) ?? true, // Default to fck-nat for cost savings
});

// Security groups for App Runner to reach private resources (e.g., RDS)
const apprunnerSg = new aws.ec2.SecurityGroup(`${appName}-dev-apprunner-sg`, {
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
// Create database
const database = new Database(`${appName}-dev-db`, {
    name: appName,
    environment: "dev",
    subnetIds: networking.getPrivateSubnetIds(),
    securityGroupId: networking.vpc.defaultSecurityGroupId,
    allowedSecurityGroupIds: [apprunnerSg.id],
    dbName: dbName,
    username: dbUsername,
    password: dbPassword,
    instanceClass: DATABASE_CONSTANTS.INSTANCE_CLASSES.MICRO,
    allocatedStorage: DATABASE_CONSTANTS.DEFAULT_STORAGE.DEV,
    maxAllocatedStorage: DATABASE_CONSTANTS.MAX_STORAGE.DEV,
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
        return `${account.accountId}.dkr.ecr.${region.name}.amazonaws.com/${name}-dev:latest`;
    });

// Create App Runner service with ECR source
const appService = new AppRunnerService(
    `${appName}-dev-${APPLICATION_CONSTANTS.RESOURCE_TYPES.APP_RUNNER_SERVICE}`,
    {
        name: appName,
        environment: "dev",

        // ECR configuration
        ecrImageUri: ecrImageUri,

        // Application configuration
        databaseUrl: databaseConnectionString,
        environmentVariables: {
            [APPLICATION_CONSTANTS.ENV_VARS.API_BASE_URL]:
                config.get(APPLICATION_CONSTANTS.CONFIG_KEYS.API_BASE_URL) || "",
            [APPLICATION_CONSTANTS.ENV_VARS.LOG_LEVEL]: APPLICATION_CONSTANTS.LOG_LEVELS.DEBUG,
            [APPLICATION_CONSTANTS.ENV_VARS.FEATURE_FLAGS]: JSON.stringify(FEATURE_FLAGS.DEV),
        },

        // Scaling configuration optimized for dev
        maxConcurrency: APP_RUNNER_CONSTANTS.SCALING.DEV.MAX_CONCURRENCY,
        maxSize: APP_RUNNER_CONSTANTS.SCALING.DEV.MAX_SIZE,
        minSize: APP_RUNNER_CONSTANTS.SCALING.DEV.MIN_SIZE,
        cpu: APP_RUNNER_CONSTANTS.CPU_OPTIONS.QUARTER,
        memory: APP_RUNNER_CONSTANTS.MEMORY_OPTIONS.HALF_GB,

        // VPC networking for private access to RDS
        vpcSubnetIds: networking.getPrivateSubnetIds(),
        vpcSecurityGroupIds: [apprunnerSg.id],
    },
);

// Create monitoring and alerting
const monitoring = new Monitoring(
    `${appName}-dev-${APPLICATION_CONSTANTS.RESOURCE_TYPES.MONITORING}`,
    {
        name: appName,
        environment: "dev",
        serviceName: appService.service.serviceName,
        dbInstanceId: database.instance.identifier,
        alertEmail: alertEmail,
        enableCostBudget: enableCostBudget,
        enableCostAnomaly: enableCostAnomaly,
    },
);

// Optional WAF
let wafArn: pulumi.Output<string> | undefined = undefined;
if (enableWaf) {
    const waf = new AppWaf(`${appName}-dev-${APPLICATION_CONSTANTS.RESOURCE_TYPES.WAF}`, {
        name: appName,
        environment: "dev",
        resourceArn: appService.getServiceArn(),
        rateLimit: WAF_CONSTANTS.RATE_LIMITS.DEV,
    });
    wafArn = waf.webAcl.arn;
}

// Optional CloudFront
let cloudFrontDomainName: pulumi.Output<string> | undefined = undefined;
if (enableCloudFront) {
    const originDomain = appService
        .getServiceUrl()
        .apply((u) => u.replace(/^https?:\/\//, "").replace(/\/$/, ""));
    const dist = new aws.cloudfront.Distribution(
        `${appName}-dev-${APPLICATION_CONSTANTS.RESOURCE_TYPES.CLOUDFRONT}`,
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

    // Monitoring
    dashboardUrl: monitoring.getDashboardUrl(),
    budgetName: monitoring.getBudgetName(),
    wafArn: wafArn,
    cloudFrontDomainName: cloudFrontDomainName,

    // Environment info
    environment: "dev",
    region: currentRegion.then((r) => r.name),
    accountId: currentAccount.then((a) => a.accountId),
    tags: envConfig.tags,
};

// Export individual outputs for easy access
export const vpcId = outputs.vpcId;
export const databaseEndpoint = outputs.databaseEndpoint;
export const appServiceUrl = outputs.appServiceUrl;
export const dashboardUrl = outputs.dashboardUrl;
export const ecrRepositoryUrl = outputs.ecrRepositoryUrl;
export const githubActionsRoleArn = outputs.githubActionsRoleArn;
