import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { convertToTokenAmount } from "@x402/core/utils";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, stopTestServer } from "./server";

/** USDC on Base Sepolia and Solana devnet. */
const USDC_DECIMALS = 6;
/** Exact subroutes advertise and settle this amount ($0.001 USDC). */
const EXACT_AMOUNT = convertToTokenAmount("0.001", USDC_DECIMALS);
/** Upto subroutes authorize this amount ($0.002 USDC) and settle half of it. */
const UPTO_AUTHORIZED_AMOUNT = convertToTokenAmount("0.002", USDC_DECIMALS);
/** `GET /protected` keeps its original price. Subroutes under `/protected/*` do not. */
const PROTECTED_AMOUNT = convertToTokenAmount("0.01", USDC_DECIMALS);

if (BigInt(UPTO_AUTHORIZED_AMOUNT) !== BigInt(EXACT_AMOUNT) * 2n) {
  throw new Error("upto authorization must be exactly twice the exact settlement amount");
}

/**
 * End-to-end tests for the testnet `/protected/{evm,svm}/{exact,upto}...` endpoints
 * added under `typescript/site`: each test pays for a route using the real x402
 * client SDKs (`@x402/fetch` plus the EVM/SVM `exact`/`upto` client schemes) against
 * the site's own Next.js server — exercising the full client -> route handler ->
 * facilitator -> onchain settle path end to end, not mocked.
 *
 * Requires testnet-funded wallets:
 * - `CLIENT_EVM_PRIVATE_KEY`: needs Base Sepolia ETH (gas) and USDC, and must already
 *   have approved the canonical Permit2 contract to spend that USDC — the
 *   `/exact/permit2` and `/upto/permit2` (no-extension) routes require pre-approval
 *   and do not offer gasless approval themselves.
 * - `CLIENT_SVM_PRIVATE_KEY`: needs Solana devnet SOL (fees/rent) and devnet USDC.
 *   Must be a *different* key from the testnet facilitator's own SVM signer — the
 *   exact SVM scheme rejects a payment where the fee payer and the payer are the
 *   same account.
 * - `CLIENT_EVM_RPC_URL`: optional; defaults to the public Base Sepolia RPC. Enables
 *   the gasless EIP-2612 permit path the `/permit2/eip2612` routes are meant to
 *   exercise; without it those routes fall back to the plain Permit2 flow (same as
 *   the no-extension routes), same as any real client lacking RPC read access would.
 *
 * Each test pays a small (testnet) amount, so repeated runs will drain these wallets
 * over time — same caveat as `e2e/README.md`'s "Wallet Safety Warning". Not run as
 * part of the default `pnpm test`; run explicitly with `pnpm test:e2e`.
 */

const EVM_PRIVATE_KEY = process.env.CLIENT_EVM_PRIVATE_KEY as `0x${string}` | undefined;
const SVM_PRIVATE_KEY = process.env.CLIENT_SVM_PRIVATE_KEY;
const EVM_RPC_URL = process.env.CLIENT_EVM_RPC_URL ?? "https://sepolia.base.org";

if (!EVM_PRIVATE_KEY || !SVM_PRIVATE_KEY) {
  throw new Error(
    "CLIENT_EVM_PRIVATE_KEY and CLIENT_SVM_PRIVATE_KEY environment variables are required " +
      "for these testnet e2e tests. See this file's header comment for requirements.",
  );
}

let baseUrl: string;
let fetchWithPayment: typeof fetch;
let httpClient: x402HTTPClient;

beforeAll(async () => {
  baseUrl = await startTestServer();

  const evmSigner = privateKeyToAccount(EVM_PRIVATE_KEY);
  const svmSigner = await createKeyPairSignerFromBytes(base58.decode(SVM_PRIVATE_KEY));

  const client = new x402Client();
  client.setSpendControls({ maxAmountPerPayment: "$1" });
  client.register("eip155:*", new ExactEvmScheme(evmSigner, { rpcUrl: EVM_RPC_URL }));
  client.register("eip155:*", new UptoEvmScheme(evmSigner, { rpcUrl: EVM_RPC_URL }));
  client.register("solana:*", new ExactSvmScheme(svmSigner));

  fetchWithPayment = wrapFetchWithPayment(fetch, client);
  httpClient = new x402HTTPClient(client);
});

afterAll(async () => {
  await stopTestServer();
});

/**
 * Pays for and fetches a protected route, asserting the payment actually settled.
 *
 * @param path - Route path (e.g. `/protected/evm/exact`)
 * @returns The parsed response body and decoded settlement header
 */
async function payAndFetch(path: string) {
  const response = await fetchWithPayment(`${baseUrl}${path}`);
  const result = await httpClient.processResponse(response);
  expect(result.status, `${path} did not return 200: ${JSON.stringify(result.body)}`).toBe(200);
  expect(result.paymentStatus).toBe("settled");
  return result;
}

/**
 * Asserts a settled response's actual on-chain settlement amount — relevant for the
 * `upto` scheme, where it can differ from the authorized maximum. Exact settlements
 * omit `amount` and transfer the full advertised figure instead.
 *
 * @param header - The decoded payment header from `x402HTTPClient.processResponse`
 * @param expectedAmount - Expected settled amount, in atomic token units
 */
