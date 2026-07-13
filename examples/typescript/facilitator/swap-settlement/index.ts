import { randomBytes } from "node:crypto";
import { x402Facilitator } from "@x402/core/facilitator";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import {
  CANONICAL_PERMIT2_ADDRESS,
  PERMIT2_SWAP_WITNESS_TYPES,
  SWAP_SETTLEMENT_KEY,
  computeQuoteIdHash,
  computeRequirementsHash,
  extractSwapSettlementInfo,
  swapSettlerABI,
  validateSwapSettlementInfo,
  type SwapSettlementPayloadInfo,
} from "@x402/extensions";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, encodeFunctionData, erc20Abi, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

dotenv.config();

/**
 * Minimal swap-settlement facilitator (specs/extensions/swap_settlement.md).
 *
 * Demonstrates the three facilitator responsibilities on top of a standard facilitator:
 * 1. Quote API - POST /x402/swap/quote issues short-lived, single-use quotes
 * 2. Verification - payloads carrying `extensions["swap-settlement"]` are validated
 *    against the quote (witness binding, balances) instead of the exact scheme
 * 3. Settlement - a single atomic transaction through the x402SwapSettler contract
 *
 * Kept intentionally minimal: only the `permit2` method, a fixed swap target, and
 * in-memory quotes. A production facilitator adds the other three methods (eip3009,
 * eip2612, allowance), a real routing provider (aggregator API) for route calldata and
 * pricing, re-simulation before settling, and idempotency across concurrent settles.
 *
 * Required environment variables:
 * - EVM_PRIVATE_KEY: facilitator sender (authorized on the settler via setFacilitator)
 * - SWAP_SETTLER_ADDRESS: deployed x402SwapSettler (contracts/evm/src/x402SwapSettler.sol)
 * - SWAP_TARGET_ADDRESS: whitelisted swap target the route calldata calls. For a local
 *   anvil-fork demo use the repo's MockSwapRouter (contracts/evm/test/mocks); production
 *   uses an aggregator entrypoint and provider-built calldata.
 */

const PORT = process.env.PORT || "4022";
const EVM_NETWORK = "eip155:8453";
const RPC_URL = process.env.RPC_URL;

// Curated input-asset allowlist (spec: facilitators MUST curate; no fee-on-transfer/rebase)
const INPUT_ASSETS = new Map<string, { symbol: string; decimals: number }>([
  ["0x4200000000000000000000000000000000000006", { symbol: "WETH", decimals: 18 }],
]);

const QUOTE_TTL_MS = 45_000;
const SLIPPAGE_BPS = 100n;
const FACILITATOR_FEE_BPS = 0n;

for (const name of ["EVM_PRIVATE_KEY", "SWAP_SETTLER_ADDRESS", "SWAP_TARGET_ADDRESS"]) {
  if (!process.env[name]) {
    console.error(`${name} environment variable is required`);
    process.exit(1);
  }
}
const SETTLER = process.env.SWAP_SETTLER_ADDRESS as `0x${string}`;
const SWAP_TARGET = process.env.SWAP_TARGET_ADDRESS as `0x${string}`;

const evmAccount = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
console.info(`Facilitator account: ${evmAccount.address}`);

const viemClient = createWalletClient({
  account: evmAccount,
  chain: base,
  transport: http(RPC_URL),
}).extend(publicActions);

// ── Standard facilitator: exact scheme + extension advertised in /supported ──────────────

const evmSigner = toFacilitatorEvmSigner({
  address: evmAccount.address,
  getCode: args => viemClient.getCode(args),
  readContract: args =>
    viemClient.readContract({ ...args, args: args.args ?? [] } as Parameters<
      typeof viemClient.readContract
    >[0]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifyTypedData: args => viemClient.verifyTypedData(args as any),
  writeContract: args =>
    viemClient.writeContract(args as Parameters<typeof viemClient.writeContract>[0]),
  sendTransaction: args => viemClient.sendTransaction(args),
  waitForTransactionReceipt: args => viemClient.waitForTransactionReceipt(args),
});

const facilitator = new x402Facilitator()
  .registerExtension({ key: SWAP_SETTLEMENT_KEY })
  .register(EVM_NETWORK, new ExactEvmScheme(evmSigner));

// ── Quote store: short-lived, single-use, in-memory ───────────────────────────────────────

interface StoredQuote {
  quoteId: string;
  quoteIdHash: `0x${string}`;
  requirementsHash: `0x${string}`;
  requirements: PaymentRequirements;
  payer: `0x${string}`;
  inputAsset: `0x${string}`;
  maxAmountIn: bigint;
  facilitatorFee: bigint;
  expiresAtMs: number;
  consumed: boolean;
}
const quotes = new Map<string, StoredQuote>();

/**
 * Prices an exact-output swap: how much input asset yields `buyAmount` of the output.
 *
 * STUB - replace with a real routing provider (aggregator API). It must also return the
 * route calldata; here the calldata is a fixed `swap(input, output)` call matching the
 * repo's MockSwapRouter, which makes the example runnable on an anvil fork.
 *
 * @param inputAsset - The asset the payer holds
 * @param outputAsset - The asset the requirements demand
 * @param buyAmount - Required output amount (exact-output)
 * @returns The estimated input spend and the route calldata for the swap target
 */
async function getRoute(
  inputAsset: `0x${string}`,
  outputAsset: `0x${string}`,
  buyAmount: bigint,
): Promise<{ sellAmount: bigint; callData: `0x${string}` }> {
  const rate = BigInt(process.env.FIXED_RATE_OUTPUT_PER_INPUT_UNIT ?? "1750000000"); // demo only
  const inputUnit = 10n ** BigInt(INPUT_ASSETS.get(inputAsset.toLowerCase())?.decimals ?? 18);
  const sellAmount = (buyAmount * inputUnit) / rate + 1n;
  const callData = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "swap",
        stateMutability: "nonpayable",
        inputs: [
          { name: "inputToken", type: "address" },
          { name: "outputToken", type: "address" },
        ],
        outputs: [],
      },
    ],
    functionName: "swap",
    args: [inputAsset, outputAsset],
  });
  return { sellAmount, callData };
}

