/**
 * Real-node MCP flow on regtest: an MCP SDK server with a tool wrapped by
 * `@x402/mcp`, paid through `x402MCPClient` over an in-memory transport, with
 * LND paying (alice) and receiving (bob). Skips without the regtest env.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { type FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { createPaymentWrapper, x402MCPClient } from "@x402/mcp";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryReplayStore, mcpToolCallBinding } from "../../src";
import { ExactLnbtcScheme as LnbtcClient } from "../../src/exact/client";
import { ExactLnbtcScheme as LnbtcFacilitator } from "../../src/exact/facilitator";
import { ExactLnbtcScheme as LnbtcServer, mcpTransportBinding } from "../../src/exact/server";
import { lndNode, lndPayer, lndReceiver, lookupInvoice, type LndNode } from "./lnd";

const REGTEST: Network = "lnbtc:0f9188f13cb7b2c71f2a335e3a4fc328";
const NETWORKS = { [REGTEST]: "bcrt" };
const MCP_SERVER = "https://api.example.com/mcp";

const envFile = join(__dirname, "../regtest/.data/env");
const fileEnv: Record<string, string> = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .filter(line => line.includes("="))
        .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    )
  : {};
const env = (name: string) => process.env[name] ?? fileEnv[name];
const missing = !env("LNBTC_REGTEST_RECEIVER_REST") || !env("LNBTC_REGTEST_PAYER_REST");

const local = (facilitator: x402Facilitator): FacilitatorClient => ({
  verify: (p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> =>
    facilitator.verify(p, r),
  settle: (p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> =>
    facilitator.settle(p, r),
  getSupported: (): Promise<SupportedResponse> =>
    Promise.resolve(facilitator.getSupported() as SupportedResponse),
});

describe.skipIf(missing)("exact lnbtc over MCP on regtest LND", () => {
  let payer: LndNode;
  let receiver: LndNode;
  let client: x402MCPClient;
  // The tool call the client intends to pay for; set before each call.
  let intended: { name: string; arguments: Record<string, unknown> };
  const handled: string[] = [];

  beforeAll(async () => {
    payer = lndNode(
      env("LNBTC_REGTEST_PAYER_REST")!,
      env("LNBTC_REGTEST_PAYER_MACAROON")!,
      env("LNBTC_REGTEST_PAYER_TLS_CERT")!,
    );
    receiver = lndNode(
      env("LNBTC_REGTEST_RECEIVER_REST")!,
      env("LNBTC_REGTEST_RECEIVER_MACAROON")!,
      env("LNBTC_REGTEST_RECEIVER_TLS_CERT")!,
    );

    const facilitator = new x402Facilitator().register(
      REGTEST,
      new LnbtcFacilitator({ replayStore: new InMemoryReplayStore(), networks: NETWORKS }),
    );
    const resourceServer = new x402ResourceServer(local(facilitator));
    resourceServer.register(
      REGTEST,
      new LnbtcServer({
        receiver: lndReceiver(receiver),
        requestBinding: mcpTransportBinding({ server: MCP_SERVER }),
        networks: NETWORKS,
      }),
    );
    await resourceServer.initialize();

    const accepts = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: REGTEST,
      payTo: env("LNBTC_REGTEST_RECEIVER_PUBKEY")!,
      price: "21 sats",
      maxTimeoutSeconds: 300,
    });
    const paid = createPaymentWrapper(resourceServer, {
      accepts,
      resource: { url: "mcp://tool/get_article" },
    });

    const mcpServer = new McpServer({ name: "lnbtc-test", version: "1.0.0" });
    mcpServer.tool(
      "get_article",
      "Returns an article. Requires payment.",
      { article: z.string() },
      paid(async ({ article }) => {
        handled.push(article);
        return { content: [{ type: "text" as const, text: `article ${article}` }] };
      }),
    );

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const mcpClient = new Client({ name: "lnbtc-test-client", version: "1.0.0" });
    await mcpClient.connect(clientTransport);

    const payment = new x402Client().setSpendControls(false).register(
      REGTEST,
      new LnbtcClient({
        payer: lndPayer(payer),
        networks: NETWORKS,
        requestBinding: () =>
          mcpToolCallBinding({ server: MCP_SERVER, ...intended, boundMetadata: [] }),
      }),
    );
    client = new x402MCPClient(mcpClient, payment);
  });

  it("pays a tool call with a request-bound invoice and settles before the handler", async () => {
    intended = { name: "get_article", arguments: { article: "A" } };
    const result = await client.callTool("get_article", { article: "A" });
    expect(result.content[0]).toEqual({ type: "text", text: "article A" });
    expect(handled).toEqual(["A"]);
    expect(result.paymentResponse?.success).toBe(true);
    const invoice = await lookupInvoice(receiver, result.paymentResponse!.transaction);
    expect(invoice).toEqual({ state: "SETTLED", amtPaidMsat: "21000" });
  });

  it("refuses to pay when the challenge is bound to a different tool call", async () => {
    intended = { name: "get_article", arguments: { article: "B" } };
    await expect(client.callTool("get_article", { article: "C" })).rejects.toThrow();
    expect(handled).toEqual(["A"]);
  });
});
