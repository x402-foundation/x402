import {
  findAssociatedTokenPda,
  getApproveInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import {
  DEFAULT_COMPUTE_UNIT_LIMIT,
  DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ADDRESS,
} from "../../constants";
import type { ClientSvmSigner, ClientSvmConfig } from "../../signer";
import type { AuthCaptureSvmPayloadV2 } from "../types";
import { applyTransactionV1Config, computeBudgetInstructions } from "../../transactionV1";
import { createRpcClient, resolveBlockhash, resolveTransactionVersion } from "../../utils";
import { getCachedMintMetadata, type MintMetadataCache } from "../../mint-cache";
import { findDefaultAsset } from "../../defaultAssets";

/**
 * SVM client implementation for the Auth-Capture payment scheme.
 *
 * The client builds a transaction containing an SPL Token `Approve` instruction
 * that delegates up to `requirements.amount` from the payer's ATA to the
 * facilitator's delegate authority (`extra.delegate`). The facilitator, acting
 * as delegate, can later capture (transfer) up to that amount, void (revoke)
 * the delegation, or the merchant can refund captured funds.
 */
export class AuthCaptureSvmScheme implements SchemeNetworkClient {
  readonly scheme = "auth-capture";
  findDefaultAsset = findDefaultAsset;
  private readonly mintCache: MintMetadataCache = new Map();

  /**
   * Creates a new AuthCaptureSvmClient instance.
   *
   * @param signer - The SVM signer for client operations
   * @param config - Optional configuration with custom RPC URL
   */
  constructor(
    private readonly signer: ClientSvmSigner,
    private readonly config?: ClientSvmConfig,
  ) {}

  /**
   * Creates a payment payload for the Auth-Capture scheme.
   *
   * Builds a transaction with an `Approve` instruction delegating
   * `requirements.amount` from the payer's ATA to `extra.delegate`, plus an
   * optional Memo instruction for replay protection.
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to a payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const transactionVersion = resolveTransactionVersion(
      paymentRequirements.extra,
      this.config?.transactionVersions,
    );
    const rpc = createRpcClient(paymentRequirements.network, this.config?.rpcUrl);

    const mintMetadata = await getCachedMintMetadata(
      rpc,
      paymentRequirements.network,
      paymentRequirements.asset as Address,
      this.mintCache,
    );
    const tokenProgramAddress = mintMetadata.programAddress;

    if (
      tokenProgramAddress.toString() !== TOKEN_PROGRAM_ADDRESS.toString() &&
      tokenProgramAddress.toString() !== TOKEN_2022_PROGRAM_ADDRESS.toString()
    ) {
      throw new Error("Asset was not created by a known token program");
    }

    const delegate = paymentRequirements.extra?.delegate as Address;
    if (!delegate) {
      throw new Error("delegate is required in paymentRequirements.extra for auth-capture");
    }

    const [sourceATA] = await findAssociatedTokenPda({
      mint: paymentRequirements.asset as Address,
      owner: this.signer.address,
      tokenProgram: tokenProgramAddress,
    });

    const approveIx = getApproveInstruction(
      {
        source: sourceATA,
        delegate,
        owner: this.signer,
      },
      {
        amount: BigInt(paymentRequirements.amount),
        programAddress: tokenProgramAddress,
      },
    );

    // Facilitator must provide feePayer to cover transaction fees
    const feePayer = paymentRequirements.extra?.feePayer as Address;
    if (!feePayer) {
      throw new Error("feePayer is required in paymentRequirements.extra for SVM transactions");
    }

    const latestBlockhash = await resolveBlockhash(rpc, paymentRequirements);

    const sellerMemo = paymentRequirements.extra?.memo as string | undefined;
    let memoData: Uint8Array;
    if (sellerMemo) {
      memoData = new TextEncoder().encode(sellerMemo);
      if (memoData.byteLength > MAX_MEMO_BYTES) {
        throw new Error(`extra.memo exceeds maximum ${MAX_MEMO_BYTES} bytes`);
      }
    } else {
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      memoData = new TextEncoder().encode(
        Array.from(nonce)
          .map(b => b.toString(16).padStart(2, "0"))
          .join(""),
      );
    }
    const memoIx = {
      programAddress: MEMO_PROGRAM_ADDRESS as Address,
      accounts: [] as const,
      data: memoData,
    };

    const budget = {
      computeUnitLimit: DEFAULT_COMPUTE_UNIT_LIMIT,
      computeUnitPriceMicroLamports: DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    };
    const tx = pipe(
      createTransactionMessage({ version: transactionVersion }),
      tx => applyTransactionV1Config(transactionVersion, budget, tx),
      tx => setTransactionMessageFeePayer(feePayer, tx),
      tx =>
        appendTransactionMessageInstructions(
          [...computeBudgetInstructions(transactionVersion, budget), approveIx, memoIx],
          tx,
        ),
      tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    );

    const signedTransaction = await partiallySignTransactionMessageWithSigners(tx);
    const base64EncodedWireTransaction = getBase64EncodedWireTransaction(signedTransaction);

    const payload: AuthCaptureSvmPayloadV2 = {
      transaction: base64EncodedWireTransaction,
      delegate,
    };

    return {
      x402Version,
      payload,
    };
  }
}
