import { describe, expect, it } from "vitest";
import { x402Client } from "../../../../core/src/client/x402Client";
import { x402ResourceServer } from "../../../../core/src/server/x402ResourceServer";
import type { FacilitatorClient } from "@x402/core/types";
import type { ClientAvmSigner } from "../../src/signer";
import { ExactAvmScheme as ExactAvmClientScheme } from "../../src/exact/client/scheme";
import { ExactAvmScheme as ExactAvmServerScheme } from "../../src/exact/server/scheme";
import { ALGORAND_TESTNET_CAIP2, ALGORAND_TESTNET_GENESIS_HASH } from "../../src/constants";
import { algorandLookupAliases, publishedAlgorandForms } from "../../src/utils";
import type { Network } from "@x402/core/types";

const TESTNET_CAIP = ALGORAND_TESTNET_CAIP2 as Network;
const TESTNET_LEGACY = `algorand:${ALGORAND_TESTNET_GENESIS_HASH}` as Network;

class ProbeClient extends ExactAvmClientScheme {
  async createPaymentPayload(): Promise<never> {
    throw new Error("scheme_reached");
  }
}

describe("ExactAvmScheme alias hook is used by the real client and server", () => {
  it("publishes both forms and leaves unknown tails unchanged", () => {
    expect(publishedAlgorandForms(TESTNET_CAIP)).toEqual([TESTNET_CAIP, TESTNET_LEGACY]);
    expect(publishedAlgorandForms(TESTNET_LEGACY)).toEqual([TESTNET_CAIP, TESTNET_LEGACY]);
    expect(algorandLookupAliases("eip155:8453")).toEqual(["eip155:8453"]);
    expect(algorandLookupAliases("algorand:not-a-published-tail")).toEqual([
      "algorand:not-a-published-tail",
    ]);
    expect(() => publishedAlgorandForms("algorand:not-a-published-tail")).toThrow(
      /Unsupported Algorand network/,
    );
    expect(() => publishedAlgorandForms(`${TESTNET_CAIP}EXTRA`)).toThrow(
      /Unsupported Algorand network/,
    );
  });

  it("lets a canonical client registration satisfy a legacy requirement", async () => {
    const client = new x402Client();
    const scheme = new ProbeClient({} as ClientAvmSigner);
    expect(scheme.networkEquivalents).toBe(algorandLookupAliases);
    client.register(TESTNET_CAIP, scheme);
    await expect(
      client.createPaymentPayload({
        x402Version: 2,
        resource: {
          url: "https://example.com/resource",
          description: "Test",
          mimeType: "application/json",
        },
        accepts: [
          {
            scheme: "exact",
            network: TESTNET_LEGACY,
            amount: "1",
            asset: "10458941",
            payTo: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
            maxTimeoutSeconds: 60,
            extra: {},
          },
        ],
      }),
    ).rejects.toThrow("scheme_reached");
  });

  it("lets the resource server read a legacy facilitator kind for the canonical network", async () => {
    const facilitator = {
      getSupported: async () => ({
        kinds: [{ x402Version: 2, scheme: "exact", network: TESTNET_LEGACY }],
        extensions: [],
        signers: {},
      }),
    } as unknown as FacilitatorClient;
    const server = new x402ResourceServer(facilitator);
    const scheme = new ExactAvmServerScheme();
    expect(scheme.networkEquivalents).toBe(algorandLookupAliases);
    server.register(TESTNET_CAIP, scheme);
    await server.initialize();
    expect(server.getSupportedKind(2, TESTNET_CAIP, "exact")?.network).toBe(TESTNET_LEGACY);
    expect(server.getSupportedKind(2, "eip155:8453" as Network, "exact")).toBeUndefined();
    expect(
      server.getSupportedKind(2, "algorand:not-a-published-tail" as Network, "exact"),
    ).toBeUndefined();
  });
});
