import { expect } from "chai";
import { withPulumiMocks } from "./mocks";
import { Networking } from "../modules/networking";

describe("Networking", () => {
    it("uses fck-nat when configured and no NAT Gateway is created", async () => {
        await withPulumiMocks(async () => {
            const net = new Networking("net-dev", {
                name: "app",
                environment: "dev",
                cidrBlock: "10.0.0.0/24",
                availabilityZoneCount: 2,
                useFckNat: true,
            });
            expect(net.fckNat).to.exist;
            expect(net.natGateway).to.be.undefined;
        });
    });

    it("creates a NAT Gateway when fck-nat is disabled", async () => {
        await withPulumiMocks(async () => {
            const net = new Networking("net-dev", {
                name: "app",
                environment: "dev",
                cidrBlock: "10.0.0.0/24",
                availabilityZoneCount: 2,
                useFckNat: false,
            });
            expect(net.natGateway).to.exist;
        });
    });
});
