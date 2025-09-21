import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { DatabaseArgs } from "../../shared/types";
import { commonTags } from "../../shared/config";

export class Database extends pulumi.ComponentResource {
    public instance: aws.rds.Instance;
    public subnetGroup: aws.rds.SubnetGroup;
    public securityGroup: aws.ec2.SecurityGroup;
    public connectionString: pulumi.Output<string>;

    constructor(name: string, args: DatabaseArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:database:Database", name, {}, opts);

        const tags = commonTags(args.environment);

        // Create DB subnet group
        this.subnetGroup = new aws.rds.SubnetGroup(
            `${args.name}-subnet-group`,
            {
                subnetIds: args.subnetIds,
                tags: {
                    ...tags,
                    Name: `${args.name}-subnet-group`,
                },
            },
            { parent: this },
        );

        // Create security group for RDS
        this.securityGroup = new aws.ec2.SecurityGroup(
            `${args.name}-db-sg`,
            {
                description: `Security group for ${args.name} RDS instance`,
                ingress:
                    args.allowedSecurityGroupIds && args.allowedSecurityGroupIds.length > 0
                        ? args.allowedSecurityGroupIds.map((sgId, idx) => ({
                              fromPort: 5432,
                              toPort: 5432,
                              protocol: "tcp",
                              securityGroups: [sgId],
                              description: `Postgres ingress from SG (${idx + 1})`,
                          }))
                        : [
                              {
                                  fromPort: 5432,
                                  toPort: 5432,
                                  protocol: "tcp",
                                  securityGroups: [args.securityGroupId], // Backward compatible: single SG allowed
                              },
                          ],
                egress: [
                    {
                        fromPort: 0,
                        toPort: 0,
                        protocol: "-1",
                        cidrBlocks: ["0.0.0.0/0"],
                    },
                ],
                tags: {
                    ...tags,
                    Name: `${args.name}-db-sg`,
                },
            },
            { parent: this },
        );

        // Determine instance class based on environment
        const instanceClass =
            args.instanceClass || (args.environment === "prod" ? "db.t4g.small" : "db.t3.micro");

        // Cost optimization settings
        const isProduction = args.environment === "prod";

        // Create RDS instance with cost optimizations
        this.instance = new aws.rds.Instance(
            `${args.name}-postgres`,
            {
                identifier: `${args.name}-postgres-${args.environment}`,

                // Storage configuration - cost optimized
                allocatedStorage: args.allocatedStorage || 20, // Minimum for GP3
                maxAllocatedStorage: args.maxAllocatedStorage || 100, // Auto-scaling limit
                storageType: "gp3", // GP3 is more cost-effective than GP2
                storageEncrypted: true,

                // Engine configuration
                engine: "postgres",
                engineVersion: "15.4",
                instanceClass: instanceClass,

                // Database configuration
                dbName: args.dbName,
                username: args.username,
                password: args.password,
                port: 5432,

                // Availability and backup configuration
                multiAz: isProduction, // Multi-AZ only for production
                backupRetentionPeriod: isProduction ? 7 : 1,
                backupWindow: "03:00-04:00", // 3-4 AM UTC
                maintenanceWindow: "sun:04:00-sun:05:00", // Sunday 4-5 AM UTC

                // Networking
                dbSubnetGroupName: this.subnetGroup.name,
                vpcSecurityGroupIds: [this.securityGroup.id],
                publiclyAccessible: false,

                // Performance configuration
                performanceInsightsEnabled: isProduction,
                performanceInsightsRetentionPeriod: isProduction ? 7 : undefined,
                monitoringInterval: isProduction ? 60 : 0, // Enhanced monitoring for prod
                monitoringRoleArn: isProduction ? this.createMonitoringRole().arn : undefined,

                // Deletion protection and snapshots
                deletionProtection: isProduction,
                skipFinalSnapshot: !isProduction,
                finalSnapshotIdentifier: isProduction
                    ? `${args.name}-final-snapshot-${new Date().getTime()}`
                    : undefined,

                // Parameter group for performance tuning
                parameterGroupName: this.createParameterGroup(args.name, args.environment).name,

                tags: {
                    ...tags,
                    Name: `${args.name}-postgres`,
                    BackupRequired: isProduction ? "true" : "false",
                },
            },
            { parent: this },
        );

        // Create connection string output
        this.connectionString = pulumi.interpolate`postgresql://${args.username}:${args.password}@${this.instance.endpoint}/${args.dbName}`;

        // Register outputs
        this.registerOutputs({
            instanceId: this.instance.id,
            endpoint: this.instance.endpoint,
            connectionString: this.connectionString,
        });
    }

    private createMonitoringRole(): aws.iam.Role {
        const role = new aws.iam.Role(
            `enhanced-monitoring-role`,
            {
                assumeRolePolicy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                        {
                            Action: "sts:AssumeRole",
                            Effect: "Allow",
                            Principal: {
                                Service: "monitoring.rds.amazonaws.com",
                            },
                        },
                    ],
                }),
            },
            { parent: this },
        );

        new aws.iam.RolePolicyAttachment(
            `enhanced-monitoring-policy`,
            {
                role: role.name,
                policyArn: "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole",
            },
            { parent: this },
        );

        return role;
    }

    private createParameterGroup(name: string, environment: string): aws.rds.ParameterGroup {
        const parameterGroup = new aws.rds.ParameterGroup(
            `${name}-postgres-params`,
            {
                name: `${name}-postgres-params-${environment}`,
                family: "postgres15",
                description: `PostgreSQL 15 parameter group for ${name}-${environment}`,

                // Performance optimization parameters
                parameters: [
                    {
                        name: "shared_preload_libraries",
                        value: "pg_stat_statements",
                    },
                    {
                        name: "log_statement",
                        value: environment === "prod" ? "none" : "all",
                    },
                    {
                        name: "log_min_duration_statement",
                        value: "1000", // Log queries taking more than 1 second
                    },
                    {
                        name: "max_connections",
                        value: environment === "prod" ? "200" : "100",
                    },
                ],

                tags: commonTags(environment),
            },
            { parent: this },
        );

        return parameterGroup;
    }

    // Helper methods
    public getConnectionString(): pulumi.Output<string> {
        return this.connectionString;
    }

    public getEndpoint(): pulumi.Output<string> {
        return this.instance.endpoint;
    }

    public getSecurityGroupId(): pulumi.Output<string> {
        return this.securityGroup.id;
    }
}
