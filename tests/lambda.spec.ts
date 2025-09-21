import { expect } from "chai";
import * as pulumi from "@pulumi/pulumi";
import { withPulumiMocks } from "./mocks";
import { LambdaFunction } from "../modules/lambda";

describe("LambdaFunction", () => {
    it("configures VPC when subnets/SGs provided and sets env vars", async () => {
        await withPulumiMocks(async () => {
            const lf = new LambdaFunction("lambda-dev", {
                name: "my-func",
                environment: "dev",
                runtime: "nodejs22.x",
                handler: "index.handler",
                code: new pulumi.asset.AssetArchive({
                    "index.js": new pulumi.asset.StringAsset(
                        "exports.handler=async()=>({statusCode:200})",
                    ),
                }),
                subnetIds: [pulumi.output("subnet-1"), pulumi.output("subnet-2")],
                securityGroupIds: [pulumi.output("sg-1")],
                environmentVariables: { EXTRA: "yes" },
            });

            // VPC config present
            lf.function.vpcConfig!.apply((vpc) => {
                expect(vpc).to.exist;
                expect(vpc!.subnetIds).to.exist;
            });

            // Environment variables include NODE_ENV and our EXTRA
            lf.function.environment!.apply((env) => {
                const vars = env!.variables as any;
                expect(vars.NODE_ENV).to.equal("dev");
                expect(vars.EXTRA).to.equal("yes");
            });
        });
    });
});
