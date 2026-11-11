/**
 * Exports the facilitator wire contract as seen by the TS HTTPFacilitatorClient
 * (typescript/packages/core/src/http/httpFacilitatorClient.ts) for java/x402-core.
 *
 * A local capture server answers each request with the body the normative wire table
 * (source e2e/facilitators/typescript/index.ts) prescribes. The TS client is
 * driven against it for verify, settle and supported, and every case records:
 *   - request: the exact method, path, content type and body bytes the TS client sent
 *   - response: what the capture server answered
 *   - tsOutcome: what the TS client made of it (its parsed result, or the error it threw)
 *
 * The settle abort case serves the Java wire shape and shows that TS settleResponseSchema
 * accepts it; the TS e2e abort body (no transaction, network "unknown") is recorded
 * as rejected.
 *
 * Run: npm run export:facilitator (from java/tools/ts-vectors).
 */
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRequire } from "node:module";
import type {
  PaymentPayload,
  PaymentRequirements,
} from "../../../typescript/packages/core/src/types";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const core = "../../../typescript/packages/core/src";
const { HTTPFacilitatorClient } = require(`${core}/http/httpFacilitatorClient.ts`);
const outDir = join(here, "../../x402-core/src/test/resources/vectors/facilitator");
mkdirSync(outDir, { recursive: true });

const tsCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here }).toString().trim();

const USDM_PREPROD = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";
const PAY_TO =
  "addr_test1qpw0djgj0x59ngrjvqthn7enhvruxnsavsw5th63la3mjel3tkc974sr23jmlzgq5zda4gtv8k9cy38756r9y3qgmkqqjz6aa7";
const PAYER = "addr_test1vz09v9yfxguvlp0zsnrpa3tdtm7el8xufp3m5lsm7qxzclgmzkket";
const TX = "8d7a2d0bd4a8b1b7a8c76e9f5d1b0a3f4e6c2d9b8a7f6e5d4c3b2a19081726354";

// Objects in the field order of the TS type declarations; unknown fields sit inside the open
// maps (extra, payload, extensions), where the Java typed model keeps them.
const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "cardano:preprod",
  asset: USDM_PREPROD,
  amount: "10000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: {
    assetTransferMethod: "default",
    areFeesSponsored: false,
    confirmationPolicy: { l1Confirmations: 1 },
    futureExtra: { nested: [1, "x", null, true] },
  },
};

const paymentPayload: PaymentPayload = {
  x402Version: 2,
  resource: {
    url: "https://api.example.com/weather",
    description: "Weather API",
    mimeType: "application/json",
  },
  accepted: requirements,
  payload: { transaction: "84a400d90102818258200000", futurePayloadField: { a: 1 } },
  extensions: { vendorExtension: { info: { k: "v" }, list: [2, 3] } },
};

type Served = { status: number; body: string };
type Operation = "verify" | "settle" | "supported";
type Case = { name: string; operation: Operation; served: Served; note?: string };

const json = (value: unknown): string => JSON.stringify(value);

const cases: Case[] = [
  {
    name: "verify-valid",
    operation: "verify",
    served: { status: 200, body: json({ isValid: true, payer: PAYER }) },
  },
  {
    name: "verify-invalid",
    operation: "verify",
    note: "an invalid payment is 200 with isValid:false",
    served: {
      status: 200,
      body: json({ isValid: false, invalidReason: "insufficient_funds", payer: PAYER }),
    },
  },
  {
    name: "verify-hook-abort",
    operation: "verify",
    note: "a before-verify abort is 200 isValid:false with the reason",
    served: { status: 200, body: json({ isValid: false, invalidReason: "payee_not_allowed" }) },
  },
  {
    name: "verify-error",
    operation: "verify",
    served: { status: 500, body: json({ error: "boom" }) },
  },
  {
    name: "verify-missing-field",
    operation: "verify",
    note: "the TS client always sends all three fields; this records how it reports a 400",
    served: {
      status: 400,
      body: json({ error: "Missing x402Version, paymentPayload or paymentRequirements" }),
    },
  },
  {
    name: "settle-success",
    operation: "settle",
    served: {
      status: 200,
      body: json({ success: true, payer: PAYER, transaction: TX, network: "cardano:preprod" }),
    },
  },
  {
    name: "settle-abort",
    operation: "settle",
    note: "Java wire shape for SettleAbortedException; passes TS settleResponseSchema",
    served: {
      status: 200,
      body: json({
        success: false,
        errorReason: "payee_not_allowed",
        transaction: "",
        network: "cardano:preprod",
      }),
    },
  },
  {
    name: "settle-abort-ts-e2e-shape",
    operation: "settle",
    note: "the TS e2e abort body (e2e/facilitators/typescript/index.ts); TS settleResponseSchema rejects it",
    served: {
      status: 200,
      body: json({ success: false, errorReason: "payee_not_allowed", network: "unknown" }),
    },
  },
  {
    name: "settle-error",
    operation: "settle",
    served: { status: 500, body: json({ error: "boom" }) },
  },
  {
    name: "supported",
    operation: "supported",
    served: {
      status: 200,
      body: json({
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "cardano:preprod",
            extra: { areFeesSponsored: false },
          },
        ],
        extensions: [],
        signers: { "cardano:*": ["addr_signer"] },
      }),
    },
  },
  {
    name: "supported-error",
    operation: "supported",
    served: { status: 500, body: json({ error: "boom" }) },
  },
];

type Captured = { method: string; path: string; contentType: string | null; body: string | null };

let current: Served | undefined;
let captured: Captured | undefined;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    captured = {
      method: req.method ?? "",
      path: req.url ?? "",
      contentType: (req.headers["content-type"] as string | undefined) ?? null,
      body: text.length === 0 ? null : text,
    };
    const served = current ?? { status: 599, body: "{}" };
    res.writeHead(served.status, { "Content-Type": "application/json" });
    res.end(served.body);
  });
});

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
// Trailing slashes are stripped by the TS client; the base path survives.
const client = new HTTPFacilitatorClient({ url: `http://127.0.0.1:${port}/x402/` });

const out: unknown[] = [];
for (const c of cases) {
  current = c.served;
  captured = undefined;
  let tsOutcome: unknown;
  try {
    const result =
      c.operation === "verify"
        ? await client.verify(paymentPayload, requirements)
        : c.operation === "settle"
          ? await client.settle(paymentPayload, requirements)
          : await client.getSupported();
    tsOutcome = { result: JSON.parse(JSON.stringify(result)) };
  } catch (error) {
    const e = error as Error;
    tsOutcome = { error: { name: e.constructor.name, message: e.message } };
  }
  out.push({
    name: c.name,
    operation: c.operation,
    ...(c.note ? { note: c.note } : {}),
    request: captured,
    response: c.served,
    tsOutcome,
  });
}
server.close();

const doc = {
  generatedFrom: "typescript/packages/core/src/http/httpFacilitatorClient.ts",
  responsesFrom: "the TS e2e facilitator handlers (e2e/facilitators/typescript/index.ts)",
  tsCommit,
  basePath: "/x402",
  cases: out,
};
writeFileSync(join(outDir, "http-facilitator-client.json"), JSON.stringify(doc, null, 2) + "\n");
console.log("wrote facilitator/http-facilitator-client.json");
