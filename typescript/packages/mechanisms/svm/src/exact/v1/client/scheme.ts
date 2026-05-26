import {
  getSetComputeUnitLimitInstruction,
  setTransactionMessageComputeUnitPrice,
} from "@solana-program/compute-budget";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  fetchMint,
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  prependTransactionMessageInstruction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from "@solana/kit";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { PaymentRequirementsV1 } from "@x402/core/types/v1";
import {
  DEFAULT_COMPUTE_UNIT_LIMIT,
  DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ADDRESS,
} from "../../../constants";
import type { ClientSvmConfig, ClientSvmSigner } from "../../../signer";
import type { ExactSvmPayloadV1 } from "../../../types";
import { createRpcClient } from "../../../utils";

/**
 * SVM client implementation for the Exact payment scheme (V1).
 */
export class ExactSvmSchemeV1 implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a new ExactSvmClientV1 instance.
   *
   * @param signer - The SVM signer for client operations
   * @param config - Optional configuration with custom RPC URL
   * @returns ExactSvmClientV1 instance
   */
  constructor(
    private readonly signer: ClientSvmSigner,
    private readonly config?: ClientSvmConfig,
  ) {}

  /**
   * Creates a payment payload for the Exact scheme (V1).
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements
   * @returns Promise resolving to a payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<
    Pick<PaymentPayload, "x402Version" | "payload"> & { scheme: string; network: Network }
  > {
    const selectedV1 = paymentRequirements as unknown as PaymentRequirementsV1;
    const rpc = createRpcClient(selectedV1.network, this.config?.rpcUrl);

    const tokenMint = await fetchMint(rpc, selectedV1.asset as Address);
    const tokenProgramAddress = tokenMint.programAddress;

    if (
      tokenProgramAddress.toString() !== TOKEN_PROGRAM_ADDRESS.toString() &&
      tokenProgramAddress.toString() !== TOKEN_2022_PROGRAM_ADDRESS.toString()
    ) {
      throw new Error("Asset was not created by a known token program");
    }

    const [sourceATA] = await findAssociatedTokenPda({
      mint: selectedV1.asset as Address,
      owner: this.signer.address,
      tokenProgram: tokenProgramAddress,
    });

    const [destinationATA] = await findAssociatedTokenPda({
      mint: selectedV1.asset as Address,
      owner: selectedV1.payTo as Address,
      tokenProgram: tokenProgramAddress,
    });

    const transferIx = getTransferCheckedInstruction(
      {
        source: sourceATA,
        mint: selectedV1.asset as Address,
        destination: destinationATA,
        authority: this.signer,
        amount: BigInt(selectedV1.maxAmountRequired),
        decimals: tokenMint.data.decimals,
      },
      { programAddress: tokenProgramAddress },
    );

    // Facilitator must provide feePayer to cover transaction fees
    const feePayer = selectedV1.extra?.feePayer as Address;
    if (!feePayer) {
      throw new Error("feePayer is required in paymentRequirements.extra for SVM transactions");
    }

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const sellerMemo = selectedV1.extra?.memo as string | undefined;
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

    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      tx => setTransactionMessageComputeUnitPrice(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS, tx),
      tx => setTransactionMessageFeePayer(feePayer, tx),
      tx =>
        prependTransactionMessageInstruction(
          getSetComputeUnitLimitInstruction({ units: DEFAULT_COMPUTE_UNIT_LIMIT }),
          tx,
        ),
      tx => appendTransactionMessageInstructions([transferIx, memoIx], tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    );

    const signedTransaction = await partiallySignTransactionMessageWithSigners(tx);
    const base64EncodedWireTransaction = getBase64EncodedWireTransaction(signedTransaction);

    const payload: ExactSvmPayloadV1 = {
      transaction: base64EncodedWireTransaction,
    };

    return {
      x402Version,
      scheme: selectedV1.scheme,
      network: selectedV1.network,
      payload,
    };
  }
}
