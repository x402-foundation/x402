import { randomBytes } from "node:crypto";
import {
  createHederaResolveEvmAddress,
  HBAR_ASSET_ID,
  HEDERA_MAINNET_CAIP2,
  HEDERA_TESTNET_CAIP2,
  mirrorNodeUrlForNetwork,
  type ClientHederaSigner,
  type PrivateKey,
} from "@x402/hedera";
import type { PaymentRequirements } from "@x402/core/types";

type EnvLookup = (key: string) => string | undefined;

/** EVM chain id of each Hedera network, as `block.chainid` returns it. */
const CHAIN_IDS: Record<string, number> = {
  [HEDERA_MAINNET_CAIP2]: 295,
  [HEDERA_TESTNET_CAIP2]: 296,
};

/** `bytes32("SignedOwnerExecutor.v1")`: ASCII, left-aligned, zero-padded. */
const SIGNED_OWNER_DOMAIN = Buffer.from("SignedOwnerExecutor.v1").toString("hex").padEnd(64, "0");

/**
 * Adds the `transferExecutor` authorization hook to the e2e Hedera client signer.
 *
 * The authorization format belongs to the executor. The hook supports two sources:
 *
 * - `HEDERA_TE_AUTHORIZATION` set: handed over as given, for any executor. It is single-use: the
 *   executor consumes it on the first successful settlement, so one value pays one scenario.
 * - Unset: the hook signs a fresh `SignedOwnerExecutor` authorization for each payment with
 *   `CLIENT_HEDERA_PRIVATE_KEY`. The executor must be a `SignedOwnerExecutor` (see
 *   `typescript/packages/mechanisms/hedera/test/integrations/mock-executor`) that the client
 *   account granted an HBAR allowance (`pnpm hedera:te:setup`). HBAR only.
 *
 * `HEDERA_TE_PAYER_ACCOUNT_ID` (default `CLIENT_HEDERA_ACCOUNT_ID`) becomes `payload.payer`. A
 * signed authorization only works for the client account, so the hook rejects another payer.
 *
 * @param signer - The `cryptoTransfer` signer built from `CLIENT_HEDERA_*`
 * @param clientKey - The client account's ECDSA key, which signs `SignedOwnerExecutor` authorizations
 * @param env - Env lookup
 * @returns The signer, with the hook when `HEDERA_TE_EXECUTOR_ID` is set
 */
export function withTransferExecutorAuthorization(
  signer: ClientHederaSigner,
  clientKey: PrivateKey,
  env: EnvLookup = key => process.env[key],
): ClientHederaSigner {
  const executor = env("HEDERA_TE_EXECUTOR_ID")?.trim();
  if (!executor) {
    return signer;
  }
  const payer = env("HEDERA_TE_PAYER_ACCOUNT_ID")?.trim() || signer.accountId;
  return {
    ...signer,
    accountId: payer,
    createTransferExecutorAuthorization: async requirements => {
      const authorization = env("HEDERA_TE_AUTHORIZATION")?.trim();
      if (authorization) {
        return { executor, authorization };
      }
      if (payer !== signer.accountId) {
        throw new Error(
          `HEDERA_TE_PAYER_ACCOUNT_ID (${payer}) differs from CLIENT_HEDERA_ACCOUNT_ID ` +
            `(${signer.accountId}): the client key can only sign for its own account. ` +
            "Unset it, or set HEDERA_TE_AUTHORIZATION",
        );
      }
      return {
        executor,
        authorization: await signSignedOwnerAuthorization({
          executor,
          payer,
          key: clientKey,
          requirements,
          mirrorNodeUrl: env("HEDERA_MIRROR_NODE_URL")?.trim() || undefined,
        }),
      };
    },
  };
}

/**
 * Builds and signs a `SignedOwnerExecutor` authorization for one payment.
 *
 * authorization = abi.encode(uint256 validBefore, bytes32 nonce, bytes pubKey, bytes signature)
 *
 * `signature` is the key's ECDSA signature (r || s) over keccak256 of
 * `abi.encode(DOMAIN, from, asset, to, amount, validBefore, nonce, chainid, executor)`. `from`
 * and `to` are the Mirror Node's `evm_address` of the payer and `payTo`, the same addresses the
 * facilitator passes to `executeTransfer`.
 *
 * @param params - What to sign
 * @param params.executor - Executor contract id
 * @param params.payer - Payer account id, owner of `key`
 * @param params.key - Payer's ECDSA key
 * @param params.requirements - The `transferExecutor` requirements being paid
 * @param params.mirrorNodeUrl - Mirror Node base URL; defaults to the network's public one
 * @returns 0x-hex authorization
 */
