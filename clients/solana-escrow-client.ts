/**
 * x402 Solana Escrow Client
 * Works with the x402_escrow Anchor program.
 * Used by the paying agent to initialize/release/refund USDC escrows on Solana.
 *
 * USDC Mint (mainnet): EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 * USDC Mint (devnet):  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  Program,
  AnchorProvider,
  BN,
  web3,
  Idl,
} from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as nacl from "tweetnacl";
import * as crypto from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

export const USDC_MINT_MAINNET = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
export const USDC_MINT_DEVNET = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

export const X402_ESCROW_PROGRAM_ID = new PublicKey(
  "x402EscrowProgramIdReplaceAfterDeploy1111111" // replace after anchor deploy
);

// ── PDA Helpers ───────────────────────────────────────────────────────────────

export function getEscrowPda(
  escrowId: Uint8Array,
  programId: PublicKey = X402_ESCROW_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), Buffer.from(escrowId)],
    programId
  );
}

export function getVaultPda(
  escrowId: Uint8Array,
  programId: PublicKey = X402_ESCROW_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(escrowId)],
    programId
  );
}

// ── Grant Signing (ed25519 + x402 Grant) ─────────────────────────────────────

export interface X402SolanaGrant {
  grantId:       string;
  principal:     string; // base58 Solana public key
  agent:         string; // base58 Solana public key
  issuedAt:      number;
  expiration:    number;
  totalBudget:   number; // USDC micro-units (6 decimals)
  perRequestCap: number;
  chainType:     "solana";
  chainId:       "solana-mainnet" | "solana-devnet";
  escrowId:      string; // hex-encoded 32 bytes
}

/** Sign an x402 Solana grant with ed25519 — attach as X-402-Payment header */
export function signSolanaGrant(
  grant: X402SolanaGrant,
  signer: Keypair
): string {
  const sortedKeys = Object.keys(grant).sort() as (keyof X402SolanaGrant)[];
  const sorted: Record<string, unknown> = {};
  for (const k of sortedKeys) sorted[k] = grant[k];

  const message   = new TextEncoder().encode(JSON.stringify(sorted));
  const signature = nacl.sign.detached(message, signer.secretKey);
  return Buffer.from(signature).toString("base64");
}

/** Verify a Solana grant signature — used by receiving agent */
export function verifySolanaGrant(
  grant: X402SolanaGrant,
  signatureB64: string,
  signerPublicKeyBase58: string
): boolean {
  const sortedKeys = Object.keys(grant).sort() as (keyof X402SolanaGrant)[];
  const sorted: Record<string, unknown> = {};
  for (const k of sortedKeys) sorted[k] = grant[k];

  const message   = new TextEncoder().encode(JSON.stringify(sorted));
  const signature = Buffer.from(signatureB64, "base64");
  const pubKey    = new PublicKey(signerPublicKeyBase58).toBytes();

  return nacl.sign.detached.verify(message, signature, pubKey);
}

