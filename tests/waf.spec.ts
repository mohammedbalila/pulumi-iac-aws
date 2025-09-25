import { expect } from "chai";
import * as pulumi from "@pulumi/pulumi";
import { withPulumiMocks } from "./mocks";
import { AppWaf } from "../modules/waf";

describe("AppWaf", () => {
    it("creates a WebACL and associates it to the resource", async () => {
        await withPulumiMocks(async (_mocks) => {
            const waf = new AppWaf("waf-dev", {
                name: "app",
                environment: "dev",
                resourceArn: pulumi.output("arn:aws:apprunner:region:123:service/svc"),
                rateLimit: 1000,
            });

            waf.webAcl.arn.apply((arn) => expect(arn).to.match(/wafv2:.*webacl/));
            // Association resource exists
            expect(waf.association).to.exist;
        });
    });
});
