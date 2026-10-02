import { describe, expect, it } from "vitest";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
} from "../../mocks";
import { Network } from "../../../src/types";

const TESTNET_CAIP = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe" as Network;
const TESTNET_LEGACY = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" as Network;

class AliasServer extends MockSchemeNetworkServer {
  networkEquivalents = (network: string) =>
    network === TESTNET_CAIP || network === TESTNET_LEGACY
      ? [TESTNET_CAIP, TESTNET_LEGACY]
      : [network];
}

function serverWith(kinds: Array<{ network: Network }>, scheme: MockSchemeNetworkServer) {
  const facilitator = new MockFacilitatorClient(
    buildSupportedResponse({
      kinds: kinds.map(kind => ({ x402Version: 2, scheme: "exact", network: kind.network })),
    }),
  );
  const server = new x402ResourceServer(facilitator);
  server.register(TESTNET_CAIP, scheme);
  return server;
}

describe("x402ResourceServer uses a registered alias hook", () => {
  it("finds a facilitator kind listed under the other published form", async () => {
    const server = serverWith([{ network: TESTNET_LEGACY }], new AliasServer("exact"));
    await server.initialize();
    const kind = server.getSupportedKind(2, TESTNET_CAIP, "exact");
    expect(kind?.network).toBe(TESTNET_LEGACY);
    expect(kind?.scheme).toBe("exact");
    expect(server.getRegisteredScheme(TESTNET_LEGACY, "exact")?.scheme).toBe("exact");
  });

  it("keeps the requested kind when both published forms are listed", async () => {
    const server = serverWith(
      [{ network: TESTNET_CAIP }, { network: TESTNET_LEGACY }],
      new AliasServer("exact"),
    );
    await server.initialize();
    expect(server.getSupportedKind(2, TESTNET_CAIP, "exact")?.network).toBe(TESTNET_CAIP);
    expect(server.getSupportedKind(2, TESTNET_LEGACY, "exact")?.network).toBe(TESTNET_LEGACY);
  });

  it("does not alias without the hook and refuses an unknown tail", async () => {
    const plain = serverWith([{ network: TESTNET_LEGACY }], new MockSchemeNetworkServer("exact"));
    await plain.initialize();
    expect(plain.getSupportedKind(2, TESTNET_CAIP, "exact")).toBeUndefined();

    const aliased = serverWith([{ network: TESTNET_LEGACY }], new AliasServer("exact"));
    await aliased.initialize();
    expect(
      aliased.getSupportedKind(2, "algorand:not-a-published-tail" as Network, "exact"),
    ).toBeUndefined();
    expect(aliased.getSupportedKind(2, "eip155:8453" as Network, "exact")).toBeUndefined();
  });
});
