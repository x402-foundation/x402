import { getBase58Encoder, type MessageSigner, type TransactionSigner } from "@solana/kit";
import { verifyEd25519Signature } from "../../payment-channels/voucher";
import type { BatchClientSigner } from "./channel";

/**
 * Adapt a connected Kit wallet signer to the batch client's message interface.
 * Keeps transaction signing behavior and verifies messages against independent
 * copies of the requested bytes, including when a wallet echoes incorrect content.
 *
 * @param wallet - Connected wallet with transaction and message signing features
 * @returns Signer suitable for BatchSvmScheme and the channel helpers
 */
export function toBatchClientSigner(wallet: TransactionSigner & MessageSigner): BatchClientSigner {
  const address = wallet.address;
  // Preserve at least one required transaction capability without spreading an
  // unverified message method (including methods defined on a class prototype).
  const transactions: TransactionSigner =
    "signTransactions" in wallet
      ? { address, signTransactions: wallet.signTransactions.bind(wallet) }
      : "modifyAndSignTransactions" in wallet
        ? { address, modifyAndSignTransactions: wallet.modifyAndSignTransactions.bind(wallet) }
        : { address, signAndSendTransactions: wallet.signAndSendTransactions.bind(wallet) };
  return {
    ...transactions,
    address,
    ...("signTransactions" in wallet
      ? { signTransactions: wallet.signTransactions.bind(wallet) }
      : {}),
    ...("modifyAndSignTransactions" in wallet
      ? { modifyAndSignTransactions: wallet.modifyAndSignTransactions.bind(wallet) }
      : {}),
    ...("signAndSendTransactions" in wallet
      ? { signAndSendTransactions: wallet.signAndSendTransactions.bind(wallet) }
      : {}),
    signMessages: async (messages, config) => {
      const originals = messages.map(message => new Uint8Array(message.content));
      const inputs = messages.map((message, i) => ({
        ...message,
        content: new Uint8Array(originals[i]),
      }));
      let signatures;
      if ("signMessages" in wallet) {
        signatures = await wallet.signMessages(inputs, config);
      } else if ("modifyAndSignMessages" in wallet) {
        const signed = await wallet.modifyAndSignMessages(inputs, config);
        if (
          signed.length !== originals.length ||
          signed.some(
            (message, i) =>
              message.content.length !== originals[i].length ||
              message.content.some((byte, j) => byte !== originals[i][j]),
          )
        ) {
          throw new Error(
            "The wallet modified the batch authorization message. No proof was created.",
          );
        }
        signatures = signed.map(message => message.signatures);
      } else {
        throw new Error("The connected wallet does not support message signing.");
      }
      if (signatures.length !== originals.length) {
        throw new Error("The wallet returned incomplete batch authorization signatures.");
      }
      const publicKey = getBase58Encoder().encode(address);
      for (let i = 0; i < originals.length; i++) {
        const signature = signatures[i][address];
        if (
          !signature ||
          !(await verifyEd25519Signature({
            message: originals[i],
            publicKey: new Uint8Array(publicKey),
            signature,
          }))
        ) {
          throw new Error(
            "The wallet signature does not verify against the original batch authorization bytes.",
          );
        }
      }
      return signatures;
    },
  };
}