const app = express();
app.use(express.json());

// ── Quote API (spec "Quote API") ──────────────────────────────────────────────────────────

app.post("/x402/swap/quote", async (req, res) => {
  try {
    const { paymentRequirements, payer, inputAsset } = req.body as {
      paymentRequirements: PaymentRequirements;
      payer: `0x${string}`;
      inputAsset: `0x${string}`;
    };
    const asset = INPUT_ASSETS.get(inputAsset?.toLowerCase?.() ?? "");
    if (!asset || inputAsset.toLowerCase() === paymentRequirements.asset.toLowerCase()) {
      return res.status(400).json({
        error: "input_asset_not_supported",
        message: "input asset not on the allowlist, or equals the required asset",
      });
    }

    const { sellAmount } = await getRoute(
      inputAsset,
      paymentRequirements.asset as `0x${string}`,
      BigInt(paymentRequirements.amount),
    );
    const facilitatorFee = (sellAmount * FACILITATOR_FEE_BPS) / 10_000n;
    const maxAmountIn = sellAmount + (sellAmount * SLIPPAGE_BPS) / 10_000n + facilitatorFee;

    const permit2Allowance = await viemClient.readContract({
      address: inputAsset,
      abi: erc20Abi,
      functionName: "allowance",
      args: [payer, CANONICAL_PERMIT2_ADDRESS],
    });

    const quoteId = `q_${randomBytes(16).toString("hex")}`;
    const quote: StoredQuote = {
      quoteId,
      quoteIdHash: computeQuoteIdHash(quoteId),
      requirementsHash: computeRequirementsHash(paymentRequirements),
      requirements: paymentRequirements,
      payer,
      inputAsset,
      maxAmountIn,
      facilitatorFee,
      expiresAtMs: Date.now() + QUOTE_TTL_MS,
      consumed: false,
    };
    quotes.set(quoteId, quote);

    res.json({
      quoteId,
      requirementsHash: quote.requirementsHash,
      network: paymentRequirements.network,
      inputAsset,
      maxAmountIn: maxAmountIn.toString(),
      settler: SETTLER,
      expiresAt: new Date(quote.expiresAtMs).toISOString(),
      fees: {
        facilitatorFee: facilitatorFee.toString(),
        estimatedRouteFee: "0",
      },
      authorizationMethods: [
        {
          method: "permit2",
          ready: permit2Allowance >= maxAmountIn,
          spender: SETTLER,
        },
      ],
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ── Swap verification (spec "Verification Logic", permit2 only) ───────────────────────────

/**
 * Validates a swap-settlement payload against its quote.
 *
 * @param payload - The client payment payload
 * @param requirements - The requirements the resource server verified against
 * @returns The quote and info on success, or a spec error code
 */
async function verifySwap(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<
  { quote: StoredQuote; info: SwapSettlementPayloadInfo } | { error: string; message: string }
> {
  const info = extractSwapSettlementInfo(payload);
  if (!info || !validateSwapSettlementInfo(info) || info.method !== "permit2") {
    return {
      error: "authorization_invalid",
      message: "malformed swap-settlement payload",
    };
  }
  const quote = quotes.get(info.quoteId);
  if (!quote)
    return {
      error: "quote_not_found",
      message: `unknown quoteId ${info.quoteId}`,
    };
  if (Date.now() > quote.expiresAtMs) return { error: "quote_expired", message: "re-quote" };
  if (quote.consumed) return { error: "quote_consumed", message: "quote already settled" };
  if (computeRequirementsHash(requirements) !== quote.requirementsHash) {
    return {
      error: "authorization_invalid",
      message: "requirements do not match the quote",
    };
  }

  const auth = info.permit2Authorization!;
  const witnessMatches =
    auth.witness.quoteIdHash === quote.quoteIdHash &&
    auth.witness.requirementsHash === quote.requirementsHash &&
    auth.witness.payTo.toLowerCase() === requirements.payTo.toLowerCase() &&
    auth.witness.outputAsset.toLowerCase() === requirements.asset.toLowerCase() &&
    auth.witness.outputAmount === requirements.amount;
  if (!witnessMatches || BigInt(auth.permitted.amount) !== quote.maxAmountIn) {
    return {
      error: "authorization_invalid",
      message: "witness does not match the quote",
    };
  }

  const signatureValid = await viemClient.verifyTypedData({
    address: quote.payer,
    domain: {
      name: "Permit2",
      chainId: base.id,
      verifyingContract: CANONICAL_PERMIT2_ADDRESS,
    },
    types: PERMIT2_SWAP_WITNESS_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: quote.inputAsset, amount: quote.maxAmountIn },
      spender: SETTLER,
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
      witness: {
        quoteIdHash: quote.quoteIdHash,
        requirementsHash: quote.requirementsHash,
        payTo: requirements.payTo as `0x${string}`,
        outputAsset: requirements.asset as `0x${string}`,
        outputAmount: BigInt(requirements.amount),
      },
    },
    signature: auth.signature as `0x${string}`,
  });
  if (!signatureValid) {
    return {
      error: "authorization_invalid",
      message: "signature does not recover to payer",
    };
  }

  const balance = await viemClient.readContract({
    address: quote.inputAsset,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [quote.payer],
  });
  if (balance < quote.maxAmountIn) {
    return {
      error: "insufficient_input_balance",
      message: "payer balance below maxAmountIn",
    };
  }

  return { quote, info };
}

/**
 * Settles a verified swap payload through the x402SwapSettler in one atomic transaction.
 *
 * @param quote - The stored quote being consumed
 * @param info - The validated payload info
 * @param requirements - The requirements the resource server settled against
 * @returns A standard settle response with swap enrichment
 */
async function settleSwap(
  quote: StoredQuote,
  info: SwapSettlementPayloadInfo,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  quote.consumed = true; // never re-armed after a broadcast attempt; the settler's
  // on-chain consumed set is the replay backstop
  const auth = info.permit2Authorization!;
  const { callData } = await getRoute(
    quote.inputAsset,
    requirements.asset as `0x${string}`,
    BigInt(requirements.amount),
  );

  const hash = await viemClient.writeContract({
    address: SETTLER,
    abi: swapSettlerABI,
    functionName: "settleWithPermit2",
    args: [
      {
        quoteIdHash: quote.quoteIdHash,
        requirementsHash: quote.requirementsHash,
        payer: quote.payer,
        inputAsset: quote.inputAsset,
        maxAmountIn: quote.maxAmountIn,
        facilitatorFee: quote.facilitatorFee,
        outputAsset: requirements.asset as `0x${string}`,
        outputAmount: BigInt(requirements.amount),
        payTo: requirements.payTo as `0x${string}`,
        swapTarget: SWAP_TARGET,
        deadline: BigInt(Math.floor(quote.expiresAtMs / 1000) + 30),
      },
      {
        nonce: BigInt(auth.nonce),
        deadline: BigInt(auth.deadline),
        signature: auth.signature as `0x${string}`,
      },
      callData,
    ],
  });
  const receipt = await viemClient.waitForTransactionReceipt({ hash });

  return {
    success: receipt.status === "success",
    transaction: hash,
    network: requirements.network,
    payer: quote.payer,
    amount: requirements.amount,
    extensions: {
      [SWAP_SETTLEMENT_KEY]: {
        info: { quoteId: quote.quoteId, inputAsset: quote.inputAsset },
      },
    },
  };
}

// ── Facilitator endpoints: swap payloads intercepted, everything else passes through ──────

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    if (paymentPayload?.extensions?.[SWAP_SETTLEMENT_KEY]) {
      const result = await verifySwap(paymentPayload, paymentRequirements);
      if ("error" in result) {
        return res.json({
          isValid: false,
          invalidReason: result.error,
          invalidMessage: result.message,
        } satisfies VerifyResponse);
      }
      return res.json({
        isValid: true,
        payer: result.quote.payer,
      } satisfies VerifyResponse);
    }
    res.json(await facilitator.verify(paymentPayload, paymentRequirements));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    if (paymentPayload?.extensions?.[SWAP_SETTLEMENT_KEY]) {
      const result = await verifySwap(paymentPayload, paymentRequirements);
      if ("error" in result) {
        return res.json({
          success: false,
          errorReason: result.error,
          errorMessage: result.message,
          transaction: "",
          network: paymentRequirements.network,
        } satisfies SettleResponse);
      }
      return res.json(await settleSwap(result.quote, result.info, paymentRequirements));
    }
    res.json(await facilitator.settle(paymentPayload, paymentRequirements));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});

app.listen(parseInt(PORT), () => {
  console.log(`Swap-settlement facilitator listening on http://localhost:${PORT} (Base)`);
  console.log(`  settler:     ${SETTLER}`);
  console.log(`  swap target: ${SWAP_TARGET}`);
});
