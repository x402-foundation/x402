import {
  hashTypedData,
  recoverAddress,
  isAddressEqual,
  getAddress,
  parseErc6492Signature,
  size,
} from "viem";
import type { Hex, TypedDataDomain } from "viem";
import type { FacilitatorEvmSigner } from "../signer";
import { isContractRevert } from "./revert";

/**
 * Parsed ERC-6492 classification for a payer address.
 *
 * `isCounterfactual` is true when the payment comes from an undeployed smart wallet
 * (ERC-6492 wrapper present, no bytecode at the payer address yet). In this case
 * pre-verification of the signature is deferred to on-chain simulation or settle.
 */
export type Erc6492Classification = {
  isCounterfactual: boolean;
  isDeployedAtPayer: boolean;
  hasDeploymentInfo: boolean;
  innerSignature: `0x${string}`;
  eip6492Deployment?: { factoryAddress: `0x${string}`; factoryCalldata: `0x${string}` };
  /**
   * Bytecode from the payer `eth_getCode`. `"0x"` is an EOA. Undefined when the lookup failed
   * or returned nothing. Reuse this for signature checks so verify does not issue a second lookup.
   */
  payerCode?: `0x${string}`;
  /**
   * Set when `eth_getCode` for the payer failed. Callers must report a failed-to-verify
   * reason instead of treating the missing bytecode as an invalid signature.
   */
  codeLookupError?: unknown;
};

const URL_IN_TEXT = /https?:\/\/\S+/gi;

/**
 * Client-visible reason for a failed payer code lookup. `invalidMessage` is returned to the
 * caller, and a transport error can embed the signer URL (including a query token). Strip URLs.
 *
 * @param error - The thrown lookup failure, or any non-Error value caught at the call site.
 * @returns A URL-stripped message, truncated to 200 characters, or a fixed fallback when empty.
 */
export function payerCodeLookupFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const stripped = raw.replace(URL_IN_TEXT, "[redacted-url]").replace(/\s+/g, " ").trim();
  return stripped.length > 0 ? stripped.slice(0, 200) : "payer eth_getCode failed";
}

// secp256k1 group order N halved: the EIP-2 / SEC1 §4.1.4 low-s upper bound.
// Mirrors Go `secp256k1HalfN` in `evm.IsCanonicalECDSASignature`.
const SECP256K1_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Report whether a 65-byte ECDSA signature uses a low-s value (`s <= n/2`, EIP-2).
 * Any other length is not a plain ECDSA signature and returns false.
 * Mirrors Go `evm.IsCanonicalECDSASignature`.
 *
 * @param signature - The r || s || v signature to inspect.
 * @returns True for a canonical low-s 65-byte signature; false otherwise.
 */
export function isCanonicalEcdsaSignature(signature: Hex): boolean {
  if (size(signature) !== 65) return false;
  // Read s (bytes [32, 64)) directly. viem `parseSignature` also validates v and would
  // throw on a malformed v, which belongs to the later signature check.
  const s = BigInt(`0x${signature.slice(2 + 64, 2 + 128)}`);
  return s <= SECP256K1_N_HALF;
}

/**
 * Report whether `signature` is a high-s plain EOA signature that verify must reject.
 * Only a 65-byte signature from a payer with no bytecode qualifies: ERC-1271 / ERC-6492
 * wrappers have other lengths, and a deployed wallet decides malleability itself.
 * Mirrors Go `IsPlainNonCanonicalECDSASignature`.
 *
 * @param signature - The full payload signature (not the ERC-6492 inner signature).
 * @param isDeployedAtPayer - Whether the payer has bytecode, from {@link classifyErc6492Payer}.
 * @returns True when the signature is a non-canonical EOA signature.
 */
