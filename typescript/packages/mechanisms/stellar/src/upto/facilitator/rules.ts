import { Address, xdr } from "@stellar/stellar-sdk";
import { deepEqual } from "@x402/core/utils";
import { getAddressCredentials } from "../../shared";
import {
  EXPIRATION_LEDGER_TOLERANCE,
  EXPIRATION_MARGIN_LEDGERS,
  MAX_AUTHORIZATION_BASE64_LENGTH,
  MAX_SIGNER_AUTHORIZATIONS,
  MIN_TIMEOUT_SECONDS,
  NOMINAL_LEDGER_SECONDS,
  SETTLE_FUNCTION,
  UPTO_SCHEME,
} from "../constants";
import { reject, type UptoCode, type UptoRejection } from "../errors";
import {
  isAccountOrContract,
  isContractAddress,
  isMuxedAddress,
  parseAtomicAmount,
} from "../shared";
import { approveInvocation, termsFromScVal, type UptoTerms } from "../terms";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/** What the static rules need to know about the facilitator and the ledger. */
export interface UptoRuleContext {
  /** `verify` checks the maximum; `settle` the amount to settle. */
  readonly phase: "verify" | "settle";
  readonly contract: string;
  /** The settlement authority (`extra.facilitatorAddress`). */
  readonly authority: string;
  /** Every facilitator-controlled address. */
  readonly facilitatorAddresses: ReadonlySet<string>;
  readonly currentLedger: number;
  readonly ledgerSeconds: number;
  readonly maxTimeoutSeconds: number;
  readonly isAssetAccepted?: ((asset: string, network: string) => boolean) | undefined;
  /**
   * Returns a payment that fails only rule 7 as checked, with the refusal in `expiration`, so that a
   * repeat of a recorded settlement can be answered from the record.
   */
  readonly deferExpiration?: boolean;
}

/** A payment that passed every static rule. */
export interface CheckedUptoPayment {
  readonly entry: xdr.SorobanAuthorizationEntry;
  readonly signerAuthorizations: xdr.SorobanAuthorizationEntry[];
  readonly payer: string;
  readonly nonce: bigint;
  readonly terms: UptoTerms;
  /** The signed maximum. */
  readonly maxAmount: bigint;
  /** The amount to simulate and settle: the maximum at `verify`, `requirements.amount` at `settle`. */
  readonly amount: bigint;
}

