/**
 * Live Starknet settlement check. Skipped unless a funded payer account, a
 * funded facilitator account, and a payTo address are provided, so it is inert
 * in CI and runs only when explicitly configured.
 *
 * It drives the reference client, resource server, and facilitator end to end
 * against a real network: the facilitator advertises its `extra.feePayer`, the
 * resource server copies it into the requirements, the payer signs a SNIP-9 v2
 * OutsideExecution bound to that caller, and the facilitator account submits
 * `execute_from_outside_v2` and pays the fee. The payer needs NO gas, only a
 * token balance. The payTo balance must increase by exactly the requested
 * atomic units.
 *
 * Run (Sepolia):
 *   STARKNET_PAYER_ADDRESS=0x... STARKNET_PAYER_PRIVATE_KEY=0x... \
 *   STARKNET_FACILITATOR_ADDRESS=0x... STARKNET_FACILITATOR_PRIVATE_KEY=0x... \
 *   STARKNET_LIVE_PAYTO=0x... pnpm test:integration
 *
 * Both accounts must already be deployed - a Starknet account is a contract,
 * so a counterfactual address cannot sign or execute.
 *
 * Configure it with STARKNET_PAYER_ADDRESS / STARKNET_PAYER_PRIVATE_KEY,
 * STARKNET_FACILITATOR_ADDRESS / STARKNET_FACILITATOR_PRIVATE_KEY,
 * STARKNET_LIVE_PAYTO, STARKNET_LIVE_NETWORK, and optionally STARKNET_LIVE_ASSET /
 * STARKNET_LIVE_AMOUNT (default: Sepolia USDC, 0.001). The e2e wallet names
 * (CLIENT_STARKNET_*, FACILITATOR_STARKNET_*, SERVER_STARKNET_ADDRESS,
 * STARKNET_NETWORK) are accepted as fallbacks, so an existing e2e/.env works
 * unchanged. STARKNET_RPC_URL overrides the public endpoint.
 */
import { describe, expect, it } from "vitest";
import { Account } from "starknet";
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
import { STARKNET_SEPOLIA_CAIP2, USDC_SEPOLIA } from "../../src/constants";
import { ExactStarknetScheme as ExactStarknetClient } from "../../src/exact/client";
import { ExactStarknetScheme as ExactStarknetFacilitator } from "../../src/exact/facilitator";
import { ExactStarknetScheme as ExactStarknetServer } from "../../src/exact/server";
import {
  createStarknetProvider,
  toFacilitatorStarknetSigner,
  toClientStarknetSigner,
} from "../../src/signer";
import { feltEquals, parseU256 } from "../../src/utils";

const payerAddress = process.env.STARKNET_PAYER_ADDRESS ?? process.env.CLIENT_STARKNET_ADDRESS;
const payerKey = process.env.STARKNET_PAYER_PRIVATE_KEY ?? process.env.CLIENT_STARKNET_PRIVATE_KEY;
const feePayerAddress =
  process.env.STARKNET_FACILITATOR_ADDRESS ?? process.env.FACILITATOR_STARKNET_ADDRESS;
const feePayerKey =
  process.env.STARKNET_FACILITATOR_PRIVATE_KEY ?? process.env.FACILITATOR_STARKNET_PRIVATE_KEY;
const payTo = process.env.STARKNET_LIVE_PAYTO ?? process.env.SERVER_STARKNET_ADDRESS;

const HAS_ACCOUNTS = Boolean(payerAddress && payerKey && feePayerAddress && feePayerKey && payTo);
const describeLive = HAS_ACCOUNTS ? describe : describe.skip;

if (!HAS_ACCOUNTS) {
  console.warn(
    "[exact-starknet.live] skipped: set STARKNET_PAYER_ADDRESS/_PRIVATE_KEY (or CLIENT_STARKNET_*), STARKNET_FACILITATOR_ADDRESS/_PRIVATE_KEY (or FACILITATOR_STARKNET_*), and STARKNET_LIVE_PAYTO (or SERVER_STARKNET_ADDRESS) to run.",
  );
}

// Circle USDC on Starknet Sepolia (6 decimals); override for other tokens/networks.
const network = (process.env.STARKNET_LIVE_NETWORK ??
  process.env.STARKNET_NETWORK ??
  STARKNET_SEPOLIA_CAIP2) as Network;
