import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { NetworkingArgs } from "../../shared/types";
import { commonTags } from "../../shared/config";
import { FckNat } from "./fck-nat";

export class Networking extends pulumi.ComponentResource {
    public vpc: aws.ec2.Vpc;
    public privateSubnets: aws.ec2.Subnet[];
    public publicSubnets: aws.ec2.Subnet[];
    public internetGateway: aws.ec2.InternetGateway;
    public natGateway?: aws.ec2.NatGateway;
    public fckNat?: FckNat;
    public privateRouteTable?: aws.ec2.RouteTable;
    public publicRouteTable: aws.ec2.RouteTable;

    constructor(name: string, args: NetworkingArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:networking:Networking", name, {}, opts);

        const tags = commonTags(args.environment);

        // Cost optimization: Use smaller CIDR block than default /16
        this.vpc = new aws.ec2.Vpc(
            `${args.name}-vpc`,
            {
                cidrBlock: args.cidrBlock || "10.0.0.0/24", // /24 = 256 IPs
                enableDnsHostnames: true,
                enableDnsSupport: true,
                tags: {
                    ...tags,
                    Name: `${args.name}-vpc`,
                },
            },
            { parent: this },
        );

        // Get availability zones - limit to 2 for cost optimization
        const azs = aws.getAvailabilityZones({ state: "available" });
        const azCount = args.availabilityZoneCount || 2;

        // Create Internet Gateway
        this.internetGateway = new aws.ec2.InternetGateway(
            `${args.name}-igw`,
            {
                vpcId: this.vpc.id,
                tags: {
                    ...tags,
                    Name: `${args.name}-igw`,
                },
            },
            { parent: this },
        );

        // Create public subnets
        this.publicSubnets = [];
        for (let i = 0; i < azCount; i++) {
            const publicSubnet = new aws.ec2.Subnet(
                `${args.name}-public-${i}`,
                {
                    vpcId: this.vpc.id,
                    cidrBlock: `10.0.0.${i * 64}/26`, // /26 = 64 IPs per subnet
                    availabilityZone: azs.then((azs) => azs.names[i]),
                    mapPublicIpOnLaunch: true,
                    tags: {
                        ...tags,
                        Name: `${args.name}-public-${i}`,
                        Type: "public",
                    },
                },
                { parent: this },
            );
            this.publicSubnets.push(publicSubnet);
        }

        // Create private subnets
        this.privateSubnets = [];
        for (let i = 0; i < azCount; i++) {
            const privateSubnet = new aws.ec2.Subnet(
                `${args.name}-private-${i}`,
                {
                    vpcId: this.vpc.id,
                    cidrBlock: `10.0.0.${128 + i * 64}/26`, // Start from .128 for private
                    availabilityZone: azs.then((azs) => azs.names[i]),
                    tags: {
                        ...tags,
                        Name: `${args.name}-private-${i}`,
                        Type: "private",
                    },
                },
                { parent: this },
            );
            this.privateSubnets.push(privateSubnet);
        }

        // Choose between NAT Gateway and fck-nat based on configuration
        if (args.useFckNat) {
            // Use fck-nat for cost savings
            this.fckNat = new FckNat(
                `${args.name}-fck-nat`,
                {
                    name: args.name,
                    environment: args.environment,
                    vpcId: this.vpc.id,
                    publicSubnetIds: this.publicSubnets.map((s) => s.id),
                    privateSubnetIds: this.privateSubnets.map((s) => s.id),
                },
                { parent: this },
            );
        } else {
            // Use traditional NAT Gateway
            // Create Elastic IP for NAT Gateway
            const eip = new aws.ec2.Eip(
                `${args.name}-nat-eip`,
                {
                    domain: "vpc",
                    tags: {
                        ...tags,
                        Name: `${args.name}-nat-eip`,
                    },
                },
                { parent: this },
            );

            // Create NAT Gateway in first public subnet
            this.natGateway = new aws.ec2.NatGateway(
                `${args.name}-nat`,
                {
                    allocationId: eip.id,
                    subnetId: this.publicSubnets[0].id,
                    tags: {
                        ...tags,
                        Name: `${args.name}-nat`,
                    },
                },
                { parent: this },
            );
        }

        // Create public route table
        this.publicRouteTable = new aws.ec2.RouteTable(
            `${args.name}-public-rt`,
            {
                vpcId: this.vpc.id,
                tags: {
                    ...tags,
                    Name: `${args.name}-public-rt`,
                },
            },
            { parent: this },
        );

        // Public route to Internet Gateway
        new aws.ec2.Route(
            `${args.name}-public-route`,
            {
                routeTableId: this.publicRouteTable.id,
                destinationCidrBlock: "0.0.0.0/0",
                gatewayId: this.internetGateway.id,
            },
            { parent: this },
        );

        // Associate public subnets with public route table
        this.publicSubnets.forEach((subnet, i) => {
            new aws.ec2.RouteTableAssociation(
                `${args.name}-public-rta-${i}`,
                {
                    subnetId: subnet.id,
                    routeTableId: this.publicRouteTable.id,
                },
                { parent: this },
            );
        });

        // Create private routing - handled differently for fck-nat vs NAT Gateway
        if (!args.useFckNat && this.natGateway) {
            // Traditional NAT Gateway setup
            this.privateRouteTable = new aws.ec2.RouteTable(
                `${args.name}-private-rt`,
                {
                    vpcId: this.vpc.id,
                    tags: {
                        ...tags,
                        Name: `${args.name}-private-rt`,
                    },
                },
                { parent: this },
            );

            // Private route to NAT Gateway
            new aws.ec2.Route(
                `${args.name}-private-route`,
                {
                    routeTableId: this.privateRouteTable!.id,
                    destinationCidrBlock: "0.0.0.0/0",
                    natGatewayId: this.natGateway!.id,
                },
                { parent: this },
            );

            // Associate private subnets with private route table
            this.privateSubnets.forEach((subnet, i) => {
                new aws.ec2.RouteTableAssociation(
                    `${args.name}-private-rta-${i}`,
                    {
                        subnetId: subnet.id,
                        routeTableId: this.privateRouteTable!.id,
                    },
                    { parent: this },
                );
            });
        }
        // For fck-nat, routing is handled within the FckNat component

        // Register outputs
        this.registerOutputs({
            vpcId: this.vpc.id,
            publicSubnetIds: this.publicSubnets.map((s) => s.id),
            privateSubnetIds: this.privateSubnets.map((s) => s.id),
        });
    }

    // Helper method to get subnet IDs
    public getPrivateSubnetIds(): pulumi.Output<string>[] {
        return this.privateSubnets.map((subnet) => subnet.id);
    }

    public getPublicSubnetIds(): pulumi.Output<string>[] {
        return this.publicSubnets.map((subnet) => subnet.id);
    }

    // Get NAT cost information
    public getNatCostInfo(): { type: string; monthlyCost: number; savings?: number } {
        if (this.fckNat) {
            const costInfo = this.fckNat.getCostSavings();
            return {
                type: "fck-nat",
                monthlyCost: costInfo.fckNatCost,
                savings: costInfo.monthlySavings,
            };
        } else {
            const azCount = this.privateSubnets.length;
            return {
                type: "nat-gateway",
                monthlyCost: azCount * 45, // $45/month per NAT Gateway
            };
        }
    }
}
