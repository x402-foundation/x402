/**
 * Live testnet integration for the Hedera batch-settlement scheme (env-gated).
 *
 * Required env (see scripts/create-test-accounts.ts output + operator credentials):
 *   HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY        facilitator fee payer
 *   AUTHORIZER_ACCOUNT_ID / AUTHORIZER_PRIVATE_KEY   receiver authorizer (ECDSA or ED25519)
 *   SERVER_ACCOUNT_ID                                receiver (associated with USDC)
 *   CLIENT_<TYPE>_ACCOUNT_ID / _PRIVATE_KEY          payer; TYPE from HEDERA_CLIENT_KEY_TYPE (ECDSA|ED25519)
 * The payer must hold testnet USDC (0.0.429274) and be associated with it.
 */
import { describe, expect, it } from "vitest";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  HTTPAdapter,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
} from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { decodePaymentResponseHeader } from "@x402/core/http";
import {
  computeChannelId,
  createClientHederaBatchSigner,
  createFacilitatorHederaBatchSigner,
  createHederaAuthorizerSigner,
  createHederaMirrorNodeClient,
  getBatchSettlementDeployment,
  parseHederaPrivateKey,
  batchSettlementABI,
} from "../../src/batch-settlement";
import { BatchSettlementHederaScheme as ClientScheme } from "../../src/batch-settlement/client/scheme";
import { ensureHtsAllowance } from "../../src/batch-settlement/client/allowance";
import { BatchSettlementHederaScheme as ServerScheme } from "../../src/batch-settlement/server/scheme";
import { BatchSettlementHederaScheme as FacilitatorScheme } from "../../src/batch-settlement/facilitator/scheme";
import { HEDERA_TESTNET_USDC } from "../../src/constants";
import { fetchJson, mirrorNodeUrlForNetwork } from "../../src/preflight";

const network = "hedera:testnet" as Network;
const clientType = (process.env.HEDERA_CLIENT_KEY_TYPE ?? "ECDSA").toUpperCase();
const env = {
  operatorId: process.env.HEDERA_OPERATOR_ID,
  operatorKey: process.env.HEDERA_OPERATOR_KEY,
  authorizerId: process.env.AUTHORIZER_ACCOUNT_ID,
  authorizerKey: process.env.AUTHORIZER_PRIVATE_KEY,
  serverId: process.env.SERVER_ACCOUNT_ID,
  clientId: process.env[`CLIENT_${clientType}_ACCOUNT_ID`],
  clientKey: process.env[`CLIENT_${clientType}_PRIVATE_KEY`],
};
const hasLiveEnv = Object.values(env).every(v => typeof v === "string" && v.length > 0);

class InProcessFacilitatorClient implements FacilitatorClient {
  constructor(private readonly facilitator: x402Facilitator) {}
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(p, r);
  }
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(p, r);
  }
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

/**
 * Reads an account's USDC balance from the Mirror Node.
 *
 * @param accountId - Account id.
 * @returns Balance in base units.
 */
async function usdcBalance(accountId: string): Promise<bigint> {
  const page = await fetchJson<{ tokens: { balance: number }[] }>(
    `${mirrorNodeUrlForNetwork(network)}/api/v1/accounts/${accountId}/tokens?token.id=${HEDERA_TESTNET_USDC}`,
  );
  return BigInt(page.tokens[0]?.balance ?? 0);
}

/**
 * Polls the Mirror Node until `read()` satisfies `predicate` or the timeout elapses.
 *
 * @param read - Reader.
 * @param predicate - Condition.
 * @param timeoutMs - Max wait.
 * @returns The last read value.
 */
async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    value = await read();
  }
  return value;
}

