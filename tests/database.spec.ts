import { expect } from "chai";
import * as pulumi from "@pulumi/pulumi";
import { withPulumiMocks } from "./mocks";
import { Database } from "../modules/database";

describe("Database", () => {
    it("restricts ingress to allowed SGs when provided", async () => {
        await withPulumiMocks(async (_mocks) => {
            const allowed = [pulumi.output("sg-a"), pulumi.output("sg-b")];
            const db = new Database("db-dev", {
                name: "app",
                environment: "dev",
                subnetIds: [pulumi.output("subnet-1"), pulumi.output("subnet-2")],
                securityGroupId: pulumi.output("sg-default"),
                allowedSecurityGroupIds: allowed,
                dbName: "app_dev",
                username: "postgres",
                password: pulumi.output("secret"),
            });

            db.securityGroup.ingress!.apply((rules: any[]) => {
                expect(rules.length).to.equal(allowed.length);
                // Each rule should be TCP 5432 with one SG in securityGroups
                rules.forEach((r) => {
                    expect(r.protocol).to.equal("tcp");
                    expect(r.fromPort).to.equal(5432);
                    expect(r.toPort).to.equal(5432);
                    expect(r.securityGroups).to.be.an("array").with.length(1);
                });
            });
        });
    });
});
