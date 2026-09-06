import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import {
  AccountAddress,
  AccountSigner,
  buildBasicAccountSigner,
  TransactionHash,
  CcdAmount,
  AccountInfo,
  Token,
  TokenId,
} from "@concordium/web-sdk";
import type { Network } from "@x402/core/types";
import { Transaction } from "@concordium/web-sdk/transactions";
import type { SignableV1Transaction, TransactionInfo, TransactionStatus } from "./types";

/**
 * Client-side signer for building and signing Concordium transactions as sender.
 */
export interface ClientConcordiumSigner {
  accountAddress: AccountAddress.Type;
  signer: AccountSigner;
}

/**
 * gRPC Config interface
 */
export interface GrpcConfig {
  host: string;
  port: number;
  useTls?: boolean;
}

/**
 * Facilitator-side signer for Concordium sponsored transactions.
 *
 * The facilitator:
 *   1. Verifies sender signatures cryptographically (Rule 8)
 *   2. Adds its sponsor signature to the client's partially-signed tx
 *   3. Submits the fully-signed tx to the node
 *   4. Waits for finalization and returns the on-chain outcome
 */
export interface FacilitatorConcordiumSigner {
  /** Sponsor account address (base58check string). */
  getAddress(): string;

  /** CAIP-2 network this signer is connected to. */
  getNetwork(): Network;

  /** Fetches on-chain account info for cryptographic signature verification (Rule 8). */
  getAccountInfo(address: string): Promise<AccountInfo>;

  /** Adds the sponsor signature to a client-signed V1 transaction. */
  addSponsorSignature(tx: SignableV1Transaction): Promise<Transaction.JSON>;

  /** Finalizes and submits a fully-signed transaction. Returns tx hash (hex). */
  submitTransaction(signedTxJSON: Transaction.JSON): Promise<string>;

  /** Waits for finalization and returns on-chain details. */
  waitForFinalization(txHash: string, timeoutMs?: number): Promise<TransactionInfo>;

  /** Returns the sender's PLT balance in smallest units for the given token id. */
  getTokenBalance(address: string, tokenId: string): Promise<bigint | undefined>;

  /** Returns the on-chain PLT decimals/exponent for the given token id. */
  getTokenDecimals(tokenId: string): Promise<number>;
}

/**
 * Creates a `FacilitatorConcordiumSigner` from a sponsor address,
 * a hex-encoded Ed25519 private key, and gRPC connection config.
 *
 * This is the recommended path for facilitator deployments — it matches
 * how every other mechanism (EVM, SVM, AVM, Stellar, Hedera, TVM) reads
 * a private key from an environment variable.
 *
 * @param sponsorAddress - Sponsor account address (base58check string)
 * @param privateKey      - Hex-encoded Ed25519 private key (e.g. from CCD_FACILITATOR_PRIVATE_KEY env var)
 * @param grpcConfig      - gRPC connection parameters, optionally including the CAIP-2 network
 * @returns A FacilitatorConcordiumSigner instance
 *
 * @example
 * ```typescript
 * import { getConcordiumGrpcUrl, parseGrpcUrl } from "@x402/concordium";
 *
 * const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(network));
 *
 * const signer = toConcordiumFacilitatorSigner(
 *   process.env.CCD_FACILITATOR_ADDRESS,
 *   process.env.CCD_FACILITATOR_PRIVATE_KEY,
 *   { host, port, useTls: true },
 * );
 * ```
 */
export function toConcordiumFacilitatorSigner(
  sponsorAddress: string,
  privateKey: string,
  grpcConfig: GrpcConfig & { network?: Network },
): FacilitatorConcordiumSigner;

/**
 * Creates a `FacilitatorConcordiumSigner` from a sponsor address,
 * an already-built account signer, and gRPC connection config.
 *
 * Use this overload when you already have an `AccountSigner` instance.
 *
 * @param sponsorAddress - Sponsor account address (base58check string)
 * @param sponsorSigner  - Pre-built AccountSigner instance
 * @param grpcConfig     - gRPC connection parameters, optionally including the CAIP-2 network
 * @returns A FacilitatorConcordiumSigner instance
 *
 * @example
 * ```typescript
 * import { buildBasicAccountSigner } from "@concordium/web-sdk";
 * import { getConcordiumGrpcUrl, parseGrpcUrl } from "@x402/concordium";
 *
 * const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(network));
 *
 * const signer = toConcordiumFacilitatorSigner(
 *   process.env.CCD_FACILITATOR_ADDRESS!,
 *   buildBasicAccountSigner(process.env.CCD_FACILITATOR_PRIVATE_KEY!),
 *   { host, port, useTls: true },
 * );
 * ```
 */
export function toConcordiumFacilitatorSigner(
  sponsorAddress: string,
  sponsorSigner: AccountSigner,
  grpcConfig: GrpcConfig & { network?: Network },
): FacilitatorConcordiumSigner;

/**
 * Implementation — dispatches to the shared helper after resolving the signer.
 *
 * @param sponsorAddress - Sponsor account address (base58check string)
 * @param signerOrKey    - Either a pre-built AccountSigner or a hex-encoded Ed25519 private key
 * @param grpcConfig     - gRPC connection parameters, optionally including the CAIP-2 network
 * @returns A FacilitatorConcordiumSigner instance
 */
