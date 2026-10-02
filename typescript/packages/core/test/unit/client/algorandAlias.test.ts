import { describe, expect, it } from "vitest";
import { x402Client } from "../../../src/client/x402Client";
import { MockSchemeNetworkClient } from "../../mocks";
import { buildPaymentRequired, buildPaymentRequirements } from "../../mocks";
import { Network } from "../../../src/types";

const TESTNET_CAIP = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe" as Network;
const TESTNET_LEGACY = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" as Network;

class AliasClient extends MockSchemeNetworkClient {
  networkEquivalents = (network: string) =>
    network === TESTNET_CAIP || network === TESTNET_LEGACY
      ? [TESTNET_CAIP, TESTNET_LEGACY]
      : [network];
}

describe("x402Client uses a registered alias hook", () => {
  it("reaches a scheme registered under the other published form", async () => {
    const client = new x402Client();
    const scheme = new AliasClient("exact");
    client.register(TESTNET_CAIP, scheme);
    const paymentRequired = buildPaymentRequired({
      accepts: [buildPaymentRequirements({ scheme: "exact", network: TESTNET_LEGACY })],
    });
    await client.createPaymentPayload(paymentRequired);
    expect(scheme.createPaymentPayloadCalls).toHaveLength(1);
    expect(scheme.createPaymentPayloadCalls[0].requirements.network).toBe(TESTNET_LEGACY);
  });

  it("does not alias when the registered scheme has no hook", async () => {
    const client = new x402Client();
    client.register(TESTNET_CAIP, new MockSchemeNetworkClient("exact"));
    const paymentRequired = buildPaymentRequired({
      accepts: [buildPaymentRequirements({ scheme: "exact", network: TESTNET_LEGACY })],
    });
    await expect(client.createPaymentPayload(paymentRequired)).rejects.toThrow(
      /No network\/scheme registered/,
    );
  });

  it("keeps an unrelated network on its own registration", async () => {
    const client = new x402Client();
    const base = new MockSchemeNetworkClient("exact");
    client.register(TESTNET_CAIP, new AliasClient("exact"));
    client.register("eip155:8453" as Network, base);
    await client.createPaymentPayload(
      buildPaymentRequired({
        accepts: [buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network })],
      }),
    );
    expect(base.createPaymentPayloadCalls).toHaveLength(1);
  });
});