function expectSettledAmount(header: unknown, expectedAmount: string): void {
  expect(header).toMatchObject({ success: true, amount: expectedAmount });
}

/**
 * Asserts an unpaid request advertises `expectedAmount` on every accept option.
 * Exact routes settle this figure in full; `upto` routes authorize it and may settle less.
 *
 * @param path - Route path (e.g. `/protected/evm/exact`)
 * @param expectedAmount - Expected advertised amount, in atomic token units
 */
async function expectAdvertisedAmount(path: string, expectedAmount: string): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`);
  expect(response.status, `${path} unpaid status`).toBe(402);
  const encoded = response.headers.get("PAYMENT-REQUIRED");
  expect(encoded, `${path} missing PAYMENT-REQUIRED`).toBeTruthy();
  const required = decodePaymentRequiredHeader(encoded!);
  expect(required.accepts.length, `${path} has no accept options`).toBeGreaterThan(0);
  for (const accept of required.accepts) {
    expect(accept.amount, `${path} ${accept.scheme} on ${accept.network}`).toBe(expectedAmount);
  }
}

describe("unpaid request", () => {
  it("GET /protected still advertises $0.01", async () => {
    await expectAdvertisedAmount("/protected", PROTECTED_AMOUNT);
  });

  it("returns the advice JSON body, not the paywall, on 402", async () => {
    const response = await fetch(`${baseUrl}/protected/evm/exact`);
    expect(response.status).toBe(402);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body).toHaveProperty("advice");
    expect(typeof body.advice).toBe("string");
  });
});

describe("EVM exact", () => {
  it("GET /protected/evm/exact settles $0.001 (erc3009 or permit2)", async () => {
    await expectAdvertisedAmount("/protected/evm/exact", EXACT_AMOUNT);
    const { body } = await payAndFetch("/protected/evm/exact");
    expect(body).toMatchObject({ ok: true, caip2Family: "evm", scheme: "exact" });
  });

  it("GET /protected/evm/exact/erc3009 settles $0.001", async () => {
    await expectAdvertisedAmount("/protected/evm/exact/erc3009", EXACT_AMOUNT);
    const { body } = await payAndFetch("/protected/evm/exact/erc3009");
    expect(body).toMatchObject({
      ok: true,
      caip2Family: "evm",
      scheme: "exact",
      assetTransferMethod: "erc3009",
    });
  });

  it("GET /protected/evm/exact/permit2 settles $0.001 (requires pre-approved Permit2 allowance)", async () => {
    await expectAdvertisedAmount("/protected/evm/exact/permit2", EXACT_AMOUNT);
    const { body } = await payAndFetch("/protected/evm/exact/permit2");
    expect(body).toMatchObject({
      ok: true,
      caip2Family: "evm",
      scheme: "exact",
      assetTransferMethod: "permit2",
    });
  });

  it("GET /protected/evm/exact/permit2/eip2612 settles $0.001", async () => {
    await expectAdvertisedAmount("/protected/evm/exact/permit2/eip2612", EXACT_AMOUNT);
    const { body } = await payAndFetch("/protected/evm/exact/permit2/eip2612");
    expect(body).toMatchObject({
      ok: true,
      caip2Family: "evm",
      scheme: "exact",
      assetTransferMethod: "permit2",
      extension: "eip2612GasSponsoring",
    });
  });
});

describe("EVM upto", () => {
  it("GET /protected/evm/upto authorizes $0.002 and settles $0.001", async () => {
    await expectAdvertisedAmount("/protected/evm/upto", UPTO_AUTHORIZED_AMOUNT);
    const { body, header } = await payAndFetch("/protected/evm/upto");
    expect(body).toMatchObject({
      ok: true,
      caip2Family: "evm",
      scheme: "upto",
      settledPercentOfAuthorized: "50%",
    });
    expectSettledAmount(header, EXACT_AMOUNT);
  });

  it("GET /protected/evm/upto/permit2 authorizes $0.002 and settles $0.001", async () => {
    await expectAdvertisedAmount("/protected/evm/upto/permit2", UPTO_AUTHORIZED_AMOUNT);
    const { body, header } = await payAndFetch("/protected/evm/upto/permit2");
    expect(body).toMatchObject({
      ok: true,
      caip2Family: "evm",
      scheme: "upto",
      settledPercentOfAuthorized: "50%",
    });
    expectSettledAmount(header, EXACT_AMOUNT);
  });

  it("GET /protected/evm/upto/permit2/eip2612 authorizes $0.002 and settles $0.001", async () => {
    await expectAdvertisedAmount("/protected/evm/upto/permit2/eip2612", UPTO_AUTHORIZED_AMOUNT);
    const { body, header } = await payAndFetch("/protected/evm/upto/permit2/eip2612");
    expect(body).toMatchObject({
      ok: true,
      caip2Family: "evm",
      scheme: "upto",
      settledPercentOfAuthorized: "50%",
    });
    expectSettledAmount(header, EXACT_AMOUNT);
  });
});

describe("SVM exact", () => {
  it("GET /protected/svm/exact settles $0.001", async () => {
    await expectAdvertisedAmount("/protected/svm/exact", EXACT_AMOUNT);
    const { body } = await payAndFetch("/protected/svm/exact");
    expect(body).toMatchObject({ ok: true, caip2Family: "svm", scheme: "exact" });
  });
});
