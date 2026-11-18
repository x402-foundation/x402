import type { KeyPairString } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import {
  actionCreators,
  buildDelegateAction,
  type DelegateAction,
  encodeSignedDelegate,
} from "@near-js/transactions";
import { DEFAULT_FT_TRANSFER_GAS, FT_TRANSFER_METHOD, ONE_YOCTO } from "../constants";
import type { ClientNearSigner, NearSignedDelegateInput } from "../signer";
import { computeTimeoutBlocks, toBase64 } from "../utils";
import { type RpcUrlOverrides, createProviderFactory } from "./provider";

/**
 * Configuration for the reference NEAR client signer.
 */
export type ClientNearSignerConfig = {
  /** Payer account ID (must own the full-access key below). */
  accountId: string;
  /** Full-access secret key, e.g. `ed25519:...` or `secp256k1:...`. */
  secretKey: KeyPairString;
  /** Optional per-network RPC endpoint overrides. */
  rpcUrls?: RpcUrlOverrides;
  /** Sponsored gas attached to the delegated `ft_transfer` (default 30 TGas). */
  gas?: bigint;
};

/**
 * Reference {@link ClientNearSigner} backed by NEAR JSON-RPC and a local key.
 *
 * It reads the access-key nonce and current block height, applies the
 * deterministic timeout mapping (spec §5) to set `max_block_height`, builds the
 * single `ft_transfer` delegate action with `1` yoctoNEAR attached, signs the
 * NEP-366 `SignedDelegate`, and returns it as base64 Borsh.
 *
 * @param config - Account, key, and optional RPC/gas configuration.
 * @returns A client signer suitable for {@link ExactNearScheme} on the client.
 */
export function createClientNearSigner(config: ClientNearSignerConfig): ClientNearSigner {
  const signer = KeyPairSigner.fromSecretKey(config.secretKey);
  const getProvider = createProviderFactory(config.rpcUrls);
  const gas = config.gas ?? DEFAULT_FT_TRANSFER_GAS;

  return {
    async createSignedDelegateAction(input: NearSignedDelegateInput): Promise<string> {
      const req = input.paymentRequirements;
      const provider = getProvider(req.network);
      const publicKey = await signer.getPublicKey();

      const [accessKey, block] = await Promise.all([
        provider.viewAccessKey(config.accountId, publicKey, { finality: "final" }),
        provider.block({ finality: "final" }),
      ]);

      const nonce = BigInt(accessKey.nonce) + 1n;
      const maxBlockHeight =
        BigInt(block.header.height) + computeTimeoutBlocks(req.maxTimeoutSeconds);

      const transfer = actionCreators.functionCall(
        FT_TRANSFER_METHOD,
        { receiver_id: req.payTo, amount: req.amount },
        gas,
        ONE_YOCTO,
      );

      const delegateAction = buildDelegateAction({
        actions: [transfer],
        maxBlockHeight,
        nonce,
        publicKey,
        receiverId: req.asset,
        senderId: config.accountId,
      } as DelegateAction);

      const [, signedDelegate] = await signer.signDelegateAction(delegateAction);
      return toBase64(encodeSignedDelegate(signedDelegate));
    },
  };
}