export function isPlainNonCanonicalEcdsaSignature(
  signature: Hex,
  isDeployedAtPayer: boolean,
): boolean {
  if (size(signature) !== 65 || isCanonicalEcdsaSignature(signature)) return false;
  return !isDeployedAtPayer;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Classify an ERC-6492 payer in one RPC round-trip: parse the sig wrapper, fetch code,
 * and determine counterfactual vs deployed state.
 *
 * @param signer - Facilitator signer used to call `eth_getCode` on the payer address.
 * @param signature - The full signature, which may be an ERC-6492 wrapper.
 * @param payerAddress - The address whose bytecode is fetched to detect deployment state.
 * @returns Classification result including counterfactual flag, deployment state, and inner signature.
 */
export async function classifyErc6492Payer(
  signer: FacilitatorEvmSigner,
  signature: `0x${string}`,
  payerAddress: `0x${string}`,
): Promise<Erc6492Classification> {
  const erc6492Data = parseErc6492Signature(signature);
  const hasDeploymentInfo = !!(
    erc6492Data.address &&
    erc6492Data.data &&
    !isAddressEqual(erc6492Data.address, ZERO_ADDRESS)
  );
  const innerSignature = hasDeploymentInfo ? erc6492Data.signature : signature;
  const eip6492Deployment = hasDeploymentInfo
    ? { factoryAddress: erc6492Data.address!, factoryCalldata: erc6492Data.data! }
    : undefined;

  let code: `0x${string}` | undefined;
  let codeLookupError: unknown;
  try {
    code = await signer.getCode({ address: payerAddress });
  } catch (error) {
    codeLookupError = error;
    code = undefined;
  }
  const isDeployedAtPayer = !!(code && code !== "0x");
  // A failed lookup is not proof that the payer is undeployed.
  const isCounterfactual = hasDeploymentInfo && !isDeployedAtPayer && codeLookupError === undefined;

  return {
    isCounterfactual,
    isDeployedAtPayer,
    hasDeploymentInfo,
    innerSignature,
    eip6492Deployment,
    payerCode: code,
    codeLookupError,
  };
}

/**
 * Strict signature verification primitive that mirrors on-chain SignatureChecker
 * semantics exactly:
 *
 *   if signer.code.length == 0:
 *     ecrecover(digest, sig) == signer
 *   else:
 *     IERC1271(signer).isValidSignature(digest, sig) == 0x1626ba7e
 *
 * This matches:
 *   - Permit2 (libraries/SignatureVerification.sol)
 *   - USDC v2.2 (Circle's util/SignatureChecker.sol)
 *   - x402BatchSettlement (uses OpenZeppelin SignatureChecker)
 *
 * It deliberately does NOT fall back to ECDSA when EIP-1271 returns failure.
 * That fallback (which viem's `publicClient.verifyTypedData` performs) makes
 * pre-verify accept signatures that on-chain rejects — most visibly for
 * ERC-7702 delegated EOAs whose delegate's `isValidSignature` does not accept
 * raw owner ECDSA. With this primitive, pre-verify outcome == on-chain outcome.
 *
 * Plain EOAs (no code) take the ecrecover path and behave identically to before.
 * 7702-delegated EOAs take the EIP-1271 path because they have code; the delegate
 * decides — same as on-chain.
 */
const ERC1271_MAGIC_VALUE = "0x1626ba7e" as const;

const ERC1271_ABI = [
  {
    name: "isValidSignature",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
] as const;

/**
 * Outcome of a signature check that keeps a failed RPC read apart from a bad signature.
 *
 * - `valid`: ecrecover matched, or the wallet's `isValidSignature` returned the magic value.
 * - `invalid`: the signature does not check out. For a contract wallet this includes a revert,
 *   an empty return and a non-magic return: the wallet answered and did not accept it.
 * - `lookup_failed`: the payer `eth_getCode` or the `isValidSignature` call itself failed
 *   (transport error, timeout, rate limit), so no signature check ran. Callers should report a
 *   retryable failed-to-verify reason, not an invalid signature.
 */
export type SignatureCheckResult = "valid" | "invalid" | "lookup_failed";

/**
 * Errors that mean the contract answered `isValidSignature` without a usable result: an empty
 * return (the contract has no such function) or bytes that do not decode as `bytes4`.
 */
const NO_USABLE_ANSWER_ERRORS = new Set([
  "ContractFunctionZeroDataError",
  "AbiDecodingZeroDataError",
  "AbiDecodingDataSizeTooSmallError",
  "AbiDecodingDataSizeInvalidError",
  "PositionOutOfBoundsError",
]);

/**
 * Whether a thrown `isValidSignature` call is the contract rejecting the signature rather than a
 * failed read: a revert ({@link isContractRevert}, at any level of the `cause` chain where viem
 * puts the underlying error), JSON-RPC code 3 ("execution reverted"), or a call that returned no
 * usable data. Anything else (an HTTP error, a timeout, a rate limit, a signer that threw before
 * reaching the node) is a failed read.
 *
 * @param error - The value thrown by `readContract`.
 * @returns `true` when the contract answered and did not accept, `false` for a failed read.
 */
function isContractRejection(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (isContractRevert(current)) return true;
    const e = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.name === "string" && NO_USABLE_ANSWER_ERRORS.has(e.name)) return true;
    if (e.code === 3) return true;
    if (typeof e.message === "string" && /returned no data/i.test(e.message)) return true;
    current = e.cause;
  }
  return false;
}

