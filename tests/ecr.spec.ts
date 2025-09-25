import { expect } from "chai";
import * as pulumi from "@pulumi/pulumi";
import { derivePlaceholderSeedConfig } from "../shared/ecr";
import { ECRRepository } from "../modules/ecr";
import { withPulumiMocks } from "./mocks";

describe("derivePlaceholderSeedConfig", () => {
    it("defaults to latest when no image URI provided", () => {
        const config = derivePlaceholderSeedConfig(undefined);
        expect(config.enabled).to.equal(true);
        expect(config.tag).to.equal("latest");
        expect(config.warning).to.be.undefined;
    });

    it("disables seeding for digest references", () => {
        const config = derivePlaceholderSeedConfig(
            "123456789012.dkr.ecr.us-west-2.amazonaws.com/app@sha256:abc",
        );
        expect(config.enabled).to.equal(false);
        expect(config.tag).to.be.undefined;
        expect(config.warning).to.include("digest reference");
    });

    it("extracts tag component from image URI", () => {
        const config = derivePlaceholderSeedConfig(
            "123456789012.dkr.ecr.us-west-2.amazonaws.com/app:my-tag",
        );
        expect(config.enabled).to.equal(true);
        expect(config.tag).to.equal("my-tag");
    });
});

describe("ECRRepository placeholder seeding", () => {
    it("creates placeholder command when seeding enabled", async function () {
        this.timeout(5000);

        await withPulumiMocks(async () => {
            const repo = new ECRRepository("test-ecr", {
                name: "test-app",
                environment: "dev",
                seedWithPlaceholderImage: true,
                placeholderImageTag: "bootstrap",
            });

            const seed = repo.getPlaceholderSeedResource();
            expect(seed).to.not.be.undefined;

            const serialized = await pulumi.runtime.serializeProperties("placeholder-test", {
                create: seed!.create,
            });
            const script = serialized.create as string;

            expect(script).to.contain(":bootstrap");
            expect(script).to.contain("docker push");
        });
    });

    it("skips placeholder command when seeding disabled", async () => {
        await withPulumiMocks(async () => {
            const repo = new ECRRepository("test-ecr-disabled", {
                name: "test-app",
                environment: "dev",
                seedWithPlaceholderImage: false,
            });

            const seed = repo.getPlaceholderSeedResource();
            expect(seed).to.be.undefined;
        });
    });
});
