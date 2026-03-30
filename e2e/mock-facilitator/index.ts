import http from "node:http";

/**
 * Mock facilitator that claims to support all schemes/networks but errors
 * if verify or settle are actually called. Used as a fallback facilitator
 * during e2e testing so that servers with routes unsupported by the real
 * facilitator (e.g. "upto" on Go/Python facilitators) can still start.
 *
 * The real facilitator is always first in the client array and handles
 * all actual operations. This mock only fills validation gaps at startup.
 */

const PORT = parseInt(process.env.PORT || "4099", 10);
const EVM_NETWORK = process.env.EVM_NETWORK || "eip155:84532";
const SVM_NETWORK = process.env.SVM_NETWORK || "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const APTOS_NETWORK = process.env.APTOS_NETWORK || "aptos:2";
const STELLAR_NETWORK = process.env.STELLAR_NETWORK || "stellar:testnet";

const DUMMY_EVM_SIGNER = "0x0000000000000000000000000000000000000001";
const DUMMY_SVM_SIGNER = "11111111111111111111111111111111";
const DUMMY_APTOS_SIGNER =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const DUMMY_STELLAR_SIGNER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function buildSupportedResponse() {
  const evmSchemes = ["exact", "upto"];
  const otherSchemes = ["exact"];
  const versions = [1, 2];

  const kinds: Array<{
    x402Version: number;
    scheme: string;
    network: string;
  }> = [];

  for (const version of versions) {
    for (const scheme of evmSchemes) {
      kinds.push({ x402Version: version, scheme, network: EVM_NETWORK });
    }
    for (const scheme of otherSchemes) {
      kinds.push({ x402Version: version, scheme, network: SVM_NETWORK });
    }
    if (APTOS_NETWORK) {
      for (const scheme of otherSchemes) {
        kinds.push({ x402Version: version, scheme, network: APTOS_NETWORK });
      }
    }
    if (STELLAR_NETWORK) {
      for (const scheme of otherSchemes) {
        kinds.push({ x402Version: version, scheme, network: STELLAR_NETWORK });
      }
    }
  }

  const signers: Record<string, string[]> = {
    "eip155:*": [DUMMY_EVM_SIGNER],
    "solana:*": [DUMMY_SVM_SIGNER],
  };
  if (APTOS_NETWORK) {
    signers["aptos:*"] = [DUMMY_APTOS_SIGNER];
  }
  if (STELLAR_NETWORK) {
    signers["stellar:*"] = [DUMMY_STELLAR_SIGNER];
  }

  return { kinds, extensions: [], signers };
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(json);
}

const supportedResponse = buildSupportedResponse();

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
