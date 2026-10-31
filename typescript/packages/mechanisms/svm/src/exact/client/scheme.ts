import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import {
  ATA_CREATION_COMPUTE_UNITS,
  DEFAULT_COMPUTE_UNIT_LIMIT,
  DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ADDRESS,
  SPLIT_TRANSFER_COMPUTE_UNITS,
} from "../../constants";
import type { ClientSvmConfig, ClientSvmSigner } from "../../signer";
import type { ExactSvmPayloadV2 } from "../../types";
import {
  applyTransactionV1Config,
  computeBudgetInstructions,
  maxTransactionSize,
} from "../../transactionV1";
import { createRpcClient, resolveBlockhash, resolveTransactionVersion } from "../../utils";
import { getCachedMintMetadata, type MintMetadataCache } from "../../mint-cache";
import { findDefaultAsset } from "../../defaultAssets";
import { getSplits, parsePaymentLegs } from "../splits";

/**
 * SVM client implementation for the Exact payment scheme.
 */
export class ExactSvmScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  findDefaultAsset = findDefaultAsset;
  private readonly mintCache: MintMetadataCache = new Map();

  /**
   * Creates a new ExactSvmClient instance.
   *
   * @param signer - The SVM signer for client operations
   * @param config - Optional configuration with custom RPC URL
   * @returns ExactSvmClient instance
   */
  constructor(
    private readonly signer: ClientSvmSigner,
    private readonly config?: ClientSvmConfig,
  ) {}

  /**
   * Creates a payment payload for the Exact scheme.
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

    // Validate splits before any other RPC work, and obtain consent for them
    // (§5.6). Without splits this is a single leg of the full amount.
    const legs = parsePaymentLegs(paymentRequirements);
    const splits = getSplits(paymentRequirements);
    if (splits.length > 0) {
      if (!this.config?.approveSplits) {
        throw new Error(
          "Payment requirements carry extra.splits; set approveSplits in the client config to consent to them",
        );
      }
      const approved = await this.config.approveSplits(
        splits.map(({ payTo, amount, memo }) => ({ payTo, amount, memo })),
        {
          payTo: paymentRequirements.payTo,
          primaryAmount: legs[0].amount.toString(),
          requirements: paymentRequirements,
        },
      );
      if (!approved) {
        throw new Error("Splits in the payment requirements were not approved");
      }
    }

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

    const [sourceATA] = await findAssociatedTokenPda({
      mint: paymentRequirements.asset as Address,
      owner: this.signer.address,
      tokenProgram: tokenProgramAddress,
    });

    // Facilitator must provide feePayer to cover transaction fees
    const feePayer = paymentRequirements.extra?.feePayer as Address;
    if (!feePayer) {
      throw new Error("feePayer is required in paymentRequirements.extra for SVM transactions");
    }

    // One TransferChecked per leg: the primary remainder to payTo, then each
    // split in extra.splits order (§5.7). A recipient marked
    // ataCreationRequired gets a fee-payer-funded CreateIdempotent unless its
    // ATA is confirmed to exist (§5.4).
    // One signer instance: kit rejects distinct signers for the same address.
    const feePayerSigner = createNoopSigner(feePayer);
    const createIxs: ReturnType<typeof getCreateAssociatedTokenIdempotentInstruction>[] = [];
    const transferIxs: ReturnType<typeof getTransferCheckedInstruction>[] = [];
    for (const leg of legs) {
      const [destinationATA] = await findAssociatedTokenPda({
        mint: paymentRequirements.asset as Address,
        owner: leg.owner as Address,
        tokenProgram: tokenProgramAddress,
      });
      if (leg.ataCreationRequired && !(await this.accountExists(rpc, destinationATA))) {
        createIxs.push(
          getCreateAssociatedTokenIdempotentInstruction({
            payer: feePayerSigner,
            ata: destinationATA,
            owner: leg.owner as Address,
            mint: paymentRequirements.asset as Address,
            tokenProgram: tokenProgramAddress,
          }),
        );
      }
      transferIxs.push(
        getTransferCheckedInstruction(
          {
            source: sourceATA,
            mint: paymentRequirements.asset as Address,
            destination: destinationATA,
            authority: this.signer,
            amount: leg.amount,
            decimals: mintMetadata.decimals,
          },
          { programAddress: tokenProgramAddress },
        ),
      );
    }
    const computeUnitLimit =
      DEFAULT_COMPUTE_UNIT_LIMIT +
      (legs.length - 1) * SPLIT_TRANSFER_COMPUTE_UNITS +
      createIxs.length * ATA_CREATION_COMPUTE_UNITS;

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

    // Version 0 carries the budget as a ComputeBudget instruction prefix;
    // version 1 carries it in the message config and has no such prefix.
    const budget = {
      computeUnitLimit,
      computeUnitPriceMicroLamports: DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    };
    const tx = pipe(
      createTransactionMessage({ version: transactionVersion }),
      tx => applyTransactionV1Config(transactionVersion, budget, tx),
      tx => setTransactionMessageFeePayer(feePayer, tx),
      tx =>
        appendTransactionMessageInstructions(
          [
            ...computeBudgetInstructions(transactionVersion, budget),
            ...createIxs,
            ...transferIxs,
            memoIx,
          ],
          tx,
        ),
      tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    );

    const signedTransaction = await partiallySignTransactionMessageWithSigners(tx);
    // Each split adds a transfer and possibly an ATA creation (§5.2); fail
    // here with the reason rather than send a transaction that cannot land.
    const size = getTransactionEncoder().encode(signedTransaction).byteLength;
    const sizeLimit = maxTransactionSize(transactionVersion);
    if (size > sizeLimit) {
      throw new Error(
        `Transaction is ${size} bytes, over the ${sizeLimit}-byte limit; reduce extra.splits or ATA creations`,
      );
    }
    const base64EncodedWireTransaction = getBase64EncodedWireTransaction(signedTransaction);

    const payload: ExactSvmPayloadV2 = {
      transaction: base64EncodedWireTransaction,
    };

    return {
      x402Version,
      payload,
    };
  }

  /**
   * Whether an account exists. An RPC failure counts as "not confirmed", so
   * the caller includes the idempotent creation rather than risk a transfer to
   * a missing ATA.
   *
   * @param rpc - RPC client
   * @param address - Account to look up
   * @returns True only when the account is confirmed to exist
   */
  private async accountExists(
    rpc: ReturnType<typeof createRpcClient>,
    address: Address,
  ): Promise<boolean> {
    try {
      const { value } = await rpc.getAccountInfo(address, { encoding: "base64" }).send();
      return value !== null;
    } catch {
      return false;
    }
  }
}
