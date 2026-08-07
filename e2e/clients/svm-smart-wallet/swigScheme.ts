import {
  getSetComputeUnitLimitInstruction,
  setTransactionMessageComputeUnitPrice,
} from "@solana-program/compute-budget";
import {
  fetchMint,
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  prependTransactionMessageInstruction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { fetchSwig, getSignInstructions, getSwigWalletAddress } from "@swig-wallet/kit";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const MAX_MEMO_BYTES = 256;
const SMART_WALLET_COMPUTE_UNIT_LIMIT = 200_000;
const SMART_WALLET_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 10_000n;

/**
 * x402 Exact client that builds Swig smart-wallet payment transactions.
 * Routes token transfers through Swig so the facilitator exercises SVM Path 2
 * (simulation-based smart wallet verification).
 *
 * Expects Swig account setup to be done by `e2e/scripts/swig-setup.ts` (run
 * automatically before each svm-smart-wallet endpoint when USDC balance is low).
 */
export class ExactSwigSvmScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * @param authority - Ed25519 signer for the Swig root role
   * @param swigAccountAddress - Swig account PDA (from SWIG_ACCOUNT_ADDRESS)
   * @param rpcUrl - Optional Solana RPC URL override
   */
  constructor(
    private readonly authority: KeyPairSigner,
    private readonly swigAccountAddress: Address,
    private readonly rpcUrl?: string,
  ) {}

  /**
   * Creates a Swig-signed payment payload with facilitator fee sponsorship.
   *
   * @param x402Version - x402 protocol version
   * @param paymentRequirements - Accepted payment requirements from the 402 response
   * @returns Payment payload containing a base64-encoded transaction
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const rpc = createSolanaRpc(this.rpcUrl ?? DEVNET_RPC_URL);
    const mint = paymentRequirements.asset as Address;
    const amount = BigInt(paymentRequirements.amount);
    const payTo = paymentRequirements.payTo as Address;

    const swig = await fetchSwig(rpc as never, this.swigAccountAddress);
    const swigWalletAddress = await getSwigWalletAddress(swig);
    const rootRole = swig.findRolesByEd25519SignerPk(this.authority.address)[0];
    if (!rootRole) {
      throw new Error("Swig root role not found for authority");
    }

    const mintInfo = await fetchMint(rpc, mint);
    const tokenProgram = mintInfo.programAddress;

    const [sourceAta] = await findAssociatedTokenPda({
      mint,
      owner: swigWalletAddress,
      tokenProgram,
    });
    const [destinationAta] = await findAssociatedTokenPda({
      mint,
      owner: payTo,
      tokenProgram,
    });

    try {
      const swigBalance = await rpc.getTokenAccountBalance(sourceAta).send();
      if (BigInt(swigBalance.value.amount) < amount) {
        throw new Error(
          "Swig wallet USDC balance too low for payment. The e2e harness tops up automatically before each endpoint " +
            "or run `pnpm swig:setup` from e2e/.",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Swig wallet USDC")) {
        throw error;
      }
      throw new Error(
        "Swig wallet token account missing or unfunded. Run `pnpm swig:setup` from e2e/ first.",
      );
    }

    const transferIx = getTransferCheckedInstruction(
      {
        source: sourceAta,
        mint,
        destination: destinationAta,
        authority: swigWalletAddress,
        amount,
        decimals: mintInfo.data.decimals,
      },
      { programAddress: tokenProgram },
    );

    const feePayer = paymentRequirements.extra?.feePayer as Address | undefined;
    if (!feePayer) {
      throw new Error("feePayer is required in paymentRequirements.extra for SVM transactions");
    }

    const refreshedSwig = await fetchSwig(rpc as never, this.swigAccountAddress);
    const signIxs = (await getSignInstructions(refreshedSwig, rootRole.id, [
      transferIx as never,
    ])) as Instruction[];

    const sellerMemo = paymentRequirements.extra?.memo as string | undefined;
    let memoData: Uint8Array;
    if (sellerMemo) {
      memoData = new TextEncoder().encode(sellerMemo);
      if (memoData.byteLength > MAX_MEMO_BYTES) {
        throw new Error(`extra.memo exceeds maximum ${MAX_MEMO_BYTES} bytes`);
      }
    } else {
      memoData = new TextEncoder().encode(
        Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map(b => b.toString(16).padStart(2, "0"))
          .join(""),
      );
    }

    const memoIx: Instruction = {
      programAddress: MEMO_PROGRAM_ADDRESS,
      accounts: [],
      data: memoData,
    };

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      message =>
        setTransactionMessageComputeUnitPrice(
          SMART_WALLET_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
          message,
        ),
      message => setTransactionMessageFeePayer(feePayer, message),
      message =>
        prependTransactionMessageInstruction(
          getSetComputeUnitLimitInstruction({ units: SMART_WALLET_COMPUTE_UNIT_LIMIT }),
          message,
        ),
      message => appendTransactionMessageInstructions([...signIxs, memoIx], message),
      message => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
      message => addSignersToTransactionMessage([this.authority], message),
    );

    const signedTransaction = await partiallySignTransactionMessageWithSigners(tx);
    const base64EncodedWireTransaction = getBase64EncodedWireTransaction(signedTransaction);

    return {
      x402Version,
      payload: {
        transaction: base64EncodedWireTransaction,
      },
    };
  }
}
