import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Networking } from "../../modules/networking";
import { Database } from "../../modules/database";
import { AppRunnerService } from "../../modules/compute";
import { LambdaGroup } from "../../modules/lambda";
import { Monitoring } from "../../modules/monitoring";
import { AppWaf } from "../../modules/waf";
import { getEnvironmentConfig } from "../../shared/config";

// Get configuration for this environment
const config = new pulumi.Config();
const envConfig = getEnvironmentConfig("prod");

// Configuration values
const appName = config.get("appName") || "my-app";
const repositoryUrl = config.require("repositoryUrl");
const dbUsername = config.get("dbUsername") || "postgres";
const dbPassword = config.requireSecret("dbPassword");
const alertEmail = config.require("alertEmail"); // Required for production
const enableCloudFront = config.getBoolean("enableCloudFront") || false;
const enableWaf = config.getBoolean("enableWaf") ?? true; // default on for prod

// Create networking infrastructure
const networking = new Networking(`${appName}-prod`, {
    name: appName,
    environment: "prod",
    cidrBlock: "10.2.0.0/24", // Different CIDR for production
    availabilityZoneCount: 2,
});

// Security groups for App Runner and Lambda to reach private resources (e.g., RDS)
const apprunnerSg = new aws.ec2.SecurityGroup(`${appName}-prod-apprunner-sg`, {
    description: "App Runner egress SG",
    vpcId: networking.vpc.id,
    egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
    tags: envConfig.tags,
});

const lambdaSg = new aws.ec2.SecurityGroup(`${appName}-prod-lambda-sg`, {
    description: "Lambda egress SG",
    vpcId: networking.vpc.id,
    egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
    tags: envConfig.tags,
});

// Create production-grade database
const database = new Database(`${appName}-prod-db`, {
    name: appName,
    environment: "prod",
    subnetIds: networking.getPrivateSubnetIds(),
    securityGroupId: networking.vpc.defaultSecurityGroupId,
    allowedSecurityGroupIds: [apprunnerSg.id, lambdaSg.id],
    dbName: `${appName.replace(/-/g, "_")}_prod`,
    username: dbUsername,
    password: dbPassword,
    instanceClass: "db.t4g.small", // Production-ready instance
    allocatedStorage: 50, // Start with more storage
    maxAllocatedStorage: 1000, // Higher auto-scaling limit
});

// Create App Runner service with production configuration
const appService = new AppRunnerService(`${appName}-prod-app`, {
    name: appName,
    environment: "prod",
    repositoryUrl: repositoryUrl,
    branch: config.get("branch") || "main",
    databaseUrl: database.getConnectionString(),
    environmentVariables: {
        API_BASE_URL: config.get("apiBaseUrl") || "",
        LOG_LEVEL: "warn", // Reduce log verbosity in production
        FEATURE_FLAGS: JSON.stringify({
            enableNewFeature: config.getBoolean("enableNewFeature") || false,
            debugMode: false,
            enableAnalytics: true,
            enableCaching: true,
        }),
        // Add production-specific environment variables
        REDIS_URL: config.get("redisUrl") || "",
        SENTRY_DSN: config.get("sentryDsn") || "",
    },
    maxConcurrency: 25, // Higher concurrency for production
    maxSize: 5, // Max 5 instances for production
    minSize: 1, // Always keep 1 instance running
    cpu: "0.5 vCPU", // Better performance for production
    memory: "1 GB", // Adequate memory for production workloads
    // VPC networking for private access to RDS
    vpcSubnetIds: networking.getPrivateSubnetIds(),
    vpcSecurityGroupIds: [apprunnerSg.id],
});

// Create Lambda functions
const lambdaGroup = new LambdaGroup(`${appName}-prod-lambdas`);

// Example Lambda function - replace with your actual functions
const exampleLambda = lambdaGroup.addFunction(`${appName}-prod-example`, {
    name: `${appName}-example`,
    environment: "prod",
    runtime: "nodejs22.x",
    handler: "index.handler",
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
        DATABASE_URL: database.getConnectionString(),
        ENVIRONMENT: "prod",
        LOG_LEVEL: "warn",
    },
    timeout: 30,
    memorySize: 512, // Higher memory for production
    // VPC networking for private access to RDS
    subnetIds: networking.getPrivateSubnetIds(),
    securityGroupIds: [lambdaSg.id],
});

