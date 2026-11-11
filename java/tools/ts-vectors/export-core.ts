/**
 * Exports TS @x402/core reference behaviour as JSON fixtures for java/x402-core.
 * Objects are written in the field order of the TS type declarations, so the
 * Java encoder must reproduce JSON.stringify byte for byte.
 *
 * Run: npm run export:core (from java/tools/ts-vectors).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRequire } from "node:module";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "../../../typescript/packages/core/src/types";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const core = "../../../typescript/packages/core/src";
const { encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader } =
  require(`${core}/http/index.ts`);
const { x402HTTPResourceServer } = require(`${core}/http/x402HTTPResourceServer.ts`);
const { convertToTokenAmount, parseMoney } = require(`${core}/utils/index.ts`);
const outDir = join(here, "../../x402-core/src/test/resources/vectors");
mkdirSync(outDir, { recursive: true });

const tsCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here }).toString().trim();

function write(name: string, cases: unknown): void {
  const doc = { generatedFrom: "typescript/packages/core", tsCommit, cases };
  writeFileSync(join(outDir, name), JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${name}`);
}

const USDM_PREPROD = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";

const req = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "cardano:preprod",
  asset: USDM_PREPROD,
  amount: "10000",
  payTo: "addr_test1qpw0djgj0x59ngrjvqthn7enhvruxnsavsw5th63la3mjel3tkc974sr23jmlzgq5zda4gtv8k9cy38756r9y3qgmkqqjz6aa7",
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "default", areFeesSponsored: false },
  ...overrides,
});

const resource = {
  url: "https://api.example.com/weather",
  description: "Weather API",
  mimeType: "application/json",
};

// 1. PaymentRequired
const paymentRequired1: PaymentRequired = {
  x402Version: 2,
  resource,
  accepts: [req()],
};
const paymentRequired3: PaymentRequired = {
  x402Version: 2,
  error: "Payment required",
  resource: { ...resource, serviceName: "Weather Co", tags: ["weather", "näive ✓"], iconUrl: "https://api.example.com/icon.png" },
  accepts: [
    req(),
    req({ asset: "lovelace", amount: "1500000" }),
    req({
      network: "cardano:mainnet",
      payTo: "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: "masumi", confirmationPolicy: { l1Confirmations: 1 }, nested: { list: [1, 2.5, "x", null, true] } },
    }),
  ],
  extensions: { bazaar: { info: { input: { type: "http", method: "GET" } }, schema: { type: "object" } } },
};
write("payment-required.json", [
  { name: "one-accept", value: paymentRequired1, header: encodePaymentRequiredHeader(paymentRequired1) },
  { name: "three-accepts-resource-extensions", value: paymentRequired3, header: encodePaymentRequiredHeader(paymentRequired3) },
]);

// 2. PaymentPayload
const paymentPayload: PaymentPayload = {
  x402Version: 2,
  resource,
  accepted: req(),
  payload: { transaction: "hKYAgYJYIC1lLQ==", nonce: "2d652d" + "00".repeat(29) + "#0" },
  extensions: { "payment-identifier": { id: "pay_123" } },
};
write("payment-payload.json", [
  { name: "with-resource-and-extensions", value: paymentPayload, header: encodePaymentSignatureHeader(paymentPayload) },
  {
    name: "minimal",
    value: { x402Version: 2, accepted: req(), payload: {} },
    header: encodePaymentSignatureHeader({ x402Version: 2, accepted: req(), payload: {} }),
  },
]);

// 3. SettleResponse (the header strips extensionResponses)
const settleSuccess: SettleResponse = {
  success: true,
  payer: "addr_test1vz09v9yfxguvlp0zsnrpa3tdtm7el8xufp3m5lsm7qxzclgmzkket",
  transaction: "a".repeat(64),
  network: "cardano:preprod",
  amount: "10000",
  extensionResponses: { internal: { secret: true } },
};
const settleFailure: SettleResponse = {
  success: false,
  errorReason: "invalid_exact_cardano_payload_underpaid",
  errorMessage: "output 0 pays 9999 < 10000",
  transaction: "",
  network: "cardano:preprod",
};
const settlePending: SettleResponse = {
  success: false,
  errorReason: "settlement_pending",
  transaction: "b".repeat(64),
  network: "cardano:preprod",
  extra: { transactionId: "b".repeat(64) },
};
write("settle-response.json", [
  { name: "success", value: settleSuccess, header: encodePaymentResponseHeader(settleSuccess) },
  { name: "failure", value: settleFailure, header: encodePaymentResponseHeader(settleFailure) },
  { name: "pending", value: settlePending, header: encodePaymentResponseHeader(settlePending) },
]);

// 4. VerifyResponse
const verifyValid: VerifyResponse = { isValid: true, payer: "addr_test1vz09v9yfxguvlp0zsnrpa3tdtm7el8xufp3m5lsm7qxzclgmzkket" };
const verifyInvalid: VerifyResponse = {
  isValid: false,
  invalidReason: "invalid_exact_cardano_payload_nonce_spent",
  invalidMessage: "nonce input already spent",
};
write("verify-response.json", [
  { name: "valid", value: verifyValid, json: JSON.stringify(verifyValid) },
  { name: "invalid", value: verifyInvalid, json: JSON.stringify(verifyInvalid) },
]);

// 5. SupportedResponse
const supported: SupportedResponse = {
  kinds: [
    {
      x402Version: 2,
      scheme: "exact",
      network: "cardano:preprod",
      extra: {
        assetTransferMethods: ["default", "masumi", "script"],
        areFeesSponsored: false,
        l1Confirmations: { minimum: 0, maximum: 20 },
      },
    },
    { x402Version: 1, scheme: "exact", network: "cardano:mainnet" },
  ],
  extensions: ["bazaar"],
  signers: { "cardano:*": ["addr_test1vz09v9yfxguvlp0zsnrpa3tdtm7el8xufp3m5lsm7qxzclgmzkket"] },
};
write("supported-response.json", [{ name: "kinds-extensions-signers", value: supported, json: JSON.stringify(supported) }]);

// 6. Route patterns (private TS methods, called through the prototype; no constructor side effects)
const httpProto = x402HTTPResourceServer.prototype as unknown as {
  parseRoutePattern(p: string): { verb: string; regex: RegExp; path: string };
  normalizePath(p: string): string;
  normalizeDecodedPath(p: string): string;
};
const patterns = [
  "/weather",
  "GET /weather",
  "POST /api/*",
  "/api/*",
  "/items/:id",
  "/items/[id]",
  "/items/:id/reviews",
  "GET /files/*/raw",
  "/a.b/(x)",
  "* /any",
];
const paths = [
  "/weather",
  "/weather/",
  "/weather?city=Zurich",
  "/weather#frag",
  "/WEATHER",
  "/api",
  "/api/",
  "/api/premium",
  "/api/premium/deep/path",
  "/apix",
  "/items/42",
  "/items/42/",
  "/items/42/reviews",
  "/items/4%2F2",
  "/items/a%5Cb",
  "/items/%E2%9C%93",
  "/items/%zz",
  "/files/x/raw",
  "/files/x/y/raw",
  "/a.b/(x)",
  "/aXb/(x)",
  "//weather",
  "/any",
];
const routeCases = patterns.map(pattern => {
  const parsed = httpProto.parseRoutePattern.call(httpProto, pattern);
  return {
    pattern,
    verb: parsed.verb,
    path: parsed.path,
    matches: paths.map(p => {
      const normalized = httpProto.normalizePath.call(httpProto, p);
      return { path: p, normalized, match: parsed.regex.test(normalized) };
    }),
  };
});
const decodedCases = ["/weather/", "/items/4/2", "/a\\b", "/x//y/"].map(p => ({
  path: p,
  normalized: httpProto.normalizeDecodedPath.call(httpProto, p),
}));
write("route-patterns.json", { routes: routeCases, decoded: decodedCases });

