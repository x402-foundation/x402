/**
 * Swig Smart Wallet Setup Script
 *
 * Creates a Swig account for CLIENT_SVM_PRIVATE_KEY (if needed), creates ATAs,
 * and funds the Swig wallet with devnet USDC for svm-smart-wallet e2e tests.
 *
 * Usage:
 *   pnpm tsx scripts/swig-setup.ts
 *   pnpm swig:setup
 *
 * Environment variables:
 *   CLIENT_SVM_PRIVATE_KEY - Swig authority (required)
 *   SVM_RPC_URL            - Solana RPC (optional, defaults to devnet)
 *   SWIG_ACCOUNT_ADDRESS   - Reuse existing Swig account (optional)
 *   SWIG_ID_BASE58         - Fixed Swig id when creating (optional)
 *   SVM_USDC_MINT          - Token mint to fund (optional, devnet USDC default)
 *
 * Funding uses the standard e2e exact price ($0.001 = 1000 base units). If Swig
 * balance is below one payment, tops up to 10× that amount.
 *
 * On first Swig creation, persists SWIG_ACCOUNT_ADDRESS (and SWIG_ID_BASE58 when
 * generated) to e2e/.env automatically.
 *
 * Prints a JSON result line on success:
 *   {"ok":true,"swigAccountAddress":"..."}
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { base58 } from "@scure/base";
import {
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstructionAsync,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import {
  fetchSwig,
  findSwigPda,
  getCreateSwigInstruction,
  getSwigWalletAddress,
} from "@swig-wallet/kit";
import { Actions, createEd25519AuthorityInfo } from "@swig-wallet/lib";

config();

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const DEVNET_WS_URL = "wss://api.devnet.solana.com";
const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MIN_AUTHORITY_SOL = 5_000_000n;
/** Standard e2e exact endpoint price: $0.001 USDC (6 decimals). */
const E2E_EXACT_PAYMENT_BASE_UNITS = 1_000n;
const SWIG_FUND_MULTIPLIER = 10n;

type SwigConnection = {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
};

function createConnection(rpcUrl?: string): SwigConnection {
  const url = rpcUrl ?? DEVNET_RPC_URL;
  const wsUrl = rpcUrl?.replace(/^http/i, "ws") ?? DEVNET_WS_URL;
  return {
    rpc: createSolanaRpc(url),
    rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl),
  };
}

async function sendInstructions(
  connection: SwigConnection,
  payer: KeyPairSigner,
  instructions: Instruction[],
  signers: KeyPairSigner[] = [],
): Promise<string> {
  const sendAndConfirm = sendAndConfirmTransactionFactory(connection);
  const { value: latestBlockhash } = await connection.rpc.getLatestBlockhash().send();

  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(payer, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    tx => appendTransactionMessageInstructions(instructions, tx),
    tx => addSignersToTransactionMessage(signers, tx),
  );

  const signedTx = await signTransactionMessageWithSigners(txMessage);
  await sendAndConfirm(signedTx as Parameters<typeof sendAndConfirm>[0], {
    commitment: "confirmed",
  });
  return getSignatureFromTransaction(signedTx);
}

async function requireSolBalance(
  connection: SwigConnection,
  address: Address,
  minimumLamports: bigint,
): Promise<void> {
  const balance = await connection.rpc.getBalance(address).send();
  if (balance.value >= minimumLamports) {
    return;
  }

  throw new Error(
    `CLIENT_SVM_PRIVATE_KEY (${address}) needs at least ${minimumLamports} lamports of devnet SOL ` +
      `(current: ${balance.value}). Fund via https://faucet.solana.com/ then retry.`,
  );
}

type ResolvedSwigAccount = {
  address: Address;
  created: boolean;
  /** Set when a new random Swig id was generated (persisted to .env). */
  swigIdBase58?: string;
};

function upsertEnvFile(envPath: string, updates: Record<string, string>): void {
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(content)) {
      content = content.replace(pattern, line);
    } else {
      if (content.length > 0 && !content.endsWith("\n")) {
        content += "\n";
      }
      content += `${line}\n`;
    }
  }

  writeFileSync(envPath, content);
}

function persistSwigEnv(envPath: string, resolved: ResolvedSwigAccount): void {
  const updates: Record<string, string> = {
    SWIG_ACCOUNT_ADDRESS: resolved.address,
  };
  if (resolved.swigIdBase58) {
    updates.SWIG_ID_BASE58 = resolved.swigIdBase58;
  }

  upsertEnvFile(envPath, updates);
  console.log(`💾 Saved Swig settings to ${envPath}`);
}