/**
 * Verify a typed-data signature using strict on-chain SignatureChecker semantics.
 *
 * Returns a boolean: a failed RPC read and a bad signature both read as `false`. Callers that
 * report a reason should use {@link checkTypedDataSignature}, which keeps them apart.
 *
 * @param signer - Facilitator signer used for `eth_getCode` and `isValidSignature` calls.
 * @param params - Typed-data verification parameters.
 * @param params.address - The address that is expected to have signed the data.
 * @param params.domain - EIP-712 domain.
 * @param params.types - EIP-712 type definitions.
 * @param params.primaryType - The primary type to hash.
 * @param params.message - The typed-data message.
 * @param params.signature - The signature to verify.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export async function verifyTypedDataSignature(
  signer: FacilitatorEvmSigner,
  params: {
    address: `0x${string}`;
    domain: TypedDataDomain;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
  },
): Promise<boolean> {
  return (await checkTypedDataSignature(signer, params)) === "valid";
}

/**
 * Like {@link verifyTypedDataSignature}, but reports a failed RPC read as `lookup_failed`
 * instead of folding it into an invalid signature.
 *
 * @param signer - Facilitator signer used for `eth_getCode` and `isValidSignature` calls.
 * @param params - Typed-data verification parameters.
 * @param params.address - The address that is expected to have signed the data.
 * @param params.domain - EIP-712 domain.
 * @param params.types - EIP-712 type definitions.
 * @param params.primaryType - The primary type to hash.
 * @param params.message - The typed-data message.
 * @param params.signature - The signature to verify.
 * @returns `valid`, `invalid`, or `lookup_failed` when no signature check could run.
 */
export async function checkTypedDataSignature(
  signer: FacilitatorEvmSigner,
  params: {
    address: `0x${string}`;
    domain: TypedDataDomain;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
  },
): Promise<SignatureCheckResult> {
  let digest: `0x${string}`;
  try {
    digest = hashTypedData({
      domain: params.domain,
      types: params.types,
      primaryType: params.primaryType,
      message: params.message,
    });
  } catch {
    // Malformed typed data (e.g. non-checksummed address that viem rejects).
    // Treat as an invalid signature rather than propagating the error.
    return "invalid";
  }
  return checkHashSignature(signer, params.address, digest, params.signature);
}

/**
 * Lower-level variant of {@link verifyTypedDataSignature} for callers that already have the digest.
 *
 * @param signer - Facilitator signer used for `eth_getCode` and `isValidSignature` calls.
 * @param address - The address that is expected to have produced the signature.
 * @param digest - The EIP-191 / EIP-712 message hash to verify against.
 * @param signature - The signature to verify.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export async function verifyHashSignature(
  signer: FacilitatorEvmSigner,
  address: `0x${string}`,
  digest: `0x${string}`,
  signature: `0x${string}`,
): Promise<boolean> {
  // Never throws: a transient RPC error reads as false. Callers that report a reason should
  // use checkHashSignature, which returns lookup_failed for it.
  return (await checkHashSignature(signer, address, digest, signature)) === "valid";
}

/**
 * Like {@link verifyHashSignature}, but reports a failed payer `eth_getCode` or a failed
 * `isValidSignature` read as `lookup_failed`. Never throws.
 *
 * @param signer - Facilitator signer used for `eth_getCode` and `isValidSignature` calls.
 * @param address - The address that is expected to have produced the signature.
 * @param digest - The EIP-191 / EIP-712 message hash to verify against.
 * @param signature - The signature to verify.
 * @returns `valid`, `invalid`, or `lookup_failed` when no signature check could run.
 */
export async function checkHashSignature(
  signer: FacilitatorEvmSigner,
  address: `0x${string}`,
  digest: `0x${string}`,
  signature: `0x${string}`,
): Promise<SignatureCheckResult> {
  let code: `0x${string}` | undefined;
  try {
    code = await signer.getCode({ address });
  } catch {
    return "lookup_failed";
  }
  return checkHashSignatureWithCode(signer, address, code, digest, signature);
}

