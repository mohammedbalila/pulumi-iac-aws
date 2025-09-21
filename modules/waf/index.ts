import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { commonTags } from "../../shared/config";

export interface WafArgs {
    name: string;
    environment: string;
    resourceArn: pulumi.Input<string>; // App Runner service ARN
    rateLimit?: number; // requests per 5 minutes per IP
}

export class AppWaf extends pulumi.ComponentResource {
    public webAcl: aws.wafv2.WebAcl;
    public association: aws.wafv2.WebAclAssociation;

    constructor(name: string, args: WafArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:waf:AppWaf", name, {}, opts);

        const tags = commonTags(args.environment);

        this.webAcl = new aws.wafv2.WebAcl(
            `${name}-waf`,
            {
                name: `${name}-waf-${args.environment}`,
                scope: "REGIONAL", // App Runner is regional
                defaultAction: { allow: {} },
                visibilityConfig: {
                    cloudwatchMetricsEnabled: true,
                    metricName: `${name}-waf-${args.environment}`,
                    sampledRequestsEnabled: true,
                },
                rules: [
                    {
                        name: "AWSCommon",
                        priority: 1,
                        overrideAction: { none: {} },
                        statement: {
                            managedRuleGroupStatement: {
                                vendorName: "AWS",
                                name: "AWSManagedRulesCommonRuleSet",
                            },
                        },
                        visibilityConfig: {
                            cloudwatchMetricsEnabled: true,
                            metricName: "AWSCommon",
                            sampledRequestsEnabled: true,
                        },
                    },
                    {
                        name: "KnownBadInputs",
                        priority: 2,
                        overrideAction: { none: {} },
                        statement: {
                            managedRuleGroupStatement: {
                                vendorName: "AWS",
                                name: "AWSManagedRulesKnownBadInputsRuleSet",
                            },
                        },
                        visibilityConfig: {
                            cloudwatchMetricsEnabled: true,
                            metricName: "KnownBadInputs",
                            sampledRequestsEnabled: true,
                        },
                    },
                    {
                        name: "RateLimit",
                        priority: 10,
                        action: { block: {} },
                        statement: {
                            rateBasedStatement: {
                                limit: args.rateLimit || 2000,
                                aggregateKeyType: "IP",
                            },
                        },
                        visibilityConfig: {
                            cloudwatchMetricsEnabled: true,
                            metricName: "RateLimit",
                            sampledRequestsEnabled: true,
                        },
                    },
                ],
                tags,
            },
            { parent: this },
        );

        this.association = new aws.wafv2.WebAclAssociation(
            `${name}-waf-assoc`,
            {
                webAclArn: this.webAcl.arn,
                resourceArn: args.resourceArn,
            },
            { parent: this },
        );

        this.registerOutputs({
            webAclArn: this.webAcl.arn,
        });
    }
}