describe.skipIf(!hasLiveEnv)("Hedera batch-settlement live integration", () => {
  it(`deposits, vouchers, claims, settles and refunds with a ${clientType} payer`, async () => {
    const mirror = createHederaMirrorNodeClient({ network });
    const deployment = getBatchSettlementDeployment(network);

    // --- roles -------------------------------------------------------------
    const facilitatorSigner = createFacilitatorHederaBatchSigner({
      accountId: env.operatorId!,
      privateKey: parseHederaPrivateKey(env.operatorKey!),
      network,
    });
    const authorizer = await createHederaAuthorizerSigner(
      env.authorizerId!,
      parseHederaPrivateKey(env.authorizerKey!),
      { network },
    );
    const facilitator = new x402Facilitator().register(
      network,
      new FacilitatorScheme(facilitatorSigner, authorizer),
    );
    const facilitatorClient = new InProcessFacilitatorClient(facilitator);

    const serverScheme = new ServerScheme(env.serverId!, {
      receiverAuthorizerSigner: authorizer,
      withdrawDelay: 900,
    });
    const resourceServer = new x402ResourceServer(facilitatorClient).register(
      network,
      serverScheme,
    );
    await resourceServer.initialize();
    const routes = {
      "/api/weather": {
        accepts: { scheme: "batch-settlement", payTo: env.serverId!, price: "$0.01", network },
        description: "Weather",
        mimeType: "application/json",
      },
    };
    const httpServer = new x402HTTPResourceServer(resourceServer, routes);
    const manager = serverScheme.createChannelManager(facilitatorClient, network);

    const clientKey = parseHederaPrivateKey(
      env.clientKey!,
      clientType === "ED25519" ? "ED25519" : "ECDSA_SECP256K1",
    );
    const clientSigner = await createClientHederaBatchSigner(env.clientId!, clientKey, { network });
    const clientScheme = new ClientScheme(clientSigner, {
      depositPolicy: { depositMultiplier: 5 },
      salt: `0x${Date.now().toString(16).padStart(64, "0")}` as `0x${string}`, // fresh channel per run
    });
    const paymentClient = new x402Client().register("hedera:*", clientScheme);
    const httpClient = new x402HTTPClient(paymentClient);

    // --- preconditions -----------------------------------------------------
    const balance = await usdcBalance(env.clientId!);
    expect(balance, `payer ${env.clientId} needs testnet USDC`).toBeGreaterThanOrEqual(100_000n);
    await ensureHtsAllowance({
      network,
      ownerAccountId: env.clientId!,
      ownerPrivateKey: clientKey,
      tokenId: HEDERA_TESTNET_USDC,
      required: 1_000_000n,
    });

    // --- in-process HTTP helpers ------------------------------------------
    let signatureHeader: string | undefined;
    const adapter: HTTPAdapter = {
      getHeader: name => (name === "PAYMENT-SIGNATURE" ? signatureHeader : undefined),
      getMethod: () => "GET",
      getPath: () => "/api/weather",
      getUrl: () => "https://example.test/api/weather",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "IntegrationTest/1.0",
    };
    const context = { adapter, path: "/api/weather", method: "GET" };

    /**
     * Performs one paid request end to end (402 → payload → verify → settle).
     *
     * @param chargedPercent - Optional dynamic-price override (percentage string).
     * @returns The settle response decoded from PAYMENT-RESPONSE.
     */
    async function paidRequest(chargedPercent?: string): Promise<SettleResponse> {
      signatureHeader = undefined;
      const first = await httpServer.processHTTPRequest(context);
      expect(first.type).toBe("payment-error");
      const response = (
        first as { response: { status: number; headers: Record<string, string>; body: string } }
      ).response;
      expect(response.status).toBe(402);
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        name => response.headers[name],
        response.body,
      );
      const payload = await httpClient.createPaymentPayload(paymentRequired);
      signatureHeader = (await httpClient.encodePaymentSignatureHeader(payload))[
        "PAYMENT-SIGNATURE"
      ];
      const second = await httpServer.processHTTPRequest(context);
      expect(second.type, JSON.stringify(second)).toBe("payment-verified");
      const verified = second as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      const settled = await httpServer.processSettlement(
        verified.paymentPayload,
        verified.paymentRequirements,
        undefined,
        undefined,
        chargedPercent ? { amount: chargedPercent } : undefined,
      );
      expect(settled.success, JSON.stringify(settled)).toBe(true);
      const header = (settled as { headers: Record<string, string> }).headers["PAYMENT-RESPONSE"];
      const decoded = decodePaymentResponseHeader(header);
      await httpClient.processPaymentResult(
        payload,
        name => (name === "PAYMENT-RESPONSE" ? header : null),
        200,
      );
      return decoded;
    }

    // --- 1. first request: deposit + voucher --------------------------------
    const deposit = await paidRequest("50%");
    expect(deposit.success).toBe(true);
    expect(deposit.transaction).toMatch(/^0\.0\.\d+@/);
    const channelState = deposit.extra?.channelState as {
      channelId: `0x${string}`;
      balance: string;
    };
    expect(BigInt(channelState.balance)).toBeGreaterThan(0n);
    console.log("deposit tx", deposit.transaction, "channel", channelState.channelId);

    // channel id parity with the contract
    const config = clientScheme.buildChannelConfig({
      scheme: "batch-settlement",
      network,
      amount: "10000",
      asset: HEDERA_TESTNET_USDC,
      payTo: env.serverId!,
      maxTimeoutSeconds: 60,
      extra: { receiverAuthorizer: authorizer.address, withdrawDelay: 900 },
    });
    const onchainId = await facilitatorSigner.readContract({
      address: deployment.settlement,
      abi: batchSettlementABI,
      functionName: "getChannelId",
      args: [config],
    });
    expect(String(onchainId).toLowerCase()).toBe(computeChannelId(config, network).toLowerCase());

    // --- 2. voucher-only requests (no onchain tx) ---------------------------
    for (let i = 0; i < 2; i++) {
      const voucher = await paidRequest();
      expect(voucher.transaction).toBe("");
      expect(voucher.extra?.chargedAmount).toBe("10000");
    }

    // --- 3. claim + settle --------------------------------------------------
    const receiverBefore = await usdcBalance(env.serverId!);
    const claims = await manager.claimAndSettle({ maxClaimsPerBatch: 25 });
    expect(claims.claims.length).toBeGreaterThan(0);
    console.log("claim tx", claims.claims[0].transaction, "settle tx", claims.settle?.transaction);
    const receiverAfter = await waitFor(
      () => usdcBalance(env.serverId!),
      v => v > receiverBefore,
    );
    // settle sweeps every claimed-but-unsettled channel of this receiver, so the delta is at least this run's claims
    expect(receiverAfter - receiverBefore).toBeGreaterThanOrEqual(5000n + 10000n + 10000n);

    // --- 4. cooperative refund of the remainder -----------------------------
    const payerBefore = await usdcBalance(env.clientId!);
    const refunds = await manager.refund([channelState.channelId]);
    expect(refunds.length).toBe(1);
    console.log("refund tx", refunds[0].transaction);
    const payerAfter = await waitFor(
      () => usdcBalance(env.clientId!),
      v => v > payerBefore,
    );
    expect(payerAfter).toBeGreaterThan(payerBefore);
    await expect(
      mirror.getTokenAllowance(env.clientId!, deployment.collectorId, HEDERA_TESTNET_USDC),
    ).resolves.toBeGreaterThanOrEqual(0n);
  }, 300_000);
});
