import { expect } from "chai";
import * as pulumi from "@pulumi/pulumi";
import { withPulumiMocks } from "./mocks";
import { AppRunnerService } from "../modules/compute";

describe("AppRunnerService", () => {
    it("creates a public service and VPC connector when subnets/SGs provided", async () => {
        await withPulumiMocks(async () => {
            const svc = new AppRunnerService("test-app-dev", {
                name: "test-app",
                environment: "dev",
                repositoryUrl: "https://github.com/example/repo",
                databaseUrl: pulumi.output("postgres://user:pw@host:5432/db"),
                vpcSubnetIds: [pulumi.output("subnet-1"), pulumi.output("subnet-2")],
                vpcSecurityGroupIds: [pulumi.output("sg-123")],
                environmentVariables: { FOO: "bar" },
                cpu: "0.25 vCPU",
                memory: "0.5 GB",
            });

            // Ingress is public
            svc.service.networkConfiguration!.apply((nc) => {
                expect(nc!.ingressConfiguration!.isPubliclyAccessible).to.equal(true);
            });

            // VPC connector was created and attached for egress
            expect(svc.vpcConnector).to.not.be.undefined;
            svc.service.networkConfiguration!.apply((nc) => {
                expect(nc!.egressConfiguration!.egressType).to.equal("VPC");
            });

            // Exposes helpful outputs
            svc.getServiceArn().apply((arn) => expect(arn).to.contain(":apprunner:"));
            svc.getServiceUrl().apply((url) => expect(url).to.match(/^https:\/\//));
        });
    });
});
