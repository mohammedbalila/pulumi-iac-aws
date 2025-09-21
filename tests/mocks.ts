import * as pulumi from "@pulumi/pulumi";

// Pulumi Mocks to run unit tests without real AWS
class AwsMocks implements pulumi.runtime.Mocks {
    newResource(args: pulumi.runtime.MockResourceArgs): pulumi.runtime.MockResourceResult {
        const { type, name, inputs } = args;
        const id = `${name}-id`;
        const state: any = { ...inputs };

        // Add some commonly expected computed outputs by resource type
        if (type === "aws:apprunner/service:Service") {
            state.serviceUrl = `https://${name}.example.com`;
            state.serviceName = name;
            state.arn = `arn:aws:apprunner:region:123456789012:service/${name}`;
        }

        if (type === "aws:apprunner/connection:Connection") {
            state.arn = `arn:aws:apprunner:region:123456789012:connection/${name}`;
        }

        if (type === "aws:apprunner/vpcConnector:VpcConnector") {
            state.arn = `arn:aws:apprunner:region:123456789012:vpcconnector/${name}`;
        }

        if (type === "aws:rds/instance:Instance") {
            state.endpoint = `${name}.db.example.com:5432`;
            state.identifier = `${name}`;
            state.arn = `arn:aws:rds:region:123456789012:db:${name}`;
        }

        if (type === "aws:cloudwatch/dashboard:Dashboard") {
            const dashName = inputs["dashboardName"] || name;
            state.dashboardUrl = `https://console.aws.amazon.com/cloudwatch/home#dashboards:name=${dashName}`;
        }

        if (type === "aws:lambda/function:Function") {
            state.arn = `arn:aws:lambda:region:123456789012:function:${name}`;
            state.name = inputs["name"] || name;
        }

        if (type === "aws:wafv2/webAcl:WebAcl") {
            state.arn = `arn:aws:wafv2:region:123456789012:regional/webacl/${name}`;
        }

        return { id, state };
    }

    call(args: pulumi.runtime.MockCallArgs): pulumi.runtime.MockCallResult {
        const { token } = args;
        switch (token) {
            case "aws:ec2/getAvailabilityZones:getAvailabilityZones":
                return {
                    names: ["us-west-2a", "us-west-2b", "us-west-2c"],
                    zoneIds: ["use2-az1", "use2-az2", "use2-az3"],
                };
            case "aws:getRegion":
                return { name: "us-west-2", id: "us-west-2" };
            case "aws:getCallerIdentity":
                return {
                    accountId: "123456789012",
                    arn: "arn:aws:iam::123456789012:root",
                    userId: "AIDA...",
                };
            case "aws:ec2/getAmi:getAmi":
                return { id: "ami-1234567890abcdef0" };
            default:
                return {};
        }
    }
}

export async function withPulumiMocks(testBody: () => Promise<void>): Promise<void> {
    pulumi.runtime.setMocks(new AwsMocks(), "project", "stack", false);
    await pulumi.runtime.runInPulumiStack(async () => {
        await testBody();
    });
}
