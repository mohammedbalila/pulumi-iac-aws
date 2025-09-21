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
                        cidrBlocks: ["10.0.0.0/16"], // Adjust based on your VPC CIDR
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
                    values: ["fck-nat-amzn2-*"],
                },
                {
                    name: "architecture",
                    values: ["arm64"], // Use ARM for better cost/performance
                },
            ],
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

        // Create fck-nat instances (one per AZ for HA)
        this.instances = [];
        this.routeTables = [];

        const publicSubnetIds = pulumi.output(args.publicSubnetIds);
        const privateSubnetIds = pulumi.output(args.privateSubnetIds);

        publicSubnetIds.apply((pubSubnets) => {
            privateSubnetIds.apply((privSubnets) => {
                for (let i = 0; i < pubSubnets.length; i++) {
                    // Create fck-nat instance
                    const instance = new aws.ec2.Instance(
                        `${args.name}-fck-nat-${i}`,
                        {
                            ami: fckNatAmi.id,
                            instanceType: args.environment === "prod" ? "t4g.small" : "t4g.nano", // ARM instances
                            subnetId: pubSubnets[i],
                            vpcSecurityGroupIds: [this.securityGroup.id],
                            iamInstanceProfile: instanceProfile.name,
                            sourceDestCheck: false, // Critical for NAT functionality

                            // User data for fck-nat configuration
                            userData: pulumi.interpolate`#!/bin/bash
# fck-nat configuration will be handled by the AMI
# The instance will automatically configure itself as a NAT
echo "fck-nat instance starting up"
`,

                            tags: {
                                ...tags,
                                Name: `${args.name}-fck-nat-${i}`,
                                "fck-nat:zone": `${i}`,
                            },
                        },
                        { parent: this },
                    );

                    this.instances.push(instance);

                    // Create route table for this AZ's private subnet
                    const routeTable = new aws.ec2.RouteTable(
                        `${args.name}-private-rt-${i}`,
                        {
                            vpcId: args.vpcId,
                            tags: {
                                ...tags,
                                Name: `${args.name}-private-rt-${i}`,
                            },
                        },
                        { parent: this },
                    );

                    // Route to fck-nat instance
                    new aws.ec2.Route(
                        `${args.name}-private-route-${i}`,
                        {
                            routeTableId: routeTable.id,
                            destinationCidrBlock: "0.0.0.0/0",
                            networkInterfaceId: instance.primaryNetworkInterfaceId,
                        },
                        { parent: this },
                    );

                    // Associate with private subnet
                    new aws.ec2.RouteTableAssociation(
                        `${args.name}-private-rta-${i}`,
                        {
                            subnetId: privSubnets[i],
                            routeTableId: routeTable.id,
                        },
                        { parent: this },
                    );

                    this.routeTables.push(routeTable);
                }
            });
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
