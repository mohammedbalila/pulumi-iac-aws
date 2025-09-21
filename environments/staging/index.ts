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
const envConfig = getEnvironmentConfig("staging");

// Configuration values
const appName = config.get("appName") || "my-app";
const repositoryUrl = config.require("repositoryUrl");
const dbUsername = config.get("dbUsername") || "postgres";
const dbPassword = config.requireSecret("dbPassword");
const alertEmail = config.get("alertEmail");
const enableCloudFront = config.getBoolean("enableCloudFront") || false;
const enableWaf = config.getBoolean("enableWaf") || false; // default off for staging unless set

// Create networking infrastructure
const networking = new Networking(`${appName}-staging`, {
    name: appName,
    environment: "staging",
    cidrBlock: "10.1.0.0/24", // Different CIDR for staging
    availabilityZoneCount: 1,
    useFckNat: true,
});

// Security groups for App Runner and Lambda to reach private resources (e.g., RDS)
const apprunnerSg = new aws.ec2.SecurityGroup(`${appName}-staging-apprunner-sg`, {
    description: "App Runner egress SG",
    vpcId: networking.vpc.id,
    egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
    tags: envConfig.tags,
});

const lambdaSg = new aws.ec2.SecurityGroup(`${appName}-staging-lambda-sg`, {
    description: "Lambda egress SG",
    vpcId: networking.vpc.id,
    egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
    tags: envConfig.tags,
});

// Create database with better specs than dev
const database = new Database(`${appName}-staging-db`, {
    name: appName,
    environment: "staging",
    subnetIds: networking.getPrivateSubnetIds(),
    securityGroupId: networking.vpc.defaultSecurityGroupId,
    allowedSecurityGroupIds: [apprunnerSg.id, lambdaSg.id],
    dbName: `${appName.replace(/-/g, "_")}_staging`,
    username: dbUsername,
    password: dbPassword,
    instanceClass: "db.t4g.micro", // Lean staging instance
    allocatedStorage: 20,
    maxAllocatedStorage: 50,
});

// Create App Runner service with staging configuration
const appService = new AppRunnerService(`${appName}-staging-app`, {
    name: appName,
    environment: "staging",
    repositoryUrl: repositoryUrl,
    branch: config.get("branch") || "main",
    databaseUrl: database.getConnectionString(),
    environmentVariables: {
        API_BASE_URL: config.get("apiBaseUrl") || "",
        LOG_LEVEL: "info",
        FEATURE_FLAGS: JSON.stringify({
            enableNewFeature: true, // Test new features in staging
            debugMode: false,
        }),
    },
    maxConcurrency: 10, // Lean concurrency for staging
    maxSize: 2, // Max 2 instances for staging
    minSize: 0, // Scale to zero when idle
    cpu: "0.25 vCPU", // Lean CPU
    memory: "0.5 GB", // Lean memory
    // VPC networking for private access to RDS
    vpcSubnetIds: networking.getPrivateSubnetIds(),
    vpcSecurityGroupIds: [apprunnerSg.id],
});

// Create Lambda functions
const lambdaGroup = new LambdaGroup(`${appName}-staging-lambdas`);

// Example Lambda function - replace with your actual functions
const exampleLambda = lambdaGroup.addFunction(`${appName}-staging-example`, {
    name: `${appName}-example`,
    environment: "staging",
    runtime: "nodejs22.x",
    handler: "index.handler",
    code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(`
            exports.handler = async (event) => {
                console.log('Event:', JSON.stringify(event));
                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        message: 'Hello from Staging Lambda!',
                        environment: 'staging',
                        timestamp: new Date().toISOString()
                    })
                };
            };
        `),
    }),
    environmentVariables: {
        DATABASE_URL: database.getConnectionString(),
        ENVIRONMENT: "staging",
    },
    timeout: 30,
    memorySize: 128, // Align with dev
    // VPC networking for private access to RDS
    subnetIds: networking.getPrivateSubnetIds(),
    securityGroupIds: [lambdaSg.id],
});

// Create monitoring and alerting with tighter thresholds
const monitoring = new Monitoring(`${appName}-staging-monitoring`, {
    name: appName,
    environment: "staging",
    serviceName: appService.service.serviceName,
    dbInstanceId: database.instance.identifier,
    lambdaFunctionNames: [exampleLambda.getFunctionName()],
    alertEmail: alertEmail,
});

// Optional WAF
let wafArn: pulumi.Output<string> | undefined = undefined;
if (enableWaf) {
    const waf = new AppWaf(`${appName}-staging`, {
        name: appName,
        environment: "staging",
        resourceArn: appService.getServiceArn(),
        rateLimit: 2000,
    });
    wafArn = waf.webAcl.arn;
}

// Optional CloudFront
let cloudFrontDomainName: pulumi.Output<string> | undefined = undefined;
if (enableCloudFront) {
    const originDomain = appService
        .getServiceUrl()
        .apply((u) => u.replace(/^https?:\/\//, "").replace(/\/$/, ""));
    const dist = new aws.cloudfront.Distribution(`${appName}-staging-cdn`, {
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

    // Lambda
    exampleLambdaArn: exampleLambda.getFunctionArn(),

    // Monitoring
    dashboardUrl: monitoring.getDashboardUrl(),
    budgetName: monitoring.getBudgetName(),
    wafArn: wafArn,
    cloudFrontDomainName: cloudFrontDomainName,

    // Environment info
    environment: "staging",
    region: aws.getRegion().then((r) => r.name),
    tags: envConfig.tags,
};

// Export individual outputs for easy access
export const vpcId = outputs.vpcId;
export const databaseEndpoint = outputs.databaseEndpoint;
export const appServiceUrl = outputs.appServiceUrl;
export const dashboardUrl = outputs.dashboardUrl;
