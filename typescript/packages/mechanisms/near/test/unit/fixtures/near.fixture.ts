import { KeyPair } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import {
  type Action,
  actionCreators,
  buildDelegateAction,
  encodeSignedDelegate,
} from "@near-js/transactions";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  DEFAULT_FT_TRANSFER_GAS,
  EMPTY_CONTRACT_CODE_HASH,
  ONE_YOCTO,
} from "../../../src/constants";
import type { FacilitatorNearSigner, NearStorageBalanceResult } from "../../../src/signer";
import type { NearAccessKeyView, NearAccountView, NearSettlementOutcome } from "../../../src/types";
import { fromBase64, toBase64 } from "../../../src/utils";

/** A non-empty, deployed-contract code hash for mocked `view_account`. */
export const NONEMPTY_CODE_HASH = "11111111111111111111111111111112";

/**
 * Canonical happy-path requirement values, chosen to pass every check against
 * {@link mockFacilitatorSigner}'s defaults (block height 1000, key nonce 0).
 */
export const FIXTURE = {
  network: "near:testnet" as const,
  asset: "usdc.testnet",
  payTo: "merchant.testnet",
  amount: "1000000",
  senderId: "alice.testnet",
  maxTimeoutSeconds: 60,
  nonce: 5n,
  maxBlockHeight: 1060n,
};

/**
 * Options for building a (possibly malformed) signed delegate action fixture.
 */
export type DelegateFixtureOptions = {
  senderId?: string;
  receiverId?: string; // delegate receiver = token contract
  curve?: "ed25519" | "secp256k1";
  keyPair?: KeyPair;
  methodName?: string;
  ftReceiver?: string; // ft_transfer args.receiver_id = payTo
  amount?: string;
  deposit?: bigint;
  gas?: bigint;
  nonce?: bigint;
  maxBlockHeight?: bigint;
  /** Replace the action list entirely (e.g. extra actions, wrong action kind). */
  actions?: Action[];
};

/**
 * Builds a base64 Borsh `SignedDelegate` for tests using real NEAR signing.
 *
 * @param options - Overrides for the delegate action fields.
 * @returns The base64 payload, the public-key string, and the signing key pair.
 */
export async function buildSignedDelegateB64(
  options: DelegateFixtureOptions = {},
): Promise<{ b64: string; publicKey: string; keyPair: KeyPair }> {
  const keyPair = options.keyPair ?? KeyPair.fromRandom(options.curve ?? "ed25519");
  const signer = new KeyPairSigner(keyPair);
  const publicKey = keyPair.getPublicKey();

  const actions = options.actions ?? [
    actionCreators.functionCall(
      options.methodName ?? "ft_transfer",
      {
        receiver_id: options.ftReceiver ?? FIXTURE.payTo,
        amount: options.amount ?? FIXTURE.amount,
      },
      options.gas ?? DEFAULT_FT_TRANSFER_GAS,
      options.deposit ?? ONE_YOCTO,
    ),
  ];

  const delegateAction = buildDelegateAction({
    actions,
    maxBlockHeight: options.maxBlockHeight ?? FIXTURE.maxBlockHeight,
    nonce: options.nonce ?? FIXTURE.nonce,
    publicKey,
    receiverId: options.receiverId ?? FIXTURE.asset,
    senderId: options.senderId ?? FIXTURE.senderId,
  } as any);

  const [, signedDelegate] = await signer.signDelegateAction(delegateAction);
  return {
    b64: toBase64(encodeSignedDelegate(signedDelegate)),
    publicKey: publicKey.toString(),
    keyPair,
  };
}

/**
 * Corrupts the final byte (inside the signature) of a base64 `SignedDelegate`,
 * yielding a structurally valid payload whose signature no longer verifies.
 *
 * @param b64 - A valid base64 `SignedDelegate`.
 * @returns A payload with a tampered signature.
 */
export function tamperSignature(b64: string): string {
  const bytes = fromBase64(b64);
  bytes[bytes.length - 1] ^= 0xff;
  return toBase64(bytes);
}

/**
 * Builds payment requirements aligned with {@link FIXTURE}.
 *
 * @param overrides - Field overrides.
 * @returns Payment requirements.
 */
export function makeRequirements(
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  return {
    scheme: "exact",
    network: FIXTURE.network,
    asset: FIXTURE.asset,
    payTo: FIXTURE.payTo,
    amount: FIXTURE.amount,
    maxTimeoutSeconds: FIXTURE.maxTimeoutSeconds,
    extra: {},
    ...overrides,
  } as PaymentRequirements;
}

/**
 * Builds a v2 payment payload wrapping the signed delegate action.
 *
 * @param signedDelegateAction - base64 Borsh `SignedDelegate`.
 * @param requirements - Accepted payment requirements.
 * @returns Payment payload.
 */
export function makePayload(
  signedDelegateAction: string,
  requirements: PaymentRequirements,
): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { signedDelegateAction },
  } as any;
}

/**
 * Overrides for {@link mockFacilitatorSigner}.
 */
export type MockSignerOptions = {
  relayerIds?: string[];
  blockHeight?: bigint;
  accessKey?: NearAccessKeyView | null;
  accessKeyError?: Error;
  blockHeightError?: Error;
  accounts?: Record<string, NearAccountView | null>;
  balance?: bigint;
  balanceError?: Error;
  storage?: NearStorageBalanceResult;
  outcome?: NearSettlementOutcome;
  submitError?: Error;
  onSubmit?: () => void;
};

/**
 * Builds a mocked {@link FacilitatorNearSigner} whose defaults make the
 * canonical {@link FIXTURE} payload verify and settle successfully.
 *
 * @param options - Per-method overrides.
 * @returns A mock facilitator signer.
 */
export function mockFacilitatorSigner(options: MockSignerOptions = {}): FacilitatorNearSigner {
  return {
    getRelayerIds: () => options.relayerIds ?? ["relayer.testnet"],
    getCurrentBlockHeight: async () => {
      if (options.blockHeightError) throw options.blockHeightError;
      return options.blockHeight ?? 1000n;
    },
    viewAccount: async ({ accountId }) => {
      if (options.accounts && accountId in options.accounts) {
        return options.accounts[accountId];
      }
      return { codeHash: NONEMPTY_CODE_HASH };
    },
    viewAccessKey: async () => {
      if (options.accessKeyError) throw options.accessKeyError;
      return options.accessKey === undefined
        ? { nonce: 0n, permissionKind: "FullAccess" }
        : options.accessKey;
    },
    ftBalanceOf: async () => {
      if (options.balanceError) throw options.balanceError;
      return options.balance ?? 10_000_000n;
    },
    storageBalanceOf: async () => options.storage ?? { supported: true, registered: true },
    submitSignedDelegateAction: async () => {
      options.onSubmit?.();
      if (options.submitError) throw options.submitError;
      return (
        options.outcome ?? {
          transaction: "FIXTURETX",
          innerReceipt: { kind: "success", value: "" },
        }
      );
    },
  };
}

export { EMPTY_CONTRACT_CODE_HASH };
