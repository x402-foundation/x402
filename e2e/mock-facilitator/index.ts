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

const DUMMY_EVM_ADDRESS = "0x0000000000000000000000000000000000000001";
const DUMMY_SVM_ADDRESS = "11111111111111111111111111111111";

const DUMMY_SIGNERS: Record<string, string[]> = {
  evm: [DUMMY_EVM_ADDRESS],
  svm: [DUMMY_SVM_ADDRESS],
  aptos: ["0x0000000000000000000000000000000000000000000000000000000000000001"],
  stellar: ["GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"],
  near: ["relayer.testnet"],
  xrpl: [],
};

/**
 * Extras startup validators require when this mock is the only facilitator
 * advertising a scheme. Real facilitators stay first and keep their own extras;
 * these values only fill gaps (auth-capture, SVM upto/batch) so a server can
 * boot beside a facilitator that does not implement every mounted route.
 */
function extraFor(networkId: string, scheme: string): Record<string, unknown> | undefined {
  if (networkId === "svm" && (scheme === "exact" || scheme === "upto" || scheme === "batch-settlement")) {
    return { feePayer: DUMMY_SVM_ADDRESS, receiverAuthorizer: DUMMY_SVM_ADDRESS };
  }
  if (networkId === "evm" && scheme === "auth-capture") {
    return {
      captureAuthorizer: DUMMY_EVM_ADDRESS,
      receiverAuthorizer: DUMMY_EVM_ADDRESS,
    };
  }
  if (networkId === "evm" && scheme === "batch-settlement") {
    return {
      receiverAuthorizer: DUMMY_EVM_ADDRESS,
      delegatedRefund: true,
      withdrawDelay: 900,
      voucherManager: ["server", "facilitator"],
    };
  }
  if (networkId === "evm" && scheme === "upto") {
    return { facilitatorAddress: DUMMY_EVM_ADDRESS };
  }
  return undefined;
}

function buildSupportedResponse() {
  const networkIds = catalogNetworkIds();
  const schemesForNetwork = (networkId: string): string[] => {
    if (networkId === "evm") {
      return ["exact", "upto", "batch-settlement", "auth-capture"];
    }
    if (networkId === "svm") {
      return ["exact", "upto", "batch-settlement"];
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
        const extra = extraFor(networkId, scheme);
        kinds.push({
          x402Version: version,
          scheme,
          network: caip2,
          ...(extra ? { extra } : {}),
        });
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