export function toConcordiumFacilitatorSigner(
  sponsorAddress: string,
  signerOrKey: AccountSigner | string,
  grpcConfig: GrpcConfig & { network?: Network },
): FacilitatorConcordiumSigner {
  const sponsorSigner: AccountSigner =
    typeof signerOrKey === "string" ? buildBasicAccountSigner(signerOrKey) : signerOrKey;

  return createFacilitatorSigner(sponsorAddress, sponsorSigner, grpcConfig);
}

/**
 * Shared internal helper — builds the FacilitatorConcordiumSigner object
 * from a resolved AccountSigner. Both public overloads delegate here.
 *
 * @param sponsorAddress - Sponsor account address (base58check string)
 * @param sponsorSigner  - Resolved AccountSigner instance
 * @param grpcConfig     - gRPC connection parameters, optionally including the CAIP-2 network
 * @returns A FacilitatorConcordiumSigner instance
 */
function createFacilitatorSigner(
  sponsorAddress: string,
  sponsorSigner: AccountSigner,
  grpcConfig: GrpcConfig & { network?: Network },
): FacilitatorConcordiumSigner {
  const sponsorAccount = AccountAddress.fromBase58(sponsorAddress);

  const creds =
    grpcConfig.useTls !== false ? credentials.createSsl() : credentials.createInsecure();

  const grpcClient = new ConcordiumGRPCNodeClient(grpcConfig.host, grpcConfig.port, creds);

  return {
    getAddress(): string {
      return sponsorAccount.toString();
    },

    getNetwork(): Network {
      return grpcConfig.network ?? "ccd:*";
    },

    async getAccountInfo(address: string): Promise<AccountInfo> {
      const accountAddress = AccountAddress.fromBase58(address);
      return grpcClient.getAccountInfo(accountAddress);
    },

    async addSponsorSignature(tx: SignableV1Transaction): Promise<Transaction.JSON> {
      const signable = Transaction.signableFromJSON(tx);

      const sponsored = await Transaction.sponsor(
        signable as Parameters<typeof Transaction.sponsor>[0],
        sponsorSigner,
      );

      return Transaction.toJSON(sponsored);
    },

    async submitTransaction(signedTxJSON: Transaction.JSON): Promise<string> {
      const signable = Transaction.signableFromJSON(signedTxJSON);
      const finalized = Transaction.finalize(signable);

      const txHash = await grpcClient.sendTransaction(finalized);

      return txHash.toString();
    },

    async waitForFinalization(txHash: string, timeoutMs = 60_000): Promise<TransactionInfo> {
      const hash = TransactionHash.fromHexString(txHash);

      await grpcClient.waitForTransactionFinalization(hash, timeoutMs);

      const blockStatus = await grpcClient.getBlockItemStatus(hash);

      if (!blockStatus) {
        throw new Error(`Transaction ${txHash} not found after finalization`);
      }

      const status = blockStatus.status === "finalized" ? "finalized" : "committed";
      const summary = (blockStatus as unknown as Record<string, unknown>).outcome as
        | { summary: Record<string, unknown> }
        | undefined;

      if (!summary?.summary) {
        return { txHash, status, sender: "" };
      }

      const sender: string = (summary.summary.sender as { address?: string })?.address ?? "";

      if (summary.summary.transactionType === "failed") {
        throw new Error(`Transaction ${txHash} failed on-chain`);
      }

      return parseTransactionSummary(txHash, status, sender, summary.summary);
    },

    async getTokenBalance(address: string, tokenId: string): Promise<bigint | undefined> {
      const token = await Token.fromId(grpcClient, TokenId.fromString(tokenId));
      const balance = await Token.balanceOf(token, AccountAddress.fromBase58(address));
      return balance?.value;
    },

    async getTokenDecimals(tokenId: string): Promise<number> {
      const token = await Token.fromId(grpcClient, TokenId.fromString(tokenId));
      return token.info.state.decimals;
    },
  };
}

/**
 * Parses on-chain transaction summary into a TransactionInfo object.
 *
 * @param txHash - The transaction hash (hex string)
 * @param status - The finalization status
 * @param sender - The sender account address
 * @param summary - The on-chain transaction summary
 * @returns Parsed transaction info with recipient, amount, and asset details
 */
function parseTransactionSummary(
  txHash: string,
  status: TransactionStatus,
  sender: string,
  summary: Record<string, unknown>,
): TransactionInfo {
  const transactionType = summary.transactionType as string;

  // Native CCD transfer
  if (
    (transactionType === "transfer" || transactionType === "transferWithMemo") &&
    summary.transfer
  ) {
    const transfer = summary.transfer as Record<string, unknown>;
    const amountMicroCcd = transfer.amount
      ? CcdAmount.toMicroCcd(transfer.amount as CcdAmount.Type)
      : 0n;

    return {
      txHash,
      status,
      sender,
      recipient: (transfer.to as { address?: string })?.address,
      amount: amountMicroCcd.toString(),
      asset: "CCD",
    };
  }

  // PLT token transfer
  if (
    transactionType === "tokenUpdate" &&
    Array.isArray(summary.events) &&
    summary.events.length > 0
  ) {
    const transferEvent = (summary.events as Array<Record<string, unknown>>).find(
      e => e.tag === "TokenTransfer",
    );

    if (transferEvent) {
      return {
        txHash,
        status,
        sender,
        recipient: ((transferEvent.to as Record<string, unknown>)?.address as { address?: string })
          ?.address,
        amount: (
          (transferEvent.amount as Record<string, unknown>)?.value as { toString(): string }
        )?.toString(),
        asset: (transferEvent.tokenId as { value?: string })?.value,
      };
    }
  }

  return { txHash, status, sender };
}
