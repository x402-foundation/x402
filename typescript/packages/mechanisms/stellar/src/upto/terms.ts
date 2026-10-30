import { Address, nativeToScVal, scValToBigInt, xdr } from "@stellar/stellar-sdk";
import { SETTLE_FUNCTION } from "./constants";
import { isAccountOrContract } from "./shared";

/** The terms a payer signs: the contract's `UptoTerms`. */
export interface UptoTerms {
  /** Last ledger (inclusive) at which the terms can be settled; equals `signatureExpirationLedger`. */
  readonly expirationLedger: number;
  /** The settlement authority, `extra.facilitatorAddress`. */
  readonly facilitator: string;
  readonly maxAmount: bigint;
  /** `payTo`. */
  readonly recipient: string;
  /** The SEP-41 token, the requirements' `asset`. */
  readonly token: string;
  /** First ledger at which the terms can be settled; clients send 0. */
  readonly validAfterLedger: number;
}

const address = (value: string) => nativeToScVal(value, { type: "address" });
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });

/**
 * Encodes terms as the contract does: an `ScMap` sorted by field name.
 *
 * @param terms - The terms
 * @returns The `ScMap`
 */
export function termsToScVal(terms: UptoTerms): xdr.ScVal {
  const fields: [string, xdr.ScVal][] = [
    ["expiration_ledger", xdr.ScVal.scvU32(terms.expirationLedger)],
    ["facilitator", address(terms.facilitator)],
    ["max_amount", i128(terms.maxAmount)],
    ["recipient", address(terms.recipient)],
    ["token", address(terms.token)],
    ["valid_after_ledger", xdr.ScVal.scvU32(terms.validAfterLedger)],
  ];
  return xdr.ScVal.scvMap(
    fields.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
}

/**
 * Decodes `UptoTerms` strictly: the value must equal the canonical encoding of what it decodes to,
 * and every address must be a `G…` or `C…` address.
 *
 * @param value - The encoded terms
 * @returns The terms, or `undefined`
 */
export function termsFromScVal(value: xdr.ScVal): UptoTerms | undefined {
  try {
    const fields = new Map((value.map() ?? []).map(e => [e.key().sym().toString(), e.val()]));
    const field = (key: string) => {
      const val = fields.get(key);
      if (val === undefined) throw new Error(`missing ${key}`);
      return val;
    };
    const terms: UptoTerms = {
      expirationLedger: field("expiration_ledger").u32(),
      facilitator: Address.fromScVal(field("facilitator")).toString(),
      maxAmount: scValToBigInt(field("max_amount")),
      recipient: Address.fromScVal(field("recipient")).toString(),
      token: Address.fromScVal(field("token")).toString(),
      validAfterLedger: field("valid_after_ledger").u32(),
    };
    const addresses = [terms.facilitator, terms.recipient, terms.token];
    if (!addresses.every(isAccountOrContract)) return undefined;
    return termsToScVal(terms).toXDR("base64") === value.toXDR("base64") ? terms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A contract-function node of an authorization tree.
 *
 * @param contract - The contract
 * @param functionName - The function
 * @param args - Its arguments
 * @param subInvocations - Its children
 * @returns The invocation
 */
export function invocation(
  contract: string,
  functionName: string,
  args: xdr.ScVal[],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName,
        args,
      }),
    ),
    subInvocations,
  });
}

/**
 * The payer's only child: `token.approve(payer, contract, maxAmount, expirationLedger)`.
 *
 * @param contract - The settlement contract
 * @param payer - The payer
 * @param terms - The terms
 * @returns The invocation
 */
export function approveInvocation(
  contract: string,
  payer: string,
  terms: UptoTerms,
): xdr.SorobanAuthorizedInvocation {
  return invocation(terms.token, "approve", [
    address(payer),
    address(contract),
    i128(terms.maxAmount),
    xdr.ScVal.scvU32(terms.expirationLedger),
  ]);
}

/**
 * The payer's tree: `contract.settle(terms)` with the `approve` child.
 *
 * @param contract - The settlement contract
 * @param payer - The payer
 * @param terms - The terms
 * @returns The root invocation
 */
export function payerInvocation(
  contract: string,
  payer: string,
  terms: UptoTerms,
): xdr.SorobanAuthorizedInvocation {
  return invocation(
    contract,
    SETTLE_FUNCTION,
    [termsToScVal(terms)],
    [approveInvocation(contract, payer, terms)],
  );
}

/**
 * The call a facilitator submits: `contract.settle(payer, terms, amount)`.
 *
 * @param contract - The settlement contract
 * @param payer - The payer
 * @param terms - The terms
 * @param amount - The amount to settle
 * @returns The invocation arguments
 */
export function settleInvokeArgs(
  contract: string,
  payer: string,
  terms: UptoTerms,
  amount: bigint,
): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(contract).toScAddress(),
    functionName: SETTLE_FUNCTION,
    args: [address(payer), termsToScVal(terms), i128(amount)],
  });
}

/**
 * The settlement authority's entry: `SOURCE_ACCOUNT` credentials for `settle(payer, terms, amount)`,
 * satisfied by making the authority the operation's source.
 *
 * @param contract - The settlement contract
 * @param payer - The payer
 * @param terms - The terms
 * @param amount - The amount to settle
 * @returns The entry
 */
export function authorityEntry(
  contract: string,
  payer: string,
  terms: UptoTerms,
  amount: bigint,
): xdr.SorobanAuthorizationEntry {
  const args = settleInvokeArgs(contract, payer, terms, amount);
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocation(contract, SETTLE_FUNCTION, args.args()),
  });
}

/**
 * The payer's unsigned entry, expiring with the terms.
 *
 * @param options - What the entry authorizes
 * @param options.contract - The settlement contract
 * @param options.payer - The payer
 * @param options.terms - The terms
 * @param options.nonce - A random nonce
 * @param options.credential - `address` (default) or CAP-71 `address_v2`
 * @returns The entry
 */
export function unsignedPayerEntry(options: {
  readonly contract: string;
  readonly payer: string;
  readonly terms: UptoTerms;
  readonly nonce: bigint;
  readonly credential?: "address" | "address_v2";
}): xdr.SorobanAuthorizationEntry {
  const credentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(options.payer).toScAddress(),
    nonce: xdr.Int64.fromString(options.nonce.toString()),
    signatureExpirationLedger: options.terms.expirationLedger,
    signature: xdr.ScVal.scvVoid(),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials:
      options.credential === "address_v2"
        ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddress(credentials),
    rootInvocation: payerInvocation(options.contract, options.payer, options.terms),
  });
}
