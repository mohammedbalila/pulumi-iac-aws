import * as pulumi from "@pulumi/pulumi";
import { expect } from "chai";
import { GitHubActionsRole } from "../modules/cicd/github-actions-role";
import { withPulumiMocks } from "./mocks";

describe("GitHubActionsRole", () => {
    it("includes branch and environment subjects in the trust policy", async () => {
        await withPulumiMocks(async () => {
            const role = new GitHubActionsRole("test-role", {
                name: "app",
                environment: "dev",
                githubOrg: "example",
                githubRepo: "repo",
                githubBranches: ["develop"],
                githubEnvironments: ["dev"],
                ecrRepositoryArns: ["arn:aws:ecr:region:123456789012:repository/app"],
            });

            const assumeRolePolicy = await new Promise<string>((resolve) => {
                pulumi.output(role.role.assumeRolePolicy).apply((policy) => {
                    resolve(policy);
                    return policy;
                });
            });
            const policy = JSON.parse(assumeRolePolicy);
            const subjects = policy.Statement[0].Condition.StringLike[
                "token.actions.githubusercontent.com:sub"
            ];

            expect(subjects).to.include.members([
                "repo:example/repo:ref:refs/heads/develop",
                "repo:example/repo:environment:dev",
            ]);
        });
    });
});