const asset = process.env.STARKNET_LIVE_ASSET ?? process.env.SERVER_STARKNET_ASSET ?? USDC_SEPOLIA;
const amount = process.env.STARKNET_LIVE_AMOUNT ?? process.env.SERVER_STARKNET_AMOUNT ?? "1000"; // 0.001 USDC
const rpcUrl = process.env.STARKNET_RPC_URL;

/**
 * In-process facilitator client that adapts the reference facilitator for the
 * resource server used in this live test.
 */
class StarknetFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = network;
  readonly x402Version = 2;

  /**
   * Creates the adapter around a configured x402 facilitator.
   *
   * @param facilitator - Facilitator with the Starknet exact scheme registered
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verifies a payment payload through the wrapped facilitator.
   *
   * @param paymentPayload - x402 payment payload
   * @param paymentRequirements - Payment requirements
   * @returns Verification response
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settles a payment payload through the wrapped facilitator.
   *
   * @param paymentPayload - x402 payment payload
   * @param paymentRequirements - Payment requirements
   * @returns Settlement response
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * Reports the wrapped facilitator's supported kinds.
   *
   * @returns Supported response
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported() as SupportedResponse);
  }
}

/**
 * Reads a SNIP-2 token balance in atomic units at the latest confirmed block.
 *
 * @param account - The holder's account contract address
 * @returns Balance in the token's smallest unit
 */
async function getTokenBalance(account: string): Promise<bigint> {
  const provider = createStarknetProvider(network, rpcUrl);
  const balance = parseU256(
    await provider.callContract({
      contractAddress: asset,
      entrypoint: "balanceOf",
      calldata: [account],
    }),
  );
  if (balance === null) throw new Error(`unreadable balance response for ${account}`);
  return balance;
}

describeLive("Starknet exact live settlement", () => {
  it("settles a real payer-signed OutsideExecution and delivers the exact amount", async () => {
    const provider = createStarknetProvider(network, rpcUrl);
    const payerAccount = new Account({ provider, address: payerAddress!, signer: payerKey! });
    const feePayerAccount = new Account({
      provider,
      address: feePayerAddress!,
      signer: feePayerKey!,
    });

    const client = new x402Client().register(
      network,
      new ExactStarknetClient(toClientStarknetSigner(payerAccount)),
    );
    const facilitator = new x402Facilitator().register(
      network,
      new ExactStarknetFacilitator(toFacilitatorStarknetSigner(feePayerAccount), { rpcUrl }),
    );
    const server = new x402ResourceServer(new StarknetFacilitatorClient(facilitator));
    server.register(network, new ExactStarknetServer());
    await server.initialize();

    const before = await getTokenBalance(payTo!);

    // The facilitator advertises the feePayer through /supported; the resource
    // server copies it verbatim into the requirements it serves.
    const accepts = await server.buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo: payTo!,
      price: { amount, asset },
      maxTimeoutSeconds: 300,
    });
    expect(accepts).toHaveLength(1);
    expect(feltEquals(accepts[0].extra?.feePayer as string, feePayerAccount.address)).toBe(true);

    const resource = {
      url: "https://example.com/weather",
      description: "Weather data",
      mimeType: "application/json",
    };

    const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);
    const paymentPayload = await client.createPaymentPayload(paymentRequired);

    const accepted = server.findMatchingRequirements(paymentRequired.accepts, paymentPayload);
    expect(accepted).toBeDefined();

    const verify = await server.verifyPayment(paymentPayload, accepted!);
    expect(verify.invalidReason).toBeUndefined();
    expect(verify.isValid).toBe(true);
    expect(feltEquals(verify.payer!, payerAccount.address)).toBe(true);

    const settle = await server.settlePayment(paymentPayload, accepted!);
    expect(settle.errorReason).toBeUndefined();
    expect(settle.success).toBe(true);
    expect(settle.transaction).toMatch(/^0x[0-9a-fA-F]{1,64}$/);

    const after = await getTokenBalance(payTo!);
    expect(after - before).toBe(BigInt(amount));

    console.log(
      `[exact-starknet.live] settled ${amount} on ${network}; tx=${settle.transaction}; payTo ${before} -> ${after}`,
    );
  }, 300_000);
});