export async function signSignedOwnerAuthorization(params: {
  executor: string;
  payer: string;
  key: PrivateKey;
  requirements: PaymentRequirements;
  mirrorNodeUrl?: string;
}): Promise<string> {
  const { executor, payer, key, requirements } = params;
  if (requirements.asset !== HBAR_ASSET_ID) {
    throw new Error(
      `SignedOwnerExecutor pays HBAR only, the route quotes asset ${requirements.asset}. ` +
        "Set HEDERA_TE_AUTHORIZATION to pay another asset with another executor",
    );
  }
  const chainId = CHAIN_IDS[requirements.network];
  if (chainId === undefined) {
    throw new Error(`Unsupported Hedera network: ${requirements.network}`);
  }
  const mirrorNodeUrl = (params.mirrorNodeUrl ?? mirrorNodeUrlForNetwork(requirements.network))
    .replace(/\/+$/, "");
  const resolve = createHederaResolveEvmAddress({ mirrorNodeUrl });
  const [from, to, executorAddress] = await Promise.all([
    resolve({ account: payer, network: requirements.network }),
    resolve({ account: requirements.payTo, network: requirements.network }),
    contractEvmAddress(mirrorNodeUrl, executor),
  ]);
  if (!from || !to) {
    throw new Error(`Mirror Node has no EVM address for ${!from ? payer : requirements.payTo}`);
  }

  const validBefore = BigInt(Math.floor(Date.now() / 1000) + requirements.maxTimeoutSeconds);
  const nonce = randomBytes(32).toString("hex");
  const digest = Buffer.from(
    SIGNED_OWNER_DOMAIN +
      addressWord(from.evmAddress) +
      word("0") + // asset: address(0) for HBAR
      addressWord(to.evmAddress) +
      word(BigInt(requirements.amount).toString(16)) +
      word(validBefore.toString(16)) +
      nonce +
      word(chainId.toString(16)) +
      addressWord(executorAddress),
    "hex",
  );
  // The Hiero SDK's ECDSA `sign` hashes with keccak256 and returns r || s.
  const signature = Buffer.from(key.sign(digest)).toString("hex");
  const pubKey = Buffer.from(key.publicKey.toBytesRaw()).toString("hex");
  if (pubKey.length !== 66 || signature.length !== 128) {
    throw new Error("SignedOwnerExecutor needs a secp256k1 (ECDSA) client key");
  }

  return (
    "0x" +
    word(validBefore.toString(16)) +
    nonce +
    word("80") + // offset of pubKey: four head words
    word("e0") + // offset of signature: 0x80 + length word + 33 bytes padded to 64
    word("21") + // pubKey length: 33
    pubKey.padEnd(128, "0") +
    word("40") + // signature length: 64
    signature
  );
}

/**
 * Returns the EVM address of a contract, as `address(this)` sees it.
 *
 * @param mirrorNodeUrl - Mirror Node base URL, without a trailing slash
 * @param contractId - Contract id
 * @returns 0x-hex address
 */
async function contractEvmAddress(mirrorNodeUrl: string, contractId: string): Promise<string> {
  const response = await fetch(`${mirrorNodeUrl}/api/v1/contracts/${encodeURIComponent(contractId)}`);
  if (!response.ok) {
    throw new Error(`Mirror Node: contract ${contractId} -> HTTP ${response.status}`);
  }
  const { evm_address } = (await response.json()) as { evm_address?: string };
  if (!evm_address) {
    throw new Error(`Mirror Node returned no evm_address for contract ${contractId}`);
  }
  return evm_address;
}

/**
 * Left-pads hex digits to one ABI word.
 *
 * @param hex - Hex digits without a prefix
 * @returns 64 hex characters
 */
function word(hex: string): string {
  return hex.padStart(64, "0");
}

/**
 * ABI-encodes an address as one word.
 *
 * @param address - 0x-hex address
 * @returns 64 hex characters
 */
function addressWord(address: string): string {
  return word(address.replace(/^0x/, "").toLowerCase());
}