// Data processing Lambda (example)
const dataProcessorLambda = lambdaGroup.addFunction(`${appName}-prod-data-processor`, {
    name: `${appName}-data-processor`,
    environment: "prod",
    runtime: "nodejs22.x",
    handler: "processor.handler",
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
        DATABASE_URL: database.getConnectionString(),
        ENVIRONMENT: "prod",
    },
    timeout: 300, // 5 minutes for data processing
    memorySize: 1024, // Higher memory for data processing
    // VPC networking for private access to RDS
    subnetIds: networking.getPrivateSubnetIds(),
    securityGroupIds: [lambdaSg.id],
});

// Create comprehensive monitoring and alerting for production
const monitoring = new Monitoring(`${appName}-prod-monitoring`, {
    name: appName,
    environment: "prod",
    serviceName: appService.service.serviceName,
    dbInstanceId: database.instance.identifier,
    lambdaFunctionNames: [
        exampleLambda.getFunctionName(),
        dataProcessorLambda.getFunctionName(),
    ],
    alertEmail: alertEmail,
});

// WAF for public App Runner
let wafArn: pulumi.Output<string> | undefined = undefined;
if (enableWaf) {
    const waf = new AppWaf(`${appName}-prod`, {
        name: appName,
        environment: "prod",
        resourceArn: appService.getServiceArn(),
        rateLimit: 2000,
    });
    wafArn = waf.webAcl.arn;
}

// Optional CloudFront distribution in front of App Runner
let cloudFrontDomainName: pulumi.Output<string> | undefined = undefined;
if (enableCloudFront) {
    const originDomain = appService
        .getServiceUrl()
        .apply((u) => u.replace(/^https?:\/\//, "").replace(/\/$/, ""));
    const dist = new aws.cloudfront.Distribution(`${appName}-prod-cdn`, {
        enabled: true,
        isIpv6Enabled: true,
        origins: [
            {
                domainName: originDomain,
                originId: "apprunner-origin",
                customOriginConfig: {
                    httpPort: 80,
                    httpsPort: 443,
                    originProtocolPolicy: "https-only",
                    originSslProtocols: ["TLSv1.2"],
                },
            },
        ],
        defaultCacheBehavior: {
            targetOriginId: "apprunner-origin",
            viewerProtocolPolicy: "redirect-to-https",
            allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
            cachedMethods: ["GET", "HEAD", "OPTIONS"],
            forwardedValues: {
                queryString: true,
                headers: ["*"],
                cookies: { forward: "all" },
            },
            compress: true,
        },
        priceClass: "PriceClass_All",
        restrictions: { geoRestriction: { restrictionType: "none" } },
        viewerCertificate: { cloudfrontDefaultCertificate: true },
        tags: envConfig.tags,
    });
    cloudFrontDomainName = dist.domainName;
}

// Create additional production-specific resources
const _backupRole = new aws.iam.Role(`${appName}-backup-role`, {
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
});

// Backup vault for production data
const backupVault = new aws.backup.Vault(`${appName}-prod-backup-vault`, {
    name: `${appName}-prod-backup-vault`,
    tags: envConfig.tags,
});

// Backup plan for production database
const _backupPlan = new aws.backup.Plan(`${appName}-prod-backup-plan`, {
    name: `${appName}-prod-backup-plan`,
    rules: [
        {
            ruleName: "daily-backup",
            targetVaultName: backupVault.name,
            schedule: "cron(0 3 ? * * *)", // 3 AM UTC daily
            startWindow: 60, // 1 hour window
            completionWindow: 300, // 5 hours to complete
            lifecycle: {
                coldStorageAfter: 30, // Move to cold storage after 30 days
                deleteAfter: 365, // Delete after 1 year
            },
            recoveryPointTags: envConfig.tags,
        },
    ],
    tags: envConfig.tags,
});

// Export important values
export const outputs = {
    // Networking
    vpcId: networking.vpc.id,
    publicSubnetIds: networking.getPublicSubnetIds(),
    privateSubnetIds: networking.getPrivateSubnetIds(),

    // Database
    databaseEndpoint: database.getEndpoint(),
    databaseConnectionString: database.getConnectionString(),
    dbSecurityGroupId: database.getSecurityGroupId(),

    // App Runner
    appServiceUrl: appService.getServiceUrl(),
    appServiceArn: appService.getServiceArn(),
    connectionArn: appService.getConnectionArn(),

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
    region: aws.getRegion().then((r) => r.name),
    tags: envConfig.tags,
};

// Export individual outputs for easy access
export const vpcId = outputs.vpcId;
export const databaseEndpoint = outputs.databaseEndpoint;
export const appServiceUrl = outputs.appServiceUrl;
export const dashboardUrl = outputs.dashboardUrl;
export const backupVaultArn = outputs.backupVaultArn;
