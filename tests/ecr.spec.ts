import { expect } from "chai";
import { derivePlaceholderSeedConfig } from "../shared/ecr";

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
