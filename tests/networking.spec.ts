import { expect } from "chai";
import { withPulumiMocks } from "./mocks";
import { Networking, __testing } from "../modules/networking";

describe("Networking", () => {
    it("uses fck-nat when configured and no NAT Gateway is created", async () => {
        await withPulumiMocks(async (_mocks) => {
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
        await withPulumiMocks(async (_mocks) => {
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

    it("computes subnet CIDRs based on the VPC CIDR", () => {
        const baseCidr = "10.2.0.0/24";
        const { parseCidr, determineSubnetPrefix, deriveSubnetCidr } = __testing;
        const { prefix: basePrefix } = parseCidr(baseCidr);
        const subnetPrefix = determineSubnetPrefix(basePrefix, 2);

        const publicCidr = deriveSubnetCidr(baseCidr, subnetPrefix, 0);
        const privateCidr = deriveSubnetCidr(baseCidr, subnetPrefix, 1);

        expect(publicCidr).to.equal("10.2.0.0/26");
        expect(privateCidr).to.equal("10.2.0.64/26");
    });
});