// 7. Money parsing and token amounts
const moneyInputs: Array<string | number> = [
  "$0.01",
  "0.01",
  "$ 1.50",
  "1.50 USD",
  "1.50 usd",
  "0.50 USDM",
  "0.50 usdm",
  "2 USDC.e",
  "  $3  ",
  "1.5 ADA",
  "$1e3",
  "1e3",
  "-1",
  "$-1",
  "1.50USDT",
  "abc",
  "",
  "$.5",
  "0.000001",
  0.01,
  1500,
  1e21,
  1e-7,
  -1,
];
const moneyCases = moneyInputs.map(input => {
  try {
    const r = parseMoney(input);
    return { input, amount: r.amount, ...(r.symbol ? { symbol: r.symbol } : {}) };
  } catch (e) {
    return { input, error: (e as Error).message };
  }
});
const tokenInputs: Array<[string, number]> = [
  ["0.01", 6],
  ["1.5", 6],
  ["1.1234567", 6],
  ["0", 6],
  ["0.000001", 6],
  ["0.0000001", 6],
  ["100", 0],
  ["007.50", 2],
  ["1.", 6],
  ["-1.5", 6],
  ["1e3", 6],
  ["1,5", 6],
  [".5", 6],
];
const tokenCases = tokenInputs.map(([amount, decimals]) => {
  try {
    return { amount, decimals, result: convertToTokenAmount(amount, decimals) };
  } catch (e) {
    return { amount, decimals, error: (e as Error).message };
  }
});
write("money.json", { parseMoney: moneyCases, convertToTokenAmount: tokenCases });