export type RuleResult =
  | {
      readonly ok: true;
      readonly payment: CheckedUptoPayment;
      /** Rule 7's refusal, when it was deferred. */
      readonly expiration?: UptoRejection;
    }
  | { readonly ok: false; readonly rejection: UptoRejection; readonly payer?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSigned = (signature: xdr.ScVal) =>
  signature.switch() !== xdr.ScValType.scvVoid() &&
  !(signature.switch() === xdr.ScValType.scvVec() && (signature.vec() ?? []).length === 0);

/**
 * Decodes one canonical base64 XDR entry.
 *
 * @param base64 - The entry
 * @returns The entry, or `undefined` for anything else
 */
function decodeEntry(base64: string): xdr.SorobanAuthorizationEntry | undefined {
  try {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(base64, "base64");
    return entry.toXDR("base64") === base64 ? entry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The strkey of an address.
 *
 * @param address - The address
 * @returns Its strkey, or `undefined` when it cannot be decoded
 */
function addressString(address: xdr.ScAddress): string | undefined {
  try {
    return Address.fromScAddress(address).toString();
  } catch {
    return undefined;
  }
}

/**
 * The `G…` or `C…` address of address credentials.
 *
 * @param credentials - The credentials
 * @returns The address, or `undefined` for any other kind
 */
function credentialAddress(credentials: xdr.SorobanAddressCredentials): string | undefined {
  const value = addressString(credentials.address());
  return isAccountOrContract(value) ? value : undefined;
}

/**
 * The protocol checks of rule 1, without the served-network check.
 *
 * @param payload - The payment payload
 * @param requirements - The payment requirements
 * @returns The refusal, or `undefined`
 */
export function checkProtocol(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): UptoRejection | undefined {
  const { accepted } = payload;
  if (payload.x402Version !== 2) return reject("invalid_x402_version");
  if (!isRecord(accepted)) return reject("invalid_upto_stellar_payload_accepted_mismatch");
  if (accepted.scheme !== UPTO_SCHEME || requirements.scheme !== UPTO_SCHEME) {
    return reject("unsupported_scheme");
  }
  if (accepted.network !== requirements.network) return reject("network_mismatch");
  return undefined;
}

/**
 * The static rules (1–9 of the spec), in order. They read nothing but the current ledger.
 *
 * @param payload - The payment payload
 * @param requirements - The payment requirements
 * @param context - The facilitator's policy and the current ledger
 * @returns The checked payment, or the first violated rule's refusal
 */
export function checkUptoPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  context: UptoRuleContext,
): RuleResult {
  let payer: string | undefined;
  // A deferred rule 7 refusal still comes before the refusals of later rules.
  let expiration: UptoRejection | undefined;
  const fail = (code: UptoCode, reason?: string): RuleResult => ({
    ok: false,
    rejection: expiration ?? reject(code, reason),
    ...(payer === undefined ? {} : { payer }),
  });
  const { accepted } = payload;

  // 1. Protocol
  const protocol = checkProtocol(payload, requirements);
  if (protocol !== undefined) return { ok: false, rejection: protocol };

  // 2. Requirements
  const invalid = checkRequirements(accepted, requirements, context);
  if (invalid !== undefined) return { ok: false, rejection: invalid };
  const maxAmount = parseAtomicAmount(accepted.amount) as bigint;
  const amount =
    context.phase === "verify" ? maxAmount : (parseAtomicAmount(requirements.amount) as bigint);

  // 3. The entry
  const body = payload.payload as Record<string, unknown> | undefined;
  const base64 = body?.["authorization"];
  if (typeof base64 !== "string") return fail("invalid_upto_stellar_payload_malformed");
  if (base64.length > MAX_AUTHORIZATION_BASE64_LENGTH) {
    return fail("invalid_upto_stellar_payload_too_large");
  }
  const entry = decodeEntry(base64);
  if (entry === undefined) return fail("invalid_upto_stellar_payload_malformed");
  const credentials = getAddressCredentials(entry.credentials());
  payer = credentials === undefined ? undefined : credentialAddress(credentials);
  if (credentials === undefined || payer === undefined) {
    return fail("invalid_upto_stellar_payload_unsupported_credential_type");
  }
  if (!isSigned(credentials.signature())) {
    return fail("invalid_upto_stellar_payload_missing_payer_signature");
  }

  // 4. The root invocation
  const root = entry.rootInvocation();
  if (
    root.function().switch() !==
    xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
  ) {
    return fail("invalid_upto_stellar_payload_wrong_function");
  }
  const call = root.function().contractFn();
  const rootContract = addressString(call.contractAddress());
  if (rootContract !== context.contract) {
    return fail(
      "invalid_upto_stellar_payload_wrong_contract",
      `The entry is for ${rootContract ?? "an unknown address"}; the settlement contract is ${context.contract}.`,
    );
  }
  const [argument, ...extraArgs] = call.args();
  if (call.functionName().toString() !== SETTLE_FUNCTION || extraArgs.length > 0) {
    return fail("invalid_upto_stellar_payload_wrong_function");
  }
  const terms = argument === undefined ? undefined : termsFromScVal(argument);
  if (terms === undefined) return fail("invalid_upto_stellar_payload_invalid_terms");

  // 5. The terms
  if (terms.recipient !== requirements.payTo)
    return fail("invalid_upto_stellar_payload_wrong_recipient");
  if (terms.token !== requirements.asset) return fail("invalid_upto_stellar_payload_wrong_asset");
  if (terms.facilitator !== context.authority) {
    return fail("invalid_upto_stellar_payload_facilitator_mismatch");
  }
  if (terms.maxAmount !== maxAmount) return fail("invalid_upto_stellar_payload_wrong_amount");
  if (terms.expirationLedger !== credentials.signatureExpirationLedger()) {
    return fail("invalid_upto_stellar_payload_expiration_mismatch");
  }
  if (terms.validAfterLedger > context.currentLedger + 1) {
    return fail("invalid_upto_stellar_payload_not_yet_valid");
  }

  // 6. The tree
  const children = root.subInvocations();
  const approve = approveInvocation(context.contract, payer, terms).toXDR("base64");
  if (children.length !== 1 || children[0]?.toXDR("base64") !== approve) {
    return fail("invalid_upto_stellar_payload_invalid_authorization_tree");
  }

  // 7. The expiration window
  const window = checkExpirationWindow(
    terms.expirationLedger,
    requirements.maxTimeoutSeconds,
    context,
  );
  if (window !== undefined && !context.deferExpiration) return fail(window.code, window.reason);
  expiration = window;

  // 8. The payer
  if (context.facilitatorAddresses.has(payer) || payer === context.contract) {
    return fail("invalid_upto_stellar_payload_facilitator_is_payer");
  }
  if (payer === requirements.payTo) return fail("invalid_upto_stellar_payload_self_payment");

  // 9. Signer authorizations
  const signers = checkSignerAuthorizations(body?.["signerAuthorizations"], payer, context);
  if (!Array.isArray(signers)) return fail(signers.code, signers.reason);

  return {
    ok: true,
    ...(expiration === undefined ? {} : { expiration }),
    payment: {
      entry,
      signerAuthorizations: signers,
      payer,
      nonce: credentials.nonce().toBigInt(),
      terms,
      maxAmount,
      amount,
    },
  };
}

/**
 * Rule 7.
 *
 * @param expiration - The expiration ledger `E`
 * @param maxTimeoutSeconds - `requirements.maxTimeoutSeconds`
 * @param context - The current ledger and its close time
 * @returns The refusal, or `undefined`
 */
function checkExpirationWindow(
  expiration: number,
  maxTimeoutSeconds: number,
  context: UptoRuleContext,
): UptoRejection | undefined {
  const { currentLedger } = context;
  const latestAllowed =
    currentLedger +
    Math.ceil(maxTimeoutSeconds / Math.min(context.ledgerSeconds, NOMINAL_LEDGER_SECONDS)) +
    EXPIRATION_LEDGER_TOLERANCE;
  if (expiration < currentLedger) {
    return reject(
      "invalid_upto_stellar_signature_expired",
      `The authorization expired at ledger ${expiration}; the current ledger is ${currentLedger}.`,
    );
  }
  if (expiration < currentLedger + EXPIRATION_MARGIN_LEDGERS) {
    return reject("invalid_upto_stellar_signature_expiration_too_soon");
  }
  if (expiration > latestAllowed) {
    return reject(
      "invalid_upto_stellar_signature_expiration_too_far",
      `The authorization expires at ledger ${expiration}; the latest allowed is ${latestAllowed}.`,
    );
  }
  return undefined;
}

/**
 * Rule 2.
 *
 * @param accepted - The requirements the payer accepted
 * @param requirements - The requirements of this request
 * @param context - The facilitator's policy
 * @returns The refusal, or `undefined`
 */
function checkRequirements(
  accepted: PaymentRequirements,
  requirements: PaymentRequirements,
  context: UptoRuleContext,
): UptoRejection | undefined {
  const { asset, payTo, maxTimeoutSeconds, network } = requirements;
  const extra: Record<string, unknown> = requirements.extra ?? {};

  if (!isContractAddress(asset) || context.isAssetAccepted?.(asset, network) === false) {
    return reject("invalid_upto_stellar_requirements_asset_not_accepted");
  }
  if (isMuxedAddress(payTo)) return reject("invalid_upto_stellar_payload_unsupported_recipient");
  if (
    !isAccountOrContract(payTo) ||
    context.facilitatorAddresses.has(payTo) ||
    payTo === context.contract ||
    payTo === asset
  ) {
    return reject("invalid_upto_stellar_requirements_invalid_pay_to");
  }
  if (
    !Number.isInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds < MIN_TIMEOUT_SECONDS ||
    maxTimeoutSeconds > context.maxTimeoutSeconds
  ) {
    return reject(
      "invalid_upto_stellar_requirements_timeout_out_of_range",
      `maxTimeoutSeconds must be an integer from ${MIN_TIMEOUT_SECONDS} to ${context.maxTimeoutSeconds}.`,
    );
  }
  if (extra["areFeesSponsored"] !== true) {
    return reject("invalid_upto_stellar_requirements_fees_not_sponsored");
  }
  if (extra["facilitatorAddress"] !== context.authority) {
    return reject("invalid_upto_stellar_requirements_facilitator_mismatch");
  }
  const acceptedExtra: unknown = accepted.extra;
  if (
    accepted.asset !== asset ||
    accepted.payTo !== payTo ||
    accepted.maxTimeoutSeconds !== maxTimeoutSeconds ||
    !isRecord(acceptedExtra) ||
    !Object.keys(extra).every(key => deepEqual(extra[key], acceptedExtra[key]))
  ) {
    return reject("invalid_upto_stellar_payload_accepted_mismatch");
  }

  const max = parseAtomicAmount(accepted.amount);
  const amount = parseAtomicAmount(requirements.amount);
  if (max === undefined || max === 0n || amount === undefined) {
    return reject("invalid_upto_stellar_requirements_invalid_amount");
  }
  if (context.phase === "verify" && amount !== max) {
    return reject(
      "invalid_upto_stellar_payload_accepted_mismatch",
      "At verification the amount must equal the accepted maximum.",
    );
  }
  if (amount > max) return reject("invalid_upto_stellar_payload_settlement_exceeds_amount");
  return undefined;
}

/**
 * Rule 9: at most four signed entries of addresses other than the payer and the facilitator, each
 * authorizing only the payer's `__check_auth`, accepted only for a `C…` payer.
 *
 * @param value - `payload.signerAuthorizations`
 * @param payer - The payer
 * @param context - The facilitator's addresses
 * @returns The decoded entries, or a refusal
 */
function checkSignerAuthorizations(
  value: unknown,
  payer: string,
  context: UptoRuleContext,
): xdr.SorobanAuthorizationEntry[] | UptoRejection {
  const invalid = (reason?: string) =>
    reject("invalid_upto_stellar_payload_invalid_signer_authorization", reason);
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalid();
  if (value.length > 0 && !isContractAddress(payer)) {
    return invalid("signerAuthorizations are accepted only for a C… payer.");
  }
  if (value.length > MAX_SIGNER_AUTHORIZATIONS) return invalid();

  const entries: xdr.SorobanAuthorizationEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item === "string" && item.length > MAX_AUTHORIZATION_BASE64_LENGTH) {
      return reject("invalid_upto_stellar_payload_too_large");
    }
    const entry = typeof item === "string" ? decodeEntry(item) : undefined;
    const credentials = entry && getAddressCredentials(entry.credentials());
    const signer = credentials && credentialAddress(credentials);
    const fn = entry?.rootInvocation().function();
    const key = `${signer}:${credentials?.nonce().toString()}`;
    const valid =
      entry !== undefined &&
      credentials !== undefined &&
      signer !== undefined &&
      signer !== payer &&
      !context.facilitatorAddresses.has(signer) &&
      !seen.has(key) &&
      isSigned(credentials.signature()) &&
      fn?.switch() ===
        xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn() &&
      addressString(fn.contractFn().contractAddress()) === payer &&
      fn.contractFn().functionName().toString() === "__check_auth" &&
      entry.rootInvocation().subInvocations().length === 0;
    if (!valid) return invalid(`signerAuthorizations[${index}] is not a valid entry.`);
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}
