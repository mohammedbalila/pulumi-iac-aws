import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Networking } from "../../modules/networking";
import { Database } from "../../modules/database";
import { AppRunnerService } from "../../modules/compute";
import { LambdaGroup } from "../../modules/lambda";
import { LambdaCicdPipeline } from "../../modules/cicd";
import { Monitoring } from "../../modules/monitoring";
import { AppWaf } from "../../modules/waf";
import { getEnvironmentConfig } from "../../shared/config";

// Get configuration for this environment
const config = new pulumi.Config();
const envConfig = getEnvironmentConfig("dev");

// Configuration values
const appName = config.get("appName") || "my-app";
const repositoryUrl = config.require("repositoryUrl"); // e.g., "https://github.com/username/repo"
const dbUsername = config.get("dbUsername") || "postgres";
const dbPassword = config.requireSecret("dbPassword");
const alertEmail = config.get("alertEmail");
const enableCloudFront = config.getBoolean("enableCloudFront") || false;
const enableWaf = config.getBoolean("enableWaf") || false; // default off for dev unless set
const lambdaRepoOwner = config.require("lambdaRepoOwner");
const lambdaRepoName = config.require("lambdaRepoName");
const lambdaRepoBranch = config.get("lambdaRepoBranch") || "main";
const lambdaConnectionArn = config.require("lambdaConnectionArn");
const lambdaAliasName = config.get("lambdaAliasName") || "live";

// Create networking infrastructure with fck-nat for cost savings
const networking = new Networking(`${appName}-dev`, {
    name: appName,
    environment: "dev",
    cidrBlock: "10.0.0.0/24",
    availabilityZoneCount: 2,
    useFckNat: config.getBoolean("useFckNat") ?? true, // Default to fck-nat for cost savings
});

// Security groups for App Runner and Lambda to reach private resources (e.g., RDS)
const apprunnerSg = new aws.ec2.SecurityGroup(`${appName}-dev-apprunner-sg`, {
    description: "App Runner egress SG",
    vpcId: networking.vpc.id,
    egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
    tags: envConfig.tags,
});

const lambdaSg = new aws.ec2.SecurityGroup(`${appName}-dev-lambda-sg`, {
    description: "Lambda egress SG",
    vpcId: networking.vpc.id,
    egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
    tags: envConfig.tags,
});

// Create database
const database = new Database(`${appName}-dev-db`, {
    name: appName,
    environment: "dev",
    subnetIds: networking.getPrivateSubnetIds(),
    securityGroupId: networking.vpc.defaultSecurityGroupId,
    allowedSecurityGroupIds: [apprunnerSg.id, lambdaSg.id],
    dbName: `${appName.replace(/-/g, "_")}_dev`,
    username: dbUsername,
    password: dbPassword,
    instanceClass: "db.t3.micro", // Cost optimized for dev
    allocatedStorage: 20,
    maxAllocatedStorage: 50, // Lower limit for dev
});

// Create App Runner service
const appService = new AppRunnerService(`${appName}-dev-app`, {
    name: appName,
    environment: "dev",
    repositoryUrl: repositoryUrl,
    branch: config.get("branch") || "develop",
    databaseUrl: database.getConnectionString(),
    environmentVariables: {
        API_BASE_URL: config.get("apiBaseUrl") || "",
        LOG_LEVEL: "debug",
        FEATURE_FLAGS: JSON.stringify({
            enableNewFeature: false,
            debugMode: true,
        }),
    },
    maxConcurrency: 10, // Lower concurrency for dev
    maxSize: 2, // Max 2 instances for dev
    minSize: 0, // Scale to zero when not in use
    cpu: "0.25 vCPU", // Minimum CPU for cost savings
    memory: "0.5 GB", // Minimum memory for cost savings
    // VPC networking for private access to RDS
    vpcSubnetIds: networking.getPrivateSubnetIds(),
    vpcSecurityGroupIds: [apprunnerSg.id],
});

// Create Lambda functions
const lambdaGroup = new LambdaGroup(`${appName}-dev-lambdas`);

// Example Lambda function - replace with your actual functions
const exampleLambda = lambdaGroup.addFunction(`${appName}-dev-example`, {
    name: `${appName}-example`,
    environment: "dev",
    runtime: "nodejs22.x",
    handler: "index.handler",
    code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(`
            exports.handler = async (event) => {
                console.log('Event:', JSON.stringify(event));
                return {
                    statusCode: 200,
                    body: JSON.stringify({ message: 'Hello from Lambda!' })
                };
            };
        `),
    }),
    environmentVariables: {
        DATABASE_URL: database.getConnectionString(),
        ENVIRONMENT: "dev",
    },
    timeout: 30,
    memorySize: 128, // Minimum for cost optimization
    // VPC networking for private access to RDS
    subnetIds: networking.getPrivateSubnetIds(),
    securityGroupIds: [lambdaSg.id],
    aliasName: lambdaAliasName,
});

// CI/CD pipeline to package and deploy the example Lambda from GitHub via CodeBuild/CodeDeploy
const exampleLambdaPipeline = new LambdaCicdPipeline(`${appName}-dev-example-pipeline`, {
    name: `${appName}-example`,
    environment: "dev",
    repositoryOwner: lambdaRepoOwner,
    repositoryName: lambdaRepoName,
    branch: lambdaRepoBranch,
    connectionArn: lambdaConnectionArn,
    lambdaFunctionName: exampleLambda.getFunctionName(),
    lambdaAliasName: lambdaAliasName,
});

// Create monitoring and alerting
const monitoring = new Monitoring(`${appName}-dev-monitoring`, {
    name: appName,
    environment: "dev",
    serviceName: appService.service.serviceName,
    dbInstanceId: database.instance.identifier,
    lambdaFunctionNames: [exampleLambda.getFunctionName()],
    alertEmail: alertEmail,
});

// Optional WAF
let wafArn: pulumi.Output<string> | undefined = undefined;
if (enableWaf) {
    const waf = new AppWaf(`${appName}-dev`, {
        name: appName,
        environment: "dev",
        resourceArn: appService.getServiceArn(),
        rateLimit: 1000,
    });
    wafArn = waf.webAcl.arn;
}

// Optional CloudFront
let cloudFrontDomainName: pulumi.Output<string> | undefined = undefined;
if (enableCloudFront) {
    const originDomain = appService
        .getServiceUrl()
        .apply((u) => u.replace(/^https?:\/\//, "").replace(/\/$/, ""));
    const dist = new aws.cloudfront.Distribution(`${appName}-dev-cdn`, {
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
    natCostInfo: networking.getNatCostInfo(),

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
    exampleLambdaAliasArn: exampleLambda.alias?.arn,
    lambdaPipelineName: exampleLambdaPipeline.codePipeline.name,
    lambdaArtifactBucketName: exampleLambdaPipeline.artifactBucket.bucket,

    // Monitoring
    dashboardUrl: monitoring.getDashboardUrl(),
    budgetName: monitoring.getBudgetName(),
    wafArn: wafArn,
    cloudFrontDomainName: cloudFrontDomainName,

    // Environment info
    environment: "dev",
    region: aws.getRegion().then((r) => r.name),
    tags: envConfig.tags,
};

// Export individual outputs for easy access
export const vpcId = outputs.vpcId;
export const databaseEndpoint = outputs.databaseEndpoint;
export const appServiceUrl = outputs.appServiceUrl;
export const dashboardUrl = outputs.dashboardUrl;
