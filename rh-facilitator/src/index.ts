/**
 * Robinhood Chain x402 Facilitator — MVP
 *
 * Handles verify + settle for x402 exact payments on RH Chain.
 * Uses Permit2 (already deployed on all EVM chains via CREATE2).
 *
 * Flow:
 *   1. Client → Resource Server → 402 Payment Required
 *   2. Client signs Permit2 authorization → Payment-Signature header
 *   3. Resource Server → POST /verify → this facilitator
 *   4. If valid → Resource Server serves data
 *   5. POST /settle → on-chain transfer
 */
import express from "express";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyPayment, settlePayment } from "./payment";
import "dotenv/config";

const PORT = parseInt(process.env.PORT || "3001");
const PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY || "0x...";
const RH_RPC = process.env.RH_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "46630");

// Robinhood Chain (testnet) config
const robinhoodTestnet = {
  id: CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RH_RPC] } },
};

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

const publicClient = createPublicClient({
  chain: robinhoodTestnet,
  transport: http(RH_RPC),
});

const walletClient = createWalletClient({
  account,
  chain: robinhoodTestnet,
  transport: http(RH_RPC),
});

const app = express();
app.use(express.json());

// ── Health ──────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", chain: CHAIN_ID, address: account.address });
});

// ── Supported schemes (x402 v2) ─────────────────────────
app.get("/supported", (_req, res) => {
  res.json({
    kinds: [
      { x402Version: 2, scheme: "exact", network: `eip155:${CHAIN_ID}` },
    ],
    extensions: [],
    signers: {
      [`eip155:${CHAIN_ID}`]: [account.address],
    },
  });
});

// ── Verify (x402 v2: {x402Version, paymentPayload, paymentRequirements}) ──
app.post("/verify", async (req, res) => {
  try {
    // v2 naming, with legacy {payload, requirements} tolerance
    const paymentPayload = req.body.paymentPayload ?? req.body.payload;
    // Requirements: explicit param → payload.accepted (v2 canonical) → undefined
    const paymentRequirements = req.body.paymentRequirements ?? req.body.requirements ?? paymentPayload?.accepted;
    const result = await verifyPayment(publicClient, paymentPayload, paymentRequirements);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ isValid: false, invalidReason: err.message });
  }
});

// ── Settle (x402 v2) ────────────────────────────────────
app.post("/settle", async (req, res) => {
  try {
    const paymentPayload = req.body.paymentPayload ?? req.body.payload;
    const paymentRequirements = req.body.paymentRequirements ?? req.body.requirements ?? paymentPayload?.accepted;
    const result = await settlePayment(walletClient, publicClient, paymentPayload, paymentRequirements);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, transaction: "", network: `eip155:${CHAIN_ID}`, errorReason: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🟢 Robinhood x402 Facilitator running on :${PORT}`);
  console.log(`   Chain: ${CHAIN_ID} | RPC: ${RH_RPC}`);
  console.log(`   Signer: ${account.address}`);
});