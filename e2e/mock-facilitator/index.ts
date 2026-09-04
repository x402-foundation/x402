import http from "node:http";
import {
  catalogNetworkIds,
  networkCaip2Pattern,
  resolveNetworkCaip2,
} from "./catalog-network.ts";

/**
 * Mock facilitator that claims to support all schemes/networks but errors
 * if verify or settle are actually called. Used as a fallback facilitator
 * during e2e testing so that servers with routes unsupported by the real
 * facilitator (e.g. "upto" on Go/Python facilitators, SVM "upto" on Go/Python)
 * can still start.
 *
 * The real facilitator is always first in the client array and handles
 * all actual operations. This mock only fills validation gaps at startup.
 */

const PORT = parseInt(process.env.PORT || "4099", 10);

const DUMMY_SIGNERS: Record<string, string[]> = {
  evm: ["0x0000000000000000000000000000000000000001"],
  svm: ["11111111111111111111111111111111"],
  aptos: ["0x0000000000000000000000000000000000000000000000000000000000000001"],
  stellar: ["GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"],
  near: ["relayer.testnet"],
  starknet: ["0x1"],
  xrpl: [],
};

// The Starknet feePayer is the account that sponsors settlement gas. Resource
// servers copy it verbatim out of /supported into PaymentRequirements.extra.
const STARKNET_FEE_PAYER = process.env.FACILITATOR_STARKNET_ADDRESS || DUMMY_SIGNERS.starknet[0];

function buildSupportedResponse() {
  const networkIds = catalogNetworkIds();
  const schemesForNetwork = (networkId: string): string[] => {
    if (networkId === "evm" || networkId === "svm") {
      return ["exact", "upto"];
    }
    return ["exact"];
  };
  const versions = [1, 2];

  const kinds: Array<{
    x402Version: number;
    scheme: string;
    network: string;
    extra?: Record<string, unknown>;
  }> = [];

  for (const version of versions) {
    for (const networkId of networkIds) {
      const caip2 = resolveNetworkCaip2(networkId);
      const schemes = schemesForNetwork(networkId);
      for (const scheme of schemes) {
        // Starknet is v2 only, and every kind MUST carry extra.feePayer: a
        // resource server cannot build a signable 402 from a kind that omits it.
        if (networkId === "starknet") {
          if (version === 2) {
            kinds.push({
              x402Version: 2,
              scheme,
              network: caip2,
              extra: { feePayer: STARKNET_FEE_PAYER },
            });
          }
          continue;
        }
        kinds.push({ x402Version: version, scheme, network: caip2 });
      }
    }
  }

  const signers: Record<string, string[]> = {};
  for (const networkId of networkIds) {
    const pattern = networkCaip2Pattern(networkId);
    signers[pattern] = DUMMY_SIGNERS[networkId] ?? [];
  }

  return { kinds, extensions: [], signers };
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(json);
}

const supportedResponse = buildSupportedResponse();

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  const forceExitTimeout = setTimeout(() => process.exit(1), 5_000);
  forceExitTimeout.unref();

  server.close(error => {
    clearTimeout(forceExitTimeout);
    if (error) {
      console.error("Failed to close mock facilitator:", error);
      process.exit(1);
    }
    process.exit(0);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/supported") {
    sendJson(res, 200, supportedResponse);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/close") {
    sendJson(res, 200, { status: "shutting down" });
    setImmediate(shutdown);
    return;
  }

  if (req.method === "POST" && url.pathname === "/verify") {
    sendJson(res, 500, {
      error: "Mock facilitator: /verify should never be called. " +
        "The real facilitator should handle all verification.",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/settle") {
    sendJson(res, 500, {
      error: "Mock facilitator: /settle should never be called. " +
        "The real facilitator should handle all settlement.",
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Mock facilitator listening on port ${PORT}`);
  console.log("Facilitator listening");
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
