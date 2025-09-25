import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { commonTags } from "../../shared/config";

export interface FckNatArgs {
    name: string;
    environment: string;
    vpcId: pulumi.Input<string>;
    publicSubnetIds: pulumi.Input<string>[];
    privateSubnetIds: pulumi.Input<string>[];
}

export class FckNat extends pulumi.ComponentResource {
    public instances: aws.ec2.Instance[];
    public securityGroup: aws.ec2.SecurityGroup;
    public routeTables: aws.ec2.RouteTable[];

    constructor(name: string, args: FckNatArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:networking:FckNat", name, {}, opts);

        const tags = commonTags(args.environment);
        const vpcCidrBlock = pulumi
            .output(args.vpcId)
            .apply((vpcId) => aws.ec2.getVpc({ id: vpcId }))
            .apply((vpc) => {
                if (!vpc.cidrBlock) {
                    throw new pulumi.RunError(
                        "Unable to resolve CIDR block for the supplied VPC. Ensure the VPC exists before creating fck-nat.",
                    );
                }
                return vpc.cidrBlock;
            });

        // Create security group for fck-nat instances
        this.securityGroup = new aws.ec2.SecurityGroup(
            `${args.name}-fck-nat-sg`,
            {
                name: `${args.name}-fck-nat-sg`,
                description: "Security group for fck-nat instances",
                vpcId: args.vpcId,

                // Allow all outbound traffic
                egress: [
                    {
                        fromPort: 0,
                        toPort: 0,
                        protocol: "-1",
                        cidrBlocks: ["0.0.0.0/0"],
                        description: "Allow all outbound traffic",
                    },
                ],

                // Allow inbound traffic from private subnets
                ingress: [
                    {
                        fromPort: 0,
                        toPort: 0,
                        protocol: "-1",
                        cidrBlocks: vpcCidrBlock.apply((cidr) => [cidr]),
                        description: "Allow traffic from private subnets",
                    },
                ],

                tags: {
                    ...tags,
                    Name: `${args.name}-fck-nat-sg`,
                },
            },
            { parent: this },
        );

        // Get the latest fck-nat AMI
        const fckNatAmi = aws.ec2.getAmiOutput({
            mostRecent: true,
            owners: ["568608671756"], // fck-nat official account
            filters: [
                {
                    name: "name",
                    values: ["fck-nat-al2023-*"],
                },
                {
                    name: "architecture",
                    values: ["arm64"],
                },
            ],
        });

        // Pick an instance type that matches the published AMI architecture. Some regions only
        // publish x86_64 images, so we fall back to t3a.* when arm64 is unavailable.
        const instanceType = fckNatAmi.architecture.apply((architecture) => {
            const prefersArm = architecture === "arm64" || architecture === "aarch64";
            if (prefersArm) {
                return args.environment === "prod" ? "t4g.small" : "t4g.nano";
            }
            return args.environment === "prod" ? "t3a.small" : "t3a.nano";
        });

        // Create IAM role for fck-nat instances
        const role = new aws.iam.Role(
            `${args.name}-fck-nat-role`,
            {
                assumeRolePolicy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                        {
                            Action: "sts:AssumeRole",
                            Effect: "Allow",
                            Principal: {
                                Service: "ec2.amazonaws.com",
                            },
                        },
                    ],
                }),
                tags: tags,
            },
            { parent: this },
        );

        // Attach necessary policies for fck-nat functionality
        const policy = new aws.iam.Policy(
            `${args.name}-fck-nat-policy`,
            {
                policy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [
                        {
                            Effect: "Allow",
                            Action: [
                                "ec2:DescribeInstances",
                                "ec2:DescribeRouteTables",
                                "ec2:CreateRoute",
                                "ec2:ReplaceRoute",
                                "ec2:DeleteRoute",
                                "ec2:DescribeNetworkInterfaces",
                                "ec2:AttachNetworkInterface",
                                "ec2:DetachNetworkInterface",
                                "ec2:ModifyNetworkInterfaceAttribute",
                                "ec2:DescribeNetworkInterfaceAttribute",
                            ],
                            Resource: "*",
                        },
                    ],
                }),
            },
            { parent: this },
        );

        new aws.iam.RolePolicyAttachment(
            `${args.name}-fck-nat-policy-attachment`,
            {
                role: role.name,
                policyArn: policy.arn,
            },
            { parent: this },
        );

        // Create instance profile
        const instanceProfile = new aws.iam.InstanceProfile(
            `${args.name}-fck-nat-profile`,
            {
                role: role.name,
            },
            { parent: this },
        );

        // Create fck-nat instances (one per AZ for HA) using deterministic arrays
        if (args.publicSubnetIds.length !== args.privateSubnetIds.length) {
            throw new pulumi.RunError(
                "publicSubnetIds and privateSubnetIds must have the same length for fck-nat.",
            );
        }

        const userDataScript = pulumi.interpolate`${[
            "#!/bin/bash",
            "# fck-nat configuration will be handled by the AMI",
            "# The instance will automatically configure itself as a NAT",
            'echo "fck-nat instance starting up"',
        ].join("\n")}`;

        this.instances = args.publicSubnetIds.map(
            (publicSubnetId, index) =>
                new aws.ec2.Instance(
                    `${args.name}-fck-nat-${index}`,
                    {
                        ami: fckNatAmi.id,
                        instanceType: instanceType,
                        subnetId: publicSubnetId,
                        vpcSecurityGroupIds: [this.securityGroup.id],
                        iamInstanceProfile: instanceProfile.name,
                        sourceDestCheck: false, // Critical for NAT functionality
                        userData: userDataScript,
                        tags: {
                            ...tags,
                            Name: `${args.name}-fck-nat-${index}`,
                            "fck-nat:zone": `${index}`,
                        },
                    },
                    { parent: this },
                ),
        );

        this.routeTables = args.privateSubnetIds.map((privateSubnetId, index) => {
            const routeTable = new aws.ec2.RouteTable(
                `${args.name}-private-rt-${index}`,
                {
                    vpcId: args.vpcId,
                    tags: {
                        ...tags,
                        Name: `${args.name}-private-rt-${index}`,
                    },
                },
                { parent: this },
            );

            new aws.ec2.Route(
                `${args.name}-private-route-${index}`,
                {
                    routeTableId: routeTable.id,
                    destinationCidrBlock: "0.0.0.0/0",
                    networkInterfaceId: this.instances[index].primaryNetworkInterfaceId,
                },
                { parent: this },
            );

            new aws.ec2.RouteTableAssociation(
                `${args.name}-private-rta-${index}`,
                {
                    subnetId: privateSubnetId,
                    routeTableId: routeTable.id,
                },
                { parent: this },
            );

            return routeTable;
        });

        // Register outputs
        this.registerOutputs({
            securityGroupId: this.securityGroup.id,
            instanceIds: this.instances.map((i) => i.id),
            routeTableIds: this.routeTables.map((rt) => rt.id),
        });
    }

    // Helper methods
    public getInstanceIds(): pulumi.Output<string>[] {
        return this.instances.map((instance) => instance.id);
    }

    public getSecurityGroupId(): pulumi.Output<string> {
        return this.securityGroup.id;
    }

    // Get estimated monthly cost savings
    public getCostSavings(): {
        natGatewayCost: number;
        fckNatCost: number;
        monthlySavings: number;
    } {
        const azCount = this.instances.length;

        // NAT Gateway: $45/month per AZ + data processing
        const natGatewayCost = azCount * 45;

        // fck-nat: t4g.nano ~$3.8/month per AZ (no data processing fees)
        const fckNatCost = azCount * 3.8;

        return {
            natGatewayCost,
            fckNatCost,
            monthlySavings: natGatewayCost - fckNatCost,
        };
    }
}