/**
 * Like {@link verifyHashSignature} but accepts pre-fetched bytecode to avoid a
 * redundant `eth_getCode` RPC when the caller already has it (e.g. after the
 * ERC-6492 counterfactual check in {@link classifyErc6492Payer}).
 *
 * Pass `undefined` or `"0x"` for `code` to take the EOA (ecrecover) path.
 *
 * @param signer - Facilitator signer used for `isValidSignature` calls on deployed contracts.
 * @param address - The address that is expected to have produced the signature.
 * @param code - Pre-fetched bytecode at `address`; `undefined` or `"0x"` takes the ECDSA path.
 * @param digest - The message hash to verify against.
 * @param signature - The signature to verify.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export function verifyHashSignatureWithCode(
  signer: FacilitatorEvmSigner,
  address: `0x${string}`,
  code: `0x${string}` | undefined,
  digest: `0x${string}`,
  signature: `0x${string}`,
): Promise<boolean> {
  return checkHashSignatureWithCode(signer, address, code, digest, signature).then(
    result => result === "valid",
  );
}

/**
 * Like {@link verifyHashSignatureWithCode}, but reports a failed `isValidSignature` read as
 * `lookup_failed`. The ECDSA path makes no RPC call, so it is only ever `valid` or `invalid`.
 *
 * @param signer - Facilitator signer used for `isValidSignature` calls on deployed contracts.
 * @param address - The address that is expected to have produced the signature.
 * @param code - Pre-fetched bytecode at `address`; `undefined` or `"0x"` takes the ECDSA path.
 * @param digest - The message hash to verify against.
 * @param signature - The signature to verify.
 * @returns `valid`, `invalid`, or `lookup_failed` when the `isValidSignature` read failed.
 */
export async function checkHashSignatureWithCode(
  signer: FacilitatorEvmSigner,
  address: `0x${string}`,
  code: `0x${string}` | undefined,
  digest: `0x${string}`,
  signature: `0x${string}`,
): Promise<SignatureCheckResult> {
  if (!code || code === "0x") {
    return (await verifyECDSA(address, digest, signature)) ? "valid" : "invalid";
  }
  return checkERC1271(signer, address, digest, signature);
}

/**
 * ecrecover path — used when the address has no code.
 *
 * @param address - The address expected to be recovered from the signature.
 * @param digest - The message hash to recover from.
 * @param signature - The compact 65-byte ECDSA signature.
 * @returns `true` if ecrecover produces `address`, `false` otherwise.
 */
export async function verifyECDSA(
  address: `0x${string}`,
  digest: `0x${string}`,
  signature: `0x${string}`,
): Promise<boolean> {
  const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (sigHex.length !== 130) return false;
  try {
    const recovered = await recoverAddress({ hash: digest, signature });
    return isAddressEqual(getAddress(recovered), getAddress(address));
  } catch {
    return false;
  }
}

/**
 * Strict EIP-1271 path — returns false on revert or non-magic return, never falls back to ECDSA.
 *
 * @param signer - Facilitator signer used to call `isValidSignature` on the contract.
 * @param address - The contract address whose `isValidSignature` is called.
 * @param digest - The hash passed as the first argument to `isValidSignature`.
 * @param signature - The signature bytes passed as the second argument.
 * @returns `true` if `isValidSignature` returns the ERC-1271 magic value, `false` otherwise.
 */
export async function verifyERC1271(
  signer: FacilitatorEvmSigner,
  address: `0x${string}`,
  digest: `0x${string}`,
  signature: `0x${string}`,
): Promise<boolean> {
  return (await checkERC1271(signer, address, digest, signature)) === "valid";
}

/**
 * Like {@link verifyERC1271}, but keeps a failed read apart from a rejection: a revert, an
 * empty return or a non-magic return is `invalid`; a transport failure is `lookup_failed`.
 *
 * @param signer - Facilitator signer used to call `isValidSignature` on the contract.
 * @param address - The contract address whose `isValidSignature` is called.
 * @param digest - The hash passed as the first argument to `isValidSignature`.
 * @param signature - The signature bytes passed as the second argument.
 * @returns `valid`, `invalid`, or `lookup_failed` when the call did not reach an answer.
 */
export async function checkERC1271(
  signer: FacilitatorEvmSigner,
  address: `0x${string}`,
  digest: `0x${string}`,
  signature: `0x${string}`,
): Promise<SignatureCheckResult> {
  let result: unknown;
  try {
    result = await signer.readContract({
      address,
      abi: ERC1271_ABI,
      functionName: "isValidSignature",
      args: [digest, signature],
    });
  } catch (error) {
    return isContractRejection(error) ? "invalid" : "lookup_failed";
  }
  if (typeof result !== "string") return "invalid";
  return result.toLowerCase().startsWith(ERC1271_MAGIC_VALUE) ? "valid" : "invalid";
}