/** Build the X-402-Payment header value for a Solana escrow payment */
export function buildSolanaPaymentHeader(
  grant: X402SolanaGrant,
  signature: string,
  escrowPda: PublicKey,
  vaultPda: PublicKey
): string {
  const payload = {
    grant,
    signature,
    chainType: "solana" as const,
    chainId:   grant.chainId,
    escrow: {
      pda:   escrowPda.toBase58(),
      vault: vaultPda.toBase58(),
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

// ── Escrow Lifecycle ──────────────────────────────────────────────────────────

export interface EscrowResult {
  escrowPda:   PublicKey;
  vaultPda:    PublicKey;
  txSignature: string;
}

/**
 * Initialize a USDC escrow on Solana.
 * Call this when the paying agent submits an x402 payment with chainType="solana".
 *
 * @param connection    — Solana RPC connection
 * @param principal     — Paying agent keypair
 * @param receiver      — Receiving agent public key
 * @param amountUsdc    — Amount in USDC micro-units (1 USDC = 1_000_000)
 * @param deadlineSecs  — Unix timestamp of escrow deadline
 * @param escrowIdHex   — 32-byte escrow ID from grant (hex string or Uint8Array)
 * @param usdcMint      — USDC mint pubkey (defaults to mainnet)
 */
export async function initializeEscrow(
  connection: Connection,
  principal: Keypair,
  receiver: PublicKey,
  amountUsdc: number,
  deadlineSecs: number,
  escrowIdHex: string | Uint8Array,
  usdcMint: PublicKey = USDC_MINT_MAINNET
): Promise<EscrowResult> {
  const escrowId =
    typeof escrowIdHex === "string"
      ? Buffer.from(escrowIdHex.replace("0x", ""), "hex")
      : Buffer.from(escrowIdHex);

  const [escrowPda] = getEscrowPda(escrowId);
  const [vaultPda]  = getVaultPda(escrowId);

  const principalAta = await getAssociatedTokenAddress(usdcMint, principal.publicKey);

  // Build instruction manually (or via Anchor program client if IDL available)
  // For now: construct the Anchor discriminator + args via raw instruction
  const discriminator = Buffer.from(
    crypto.createHash("sha256").update("global:initialize_escrow").digest()
  ).slice(0, 8);

  const amountBuf   = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(amountUsdc));
  const deadlineBuf = Buffer.alloc(8);
  deadlineBuf.writeBigInt64LE(BigInt(deadlineSecs));

  const data = Buffer.concat([
    discriminator,
    Buffer.from(escrowId),
    amountBuf,
    deadlineBuf,
  ]);

  const { Transaction, TransactionInstruction } = await import("@solana/web3.js");

  const ix = new TransactionInstruction({
    programId: X402_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: principal.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: receiver,            isSigner: false, isWritable: false },
      { pubkey: escrowPda,           isSigner: false, isWritable: true  },
      { pubkey: principalAta,        isSigner: false, isWritable: true  },
      { pubkey: vaultPda,            isSigner: false, isWritable: true  },
      { pubkey: usdcMint,            isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,    isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,  isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = principal.publicKey;

  const txSignature = await connection.sendTransaction(tx, [principal]);
  await connection.confirmTransaction(txSignature, "confirmed");

  console.log(`Escrow initialized: ${escrowPda.toBase58()} — tx: ${txSignature}`);
  return { escrowPda, vaultPda, txSignature };
}

/**
 * Release escrowed USDC to receiver — call after confirming service delivery.
 * Must be called before deadline.
 */
export async function releaseEscrow(
  connection: Connection,
  receiver: Keypair,
  escrowPda: PublicKey,
  vaultPda: PublicKey,
  receiverAta: PublicKey
): Promise<string> {
  const discriminator = Buffer.from(
    crypto.createHash("sha256").update("global:release").digest()
  ).slice(0, 8);

  const { Transaction, TransactionInstruction } = await import("@solana/web3.js");

  const ix = new TransactionInstruction({
    programId: X402_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: escrowPda,           isSigner: false, isWritable: true  },
      { pubkey: receiver.publicKey,  isSigner: true,  isWritable: false },
      { pubkey: vaultPda,            isSigner: false, isWritable: true  },
      { pubkey: receiverAta,         isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,    isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = receiver.publicKey;

  const sig = await connection.sendTransaction(tx, [receiver]);
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`Escrow released — tx: ${sig}`);
  return sig;
}

/**
 * Refund escrowed USDC to principal — callable by anyone after deadline.
 * Protects paying agent from permanently locked funds.
 */
export async function refundEscrow(
  connection: Connection,
  caller: Keypair,
  escrowPda: PublicKey,
  vaultPda: PublicKey,
  principalAta: PublicKey,
  principalPubkey: PublicKey
): Promise<string> {
  const discriminator = Buffer.from(
    crypto.createHash("sha256").update("global:refund").digest()
  ).slice(0, 8);

  const { Transaction, TransactionInstruction } = await import("@solana/web3.js");

  const ix = new TransactionInstruction({
    programId: X402_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: escrowPda,       isSigner: false, isWritable: true  },
      { pubkey: principalPubkey, isSigner: false, isWritable: false },
      { pubkey: vaultPda,        isSigner: false, isWritable: true  },
      { pubkey: principalAta,    isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = caller.publicKey;

  const sig = await connection.sendTransaction(tx, [caller]);
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`Escrow refunded — tx: ${sig}`);
  return sig;
}

// ── Facilitator Integration ───────────────────────────────────────────────────

/**
 * x402 Facilitator: full Solana escrow settlement handler.
 * Called from /x402/settle when grant.chainType === "solana".
 *
 * Flow:
 *   1. Verify ed25519 grant signature
 *   2. Initialize escrow (if not already done by paying agent)
 *   3. Spawn deadline watcher (auto-refund on timeout)
 *   4. On delivery confirmation → call release()
 */
export async function handleSolanaEscrowSettlement(
  grant: X402SolanaGrant,
  signatureB64: string,
  facilityKeypair: Keypair,
  usdcMint: PublicKey = USDC_MINT_MAINNET,
  cluster: "mainnet-beta" | "devnet" = "mainnet-beta"
): Promise<{ escrowPda: string; vaultPda: string; txSignature: string }> {
  const connection = new Connection(
    cluster === "mainnet-beta"
      ? "https://api.mainnet-beta.solana.com"
      : "https://api.devnet.solana.com",
    "confirmed"
  );

  // 1. Verify grant signature
  const isValid = verifySolanaGrant(grant, signatureB64, grant.principal);
  if (!isValid) throw new Error("Invalid Solana ed25519 grant signature");

  // 2. Validate timing
  const now = Math.floor(Date.now() / 1000);
  if (now > grant.expiration) throw new Error("Grant expired");
  if (grant.perRequestCap <= 0) throw new Error("perRequestCap must be > 0");

  // 3. Compute deadline (grant expiration or +60s buffer)
  const deadline = grant.expiration;
  const escrowId = Buffer.from(grant.escrowId.replace("0x", ""), "hex");
  const receiver = new PublicKey(grant.agent);

  // 4. Initialize escrow
  const result = await initializeEscrow(
    connection,
    facilityKeypair,
    receiver,
    grant.perRequestCap,
    deadline,
    escrowId,
    usdcMint
  );

  // 5. Spawn auto-refund watcher (non-blocking)
  const msUntilDeadline = (deadline - now) * 1000;
  setTimeout(async () => {
    try {
      const principalAta = await getAssociatedTokenAddress(
        usdcMint,
        facilityKeypair.publicKey
      );
      await refundEscrow(
        connection,
        facilityKeypair,
        result.escrowPda,
        result.vaultPda,
        principalAta,
        facilityKeypair.publicKey
      );
      console.log(`Auto-refund triggered for escrow ${result.escrowPda.toBase58()}`);
    } catch (e) {
      // Already released — normal case
      console.log(`Refund skipped (likely already released): ${e}`);
    }
  }, msUntilDeadline + 5000);

  return {
    escrowPda:   result.escrowPda.toBase58(),
    vaultPda:    result.vaultPda.toBase58(),
    txSignature: result.txSignature,
  };
}