async function resolveSwigAccountAddress(
  connection: SwigConnection,
  authority: KeyPairSigner,
): Promise<ResolvedSwigAccount> {
  const fromEnv = process.env.SWIG_ACCOUNT_ADDRESS;
  if (fromEnv) {
    console.log(`ℹ️  Using existing Swig account ${fromEnv}`);
    return { address: fromEnv as Address, created: false };
  }

  await requireSolBalance(connection, authority.address, MIN_AUTHORITY_SOL);

  const swigIdFromEnv = process.env.SWIG_ID_BASE58;
  const swigId = swigIdFromEnv ? base58.decode(swigIdFromEnv) : (() => {
    const id = new Uint8Array(32);
    crypto.getRandomValues(id);
    return id;
  })();
  const swigAccountAddress = await findSwigPda(swigId);
  const createSwigIx = await getCreateSwigInstruction({
    payer: authority.address,
    id: swigId,
    authorityInfo: createEd25519AuthorityInfo(authority.address),
    actions: Actions.set().all().get(),
  });

  console.log(`🔄 Creating Swig account ${swigAccountAddress}...`);
  const sig = await sendInstructions(connection, authority, [createSwigIx as Instruction]);
  console.log(`   ✅ Swig create tx: ${sig}`);

  return {
    address: swigAccountAddress,
    created: true,
    swigIdBase58: swigIdFromEnv ? undefined : base58.encode(swigId),
  };
}

async function ensureSwigFunded(
  connection: SwigConnection,
  authority: KeyPairSigner,
  swigAccountAddress: Address,
  mint: Address,
): Promise<void> {
  const swig = await fetchSwig(connection.rpc as never, swigAccountAddress);
  const swigWalletAddress = await getSwigWalletAddress(swig);

  const mintInfo = await fetchMint(connection.rpc, mint);
  const tokenProgram = mintInfo.programAddress;
  const decimals = mintInfo.data.decimals;

  const [authorityAta] = await findAssociatedTokenPda({
    mint,
    owner: authority.address,
    tokenProgram,
  });
  const [swigAta] = await findAssociatedTokenPda({
    mint,
    owner: swigWalletAddress,
    tokenProgram,
  });

  const createAuthorityAtaIx = await getCreateAssociatedTokenInstructionAsync({
    payer: authority,
    mint,
    owner: authority.address,
    tokenProgram,
  });
  const createSwigAtaIx = await getCreateAssociatedTokenInstructionAsync({
    payer: authority,
    mint,
    owner: swigWalletAddress,
    tokenProgram,
  });

  try {
    await connection.rpc.getTokenAccountBalance(authorityAta).send();
  } catch {
    console.log("🔄 Creating authority USDC ATA...");
    await sendInstructions(connection, authority, [createAuthorityAtaIx]);
  }

  try {
    await connection.rpc.getTokenAccountBalance(swigAta).send();
  } catch {
    console.log("🔄 Creating Swig wallet USDC ATA...");
    await sendInstructions(connection, authority, [createSwigAtaIx]);
  }

  const swigBalance = await connection.rpc.getTokenAccountBalance(swigAta).send();
  const swigAmount = BigInt(swigBalance.value.amount);
  const fundTarget = E2E_EXACT_PAYMENT_BASE_UNITS * SWIG_FUND_MULTIPLIER;

  if (swigAmount >= E2E_EXACT_PAYMENT_BASE_UNITS) {
    console.log(
      `✅ Swig wallet has ${swigBalance.value.uiAmountString} USDC (≥ ${E2E_EXACT_PAYMENT_BASE_UNITS} base units for one payment)`,
    );
    return;
  }

  const topUpAmount = fundTarget - swigAmount;
  const authorityBalance = await connection.rpc.getTokenAccountBalance(authorityAta).send();
  if (BigInt(authorityBalance.value.amount) < topUpAmount) {
    throw new Error(
      "Authority USDC balance too low. Fund CLIENT_SVM_PRIVATE_KEY with devnet USDC " +
        "(https://faucet.circle.com/) then retry.",
    );
  }

  console.log(`🔄 Funding Swig wallet with ${topUpAmount} base units of USDC...`);
  const fundIx = getTransferCheckedInstruction(
    {
      source: authorityAta,
      mint,
      destination: swigAta,
      authority,
      amount: topUpAmount,
      decimals,
    },
    { programAddress: tokenProgram },
  );
  const sig = await sendInstructions(connection, authority, [fundIx]);
  console.log(`   ✅ Fund tx: ${sig}`);
}

async function main(): Promise<void> {
  const privateKey = process.env.CLIENT_SVM_PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ CLIENT_SVM_PRIVATE_KEY environment variable is required");
    process.exit(1);
  }

  const rpcUrl = process.env.SVM_RPC_URL;
  const mint = (process.env.SVM_USDC_MINT ?? USDC_DEVNET_MINT) as Address;
  const connection = createConnection(rpcUrl);
  const authority = await createKeyPairSignerFromBytes(base58.decode(privateKey));

  console.log(`\n🔑 Authority: ${authority.address}`);
  console.log(`📍 RPC: ${rpcUrl ?? DEVNET_RPC_URL}`);
  console.log(`💰 Mint: ${mint}\n`);

  const resolved = await resolveSwigAccountAddress(connection, authority);
  await ensureSwigFunded(connection, authority, resolved.address, mint);

  if (resolved.created) {
    persistSwigEnv(join(process.cwd(), ".env"), resolved);
  }

  console.log(JSON.stringify({ ok: true, swigAccountAddress: resolved.address }));
}

main().catch(error => {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
