/**
 * Generates `upto-stellar-vectors.json`, the test vectors of the `upto` scheme on Stellar:
 * `npx tsx test/fixtures/upto-stellar-vectors.ts [--check]` from the package directory. Everything
 * is deterministic (fixed test-only seeds and nonce; ed25519 signatures are deterministic).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Keypair,
  Networks,
  StrKey,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  hash,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "../../src/constants";
import {
  approveInvocation,
  authorityEntry,
  invocation,
  payerInvocation,
  settleInvokeArgs,
  termsToScVal,
  unsignedPayerEntry,
  type UptoTerms,
} from "../../src/upto/terms";
import type { UptoCode } from "../../src/upto/errors";

export const VECTORS_PATH = fileURLToPath(new URL("./upto-stellar-vectors.json", import.meta.url));

const PASSPHRASE = Networks.TESTNET;
const SEEDS = { payer: 1, authority: 2, recipient: 3, other: 4 } as const;
const [payer, authority, recipient, other] = Object.values(SEEDS).map(seed =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)),
) as [Keypair, Keypair, Keypair, Keypair];
const MAX = 1_000_000n;
const EXPIRATION = 123_456;
const NONCE = 42n;
const SETTLE_AMOUNTS = [MAX, 300_000n, 0n];
/** The ledger and policy the negative vectors are checked under. */
const CHECK = { currentLedger: EXPIRATION - 10, ledgerSeconds: 5, maxTimeoutSeconds: 300 };
/** Test-only contract addresses that belong to no deployment. */
const CONTRACT = StrKey.encodeContract(
  hash(Buffer.from("x402-upto-stellar/test-vectors/contract")),
);
const CONTRACT_PAYER = StrKey.encodeContract(
  hash(Buffer.from("x402-upto-stellar/test-vectors/contract-payer")),
);

const TERMS: UptoTerms = {
  expirationLedger: EXPIRATION,
  facilitator: authority.publicKey(),
  maxAmount: MAX,
  recipient: recipient.publicKey(),
  token: USDC_TESTNET_ADDRESS,
  validAfterLedger: 0,
};

const REQUIREMENTS = {
  scheme: "upto",
  network: "stellar:testnet",
  amount: MAX.toString(),
  asset: USDC_TESTNET_ADDRESS,
  payTo: recipient.publicKey(),
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true, facilitatorAddress: authority.publicKey() },
};

/** A payload the facilitator must refuse with `expectedCode`, as overrides of `check.requirements`. */
export interface NegativeVector {
  readonly name: string;
  readonly phase?: "settle";
  readonly authorization: string;
  readonly signerAuthorizations?: unknown;
  /** Overrides of both the accepted and the request's requirements. */
  readonly requirements?: Partial<typeof REQUIREMENTS>;
  /** Overrides of the request's requirements only. */
  readonly amount?: string;
  readonly expectedCode: UptoCode;
}

const encode = (entry: xdr.SorobanAuthorizationEntry) => entry.toXDR("base64");
const payloadOf = (entry: xdr.SorobanAuthorizationEntry, expiration = EXPIRATION) =>
  hash(buildAuthorizationEntryPreimage(entry, expiration, PASSPHRASE).toXDR());

/**
 * A payer entry signed with `key` (an account's own key, or a contract account's raw signature).
 *
 * @param options - What to change from the valid entry
 * @param options.terms - The terms
 * @param options.key - The signing key
 * @param options.payer - The payer address (`CONTRACT_PAYER` signs a raw ed25519 signature)
 * @param options.contract - The settlement contract
 * @param options.root - A replacement root invocation
 * @param options.credential - The credential arm
 * @returns The signed entry
 */
async function payerEntry(
  options: {
    terms?: UptoTerms;
    key?: Keypair;
    payer?: string;
    contract?: string;
    root?: xdr.SorobanAuthorizedInvocation;
    credential?: "address" | "address_v2";
  } = {},
): Promise<xdr.SorobanAuthorizationEntry> {
  const key = options.key ?? payer;
  const terms = options.terms ?? TERMS;
  const entry = unsignedPayerEntry({
    contract: options.contract ?? CONTRACT,
    payer: options.payer ?? key.publicKey(),
    terms,
    nonce: NONCE,
    credential: options.credential,
  });
  if (options.root !== undefined) entry.rootInvocation(options.root);
  if (options.payer !== CONTRACT_PAYER) {
    return authorizeEntry(entry, key, terms.expirationLedger, PASSPHRASE);
  }
  const signature = key.sign(payloadOf(entry, terms.expirationLedger));
  return authorizeEntry(
    entry,
    () => Promise.resolve({ signatureScVal: xdr.ScVal.scvBytes(signature) }),
    terms.expirationLedger,
    PASSPHRASE,
  );
}

/**
 * A delegated signer's `__check_auth` entry for the contract-account payer.
 *
 * @param options - What to change from the valid entry
 * @param options.signer - The signing key
 * @param options.fn - The authorized function
 * @param options.nonce - The nonce
 * @param options.signed - Whether to sign it
 * @param options.child - Whether to give it a sub-invocation
 * @returns The entry
 */
async function delegatedEntry(
  options: {
    signer?: Keypair;
    fn?: string;
    nonce?: bigint;
    signed?: boolean;
    child?: boolean;
  } = {},
): Promise<xdr.SorobanAuthorizationEntry> {
  const key = options.signer ?? other;
  const payload = payloadOf(
    unsignedPayerEntry({ contract: CONTRACT, payer: CONTRACT_PAYER, terms: TERMS, nonce: NONCE }),
  );
  const root = invocation(CONTRACT_PAYER, options.fn ?? "__check_auth", [
    xdr.ScVal.scvBytes(payload),
  ]);
  if (options.child === true)
    root.subInvocations([approveInvocation(CONTRACT, CONTRACT_PAYER, TERMS)]);
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: nativeToScVal(key.publicKey(), { type: "address" }).address(),
        nonce: xdr.Int64.fromString((options.nonce ?? 7n).toString()),
        signatureExpirationLedger: EXPIRATION,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });
  return options.signed === false ? entry : authorizeEntry(entry, key, EXPIRATION, PASSPHRASE);
}

const approve = (o: { amount?: bigint; spender?: string; liveUntil?: number } = {}) =>
  invocation(TERMS.token, "approve", [
    nativeToScVal(payer.publicKey(), { type: "address" }),
    nativeToScVal(o.spender ?? CONTRACT, { type: "address" }),
    nativeToScVal(o.amount ?? MAX, { type: "i128" }),
    xdr.ScVal.scvU32(o.liveUntil ?? EXPIRATION),
  ]);

/**
 * The negative vectors: one change per bound field, tree shape, credential and party.
 *
 * @returns The vectors
 */
async function negatives(): Promise<NegativeVector[]> {
  const vectors: NegativeVector[] = [];
  const add = (
    name: string,
    expectedCode: UptoCode,
    authorization: string,
    options: Omit<NegativeVector, "name" | "expectedCode" | "authorization"> = {},
  ) => vectors.push({ name, ...options, authorization, expectedCode });
  const signed = async (options: Parameters<typeof payerEntry>[0]) =>
    encode(await payerEntry(options));
  const withTerms = (overrides: Partial<UptoTerms>) => ({ terms: { ...TERMS, ...overrides } });
  const base = await signed({});
  const termsArg = termsToScVal(TERMS);
  const termsMap = termsArg.map() ?? [];
  const settleRoot = (args: xdr.ScVal[], children = [approve()], fn = "settle") =>
    invocation(CONTRACT, fn, args, children);

  // The terms
  const { currentLedger } = CHECK;
  add(
    "recipient",
    "invalid_upto_stellar_payload_wrong_recipient",
    await signed(withTerms({ recipient: other.publicKey() })),
  );
  add(
    "asset",
    "invalid_upto_stellar_payload_wrong_asset",
    await signed(withTerms({ token: CONTRACT_PAYER })),
  );
  add(
    "maximum",
    "invalid_upto_stellar_payload_wrong_amount",
    await signed(withTerms({ maxAmount: MAX - 1n })),
  );
  add(
    "authority",
    "invalid_upto_stellar_payload_facilitator_mismatch",
    await signed(withTerms({ facilitator: other.publicKey() })),
  );
  const mismatched = await authorizeEntry(
    unsignedPayerEntry({
      contract: CONTRACT,
      payer: payer.publicKey(),
      terms: { ...TERMS, expirationLedger: EXPIRATION - 1 },
      nonce: NONCE,
    }),
    payer,
    EXPIRATION,
    PASSPHRASE,
  );
  add(
    "expiration differs from the signature's",
    "invalid_upto_stellar_payload_expiration_mismatch",
    encode(mismatched),
  );
  add(
    "valid after a future ledger",
    "invalid_upto_stellar_payload_not_yet_valid",
    await signed(withTerms({ validAfterLedger: currentLedger + 5 })),
  );
  add(
    "expiration beyond maxTimeoutSeconds",
    "invalid_upto_stellar_signature_expiration_too_far",
    await signed(withTerms({ expirationLedger: currentLedger + 100 })),
  );
  add(
    "expired",
    "invalid_upto_stellar_signature_expired",
    await signed(withTerms({ expirationLedger: currentLedger - 1 })),
  );
  add(
    "expires too soon",
    "invalid_upto_stellar_signature_expiration_too_soon",
    await signed(withTerms({ expirationLedger: currentLedger + 1 })),
  );

  // The root invocation
  add(
    "contract",
    "invalid_upto_stellar_payload_wrong_contract",
    await signed({ contract: CONTRACT_PAYER }),
  );
  const muxedRoot = settleRoot([termsArg]);
  muxedRoot
    .function()
    .contractFn()
    .contractAddress(
      xdr.ScAddress.scAddressTypeMuxedAccount(
        new xdr.MuxedEd25519Account({
          id: xdr.Uint64.fromString("1"),
          ed25519: Buffer.alloc(32, 9),
        }),
      ),
    );
  add(
    "contract is a muxed account",
    "invalid_upto_stellar_payload_wrong_contract",
    await signed({ root: muxedRoot }),
  );
  add(
    "function",
    "invalid_upto_stellar_payload_wrong_function",
    await signed({ root: settleRoot([termsArg], undefined, "settle_all") }),
  );
  add(
    "extra argument",
    "invalid_upto_stellar_payload_wrong_function",
    await signed({ root: settleRoot([termsArg, xdr.ScVal.scvU32(1)]) }),
  );
  const creation = await payerEntry();
  creation.rootInvocation(
    new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
        new xdr.CreateContractArgs({
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(
            xdr.Asset.assetTypeNative(),
          ),
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
        }),
      ),
      subInvocations: [],
    }),
  );
  add("contract creation root", "invalid_upto_stellar_payload_wrong_function", encode(creation));
  add(
    "terms missing a key",
    "invalid_upto_stellar_payload_invalid_terms",
    await signed({ root: settleRoot([xdr.ScVal.scvMap(termsMap.slice(1))]) }),
  );
  add(
    "terms keys out of order",
    "invalid_upto_stellar_payload_invalid_terms",
    await signed({ root: settleRoot([xdr.ScVal.scvMap([...termsMap].reverse())]) }),
  );
  const u64Max = termsMap.map(e =>
    e.key().sym().toString() === "max_amount"
      ? new xdr.ScMapEntry({ key: e.key(), val: nativeToScVal(MAX, { type: "u64" }) })
      : e,
  );
  add(
    "maximum encoded as u64",
    "invalid_upto_stellar_payload_invalid_terms",
    await signed({ root: settleRoot([xdr.ScVal.scvMap(u64Max)]) }),
  );

  // The tree
  const tree = "invalid_upto_stellar_payload_invalid_authorization_tree";
  const grandchild = approve();
  grandchild.subInvocations([approve()]);
  const transfer = invocation(
    TERMS.token,
    "transfer",
    approve().function().contractFn().args().slice(0, 3),
  );
  add("no approve child", tree, await signed({ root: settleRoot([termsArg], []) }));
  add("two children", tree, await signed({ root: settleRoot([termsArg], [approve(), approve()]) }));
  add(
    "approve amount",
    tree,
    await signed({ root: settleRoot([termsArg], [approve({ amount: MAX + 1n })]) }),
  );
  add(
    "approve spender",
    tree,
    await signed({ root: settleRoot([termsArg], [approve({ spender: CONTRACT_PAYER })]) }),
  );
  add(
    "approve live_until",
    tree,
    await signed({ root: settleRoot([termsArg], [approve({ liveUntil: EXPIRATION + 1 })]) }),
  );
  add("grandchild", tree, await signed({ root: settleRoot([termsArg], [grandchild]) }));
  add(
    "transfer child instead of approve",
    tree,
    await signed({ root: settleRoot([termsArg], [transfer]) }),
  );

  // The entry
  const sourceAccount = await payerEntry();
  sourceAccount.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());
  const delegates = await payerEntry();
  delegates.credentials(
    xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
      new xdr.SorobanAddressCredentialsWithDelegates({
        addressCredentials: delegates.credentials().address(),
        delegates: [],
      }),
    ),
  );
  const unsigned = encode(
    unsignedPayerEntry({
      contract: CONTRACT,
      payer: payer.publicKey(),
      terms: TERMS,
      nonce: NONCE,
    }),
  );
  add(
    "source-account credentials",
    "invalid_upto_stellar_payload_unsupported_credential_type",
    encode(sourceAccount),
  );
  add(
    "credentials with delegates",
    "invalid_upto_stellar_payload_unsupported_credential_type",
    encode(delegates),
  );
  add("unsigned", "invalid_upto_stellar_payload_missing_payer_signature", unsigned);
  add("not base64 XDR", "invalid_upto_stellar_payload_malformed", "AAAA");
  add(
    "non-canonical base64",
    "invalid_upto_stellar_payload_malformed",
    `${base.slice(0, 64)}\n${base.slice(64)}`,
  );
  add("oversized", "invalid_upto_stellar_payload_too_large", "A".repeat(8 * 1024 + 4));

  // The payer
  add(
    "payer is the authority",
    "invalid_upto_stellar_payload_facilitator_is_payer",
    await signed({ key: authority }),
  );
  add(
    "payer is payTo",
    "invalid_upto_stellar_payload_self_payment",
    await signed(withTerms({ recipient: payer.publicKey() })),
    {
      requirements: { payTo: payer.publicKey() },
    },
  );

  // Signer authorizations
  const signers = "invalid_upto_stellar_payload_invalid_signer_authorization";
  const contractBase = encode(await payerEntry({ payer: CONTRACT_PAYER }));
  const delegated = encode(await delegatedEntry());
  add("signer authorizations for an account payer", signers, base, {
    signerAuthorizations: [base],
  });
  add("signer authorizations not an array", signers, contractBase, {
    signerAuthorizations: delegated,
  });
  add("five signer authorizations", signers, contractBase, {
    signerAuthorizations: await Promise.all(
      [1n, 2n, 3n, 4n, 5n].map(async nonce => encode(await delegatedEntry({ nonce }))),
    ),
  });
  add("repeated signer authorization", signers, contractBase, {
    signerAuthorizations: [delegated, delegated],
  });
  add("unsigned signer authorization", signers, contractBase, {
    signerAuthorizations: [encode(await delegatedEntry({ signed: false }))],
  });
  add("signer authorization for another function", signers, contractBase, {
    signerAuthorizations: [encode(await delegatedEntry({ fn: "transfer" }))],
  });
  add("signer authorization with a child", signers, contractBase, {
    signerAuthorizations: [encode(await delegatedEntry({ child: true }))],
  });
  add("signer authorization by the authority", signers, contractBase, {
    signerAuthorizations: [encode(await delegatedEntry({ signer: authority }))],
  });
  const balanceSigner = await delegatedEntry();
  balanceSigner
    .rootInvocation()
    .function()
    .contractFn()
    .contractAddress(
      xdr.ScAddress.scAddressTypeClaimableBalance(
        xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(Buffer.alloc(32, 9)),
      ),
    );
  add("signer authorization for a claimable balance", signers, contractBase, {
    signerAuthorizations: [encode(balanceSigner)],
  });
  add("settle entry as a signer authorization", signers, contractBase, {
    signerAuthorizations: [base],
  });
  add("oversized signer authorization", "invalid_upto_stellar_payload_too_large", contractBase, {
    signerAuthorizations: ["A".repeat(8 * 1024 + 4)],
  });
  add(
    "contract payer unsigned",
    "invalid_upto_stellar_payload_missing_payer_signature",
    encode(
      unsignedPayerEntry({ contract: CONTRACT, payer: CONTRACT_PAYER, terms: TERMS, nonce: NONCE }),
    ),
  );

  // Requirements
  const muxed = StrKey.encodeMed25519PublicKey(
    Buffer.concat([recipient.rawPublicKey(), Buffer.alloc(8, 7)]),
  );
  const extra = (facilitatorAddress: string, areFeesSponsored = true) => ({
    extra: { areFeesSponsored, facilitatorAddress },
  });
  add("muxed payTo", "invalid_upto_stellar_payload_unsupported_recipient", base, {
    requirements: { payTo: muxed },
  });
  add("fees not sponsored", "invalid_upto_stellar_requirements_fees_not_sponsored", base, {
    requirements: extra(authority.publicKey(), false),
  });
  add(
    "another facilitator address",
    "invalid_upto_stellar_requirements_facilitator_mismatch",
    base,
    { requirements: extra(other.publicKey()) },
  );
  add("payTo is the authority", "invalid_upto_stellar_requirements_invalid_pay_to", base, {
    requirements: { payTo: authority.publicKey() },
  });
  add("payTo is the asset", "invalid_upto_stellar_requirements_invalid_pay_to", base, {
    requirements: { payTo: TERMS.token },
  });
  add(
    "payTo is the settlement contract",
    "invalid_upto_stellar_requirements_invalid_pay_to",
    base,
    { requirements: { payTo: CONTRACT } },
  );
  add("timeout above the policy", "invalid_upto_stellar_requirements_timeout_out_of_range", base, {
    requirements: { maxTimeoutSeconds: 3_600 },
  });
  add("timeout below the minimum", "invalid_upto_stellar_requirements_timeout_out_of_range", base, {
    requirements: { maxTimeoutSeconds: 14 },
  });
  add(
    "verify amount differs from the maximum",
    "invalid_upto_stellar_payload_accepted_mismatch",
    base,
    { amount: "999999" },
  );
  add(
    "settle amount above the maximum",
    "invalid_upto_stellar_payload_settlement_exceeds_amount",
    base,
    {
      phase: "settle",
      amount: (MAX + 1n).toString(),
    },
  );
  return vectors;
}

/**
 * Builds the vectors.
 *
 * @returns The vectors
 */
export async function buildUptoVectors() {
  const settle = (payerAddress: string) =>
    SETTLE_AMOUNTS.map(amount => ({
      amount: amount.toString(),
      invokeContractArgsXdr: settleInvokeArgs(CONTRACT, payerAddress, TERMS, amount).toXDR(
        "base64",
      ),
      authorityEntryXdr: authorityEntry(CONTRACT, payerAddress, TERMS, amount).toXDR("base64"),
    }));
  const arm = async (credential: "address" | "address_v2") => {
    const unsigned = unsignedPayerEntry({
      contract: CONTRACT,
      payer: payer.publicKey(),
      terms: TERMS,
      nonce: NONCE,
      credential,
    });
    const preimage = buildAuthorizationEntryPreimage(unsigned, EXPIRATION, PASSPHRASE);
    const payload = hash(preimage.toXDR());
    return {
      preimageXdr: preimage.toXDR("base64"),
      payloadSha256: payload.toString("hex"),
      signature: payer.sign(payload).toString("hex"),
      authorization: encode(await payerEntry({ credential })),
    };
  };
  const contractPayerEntry = await payerEntry({ payer: CONTRACT_PAYER });
  return {
    description:
      "Test vectors for the x402 upto scheme on Stellar. Seeds and contract addresses are test-only.",
    networkPassphrase: PASSPHRASE,
    seeds: Object.fromEntries(
      Object.entries(SEEDS).map(([k, seed]) => [k, Buffer.alloc(32, seed).toString("hex")]),
    ),
    payer: payer.publicKey(),
    authority: authority.publicKey(),
    recipient: recipient.publicKey(),
    contract: CONTRACT,
    terms: { ...TERMS, maxAmount: MAX.toString() },
    nonce: NONCE.toString(),
    termsXdr: termsToScVal(TERMS).toXDR("base64"),
    approveInvocationXdr: approveInvocation(CONTRACT, payer.publicKey(), TERMS).toXDR("base64"),
    rootInvocationXdr: payerInvocation(CONTRACT, payer.publicKey(), TERMS).toXDR("base64"),
    credentials: { address: await arm("address"), address_v2: await arm("address_v2") },
    settle: settle(payer.publicKey()),
    contractPayer: {
      address: CONTRACT_PAYER,
      publicKey: payer.rawPublicKey().toString("hex"),
      payloadSha256: payloadOf(contractPayerEntry).toString("hex"),
      authorization: encode(contractPayerEntry),
      delegatedSignerAuthorization: encode(await delegatedEntry()),
      settle: settle(CONTRACT_PAYER),
    },
    check: { requirements: REQUIREMENTS, ...CHECK },
    negatives: await negatives(),
  };
}

export type UptoVectors = Awaited<ReturnType<typeof buildUptoVectors>>;

/**
 * Renders the vectors as the fixture's JSON.
 *
 * @returns The JSON text
 */
export async function renderUptoVectors(): Promise<string> {
  return `${JSON.stringify(await buildUptoVectors(), null, 2)}\n`;
}

// Not top-level await: the file also runs as CommonJS under tsx.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void renderUptoVectors().then(rendered => {
    if (!process.argv.includes("--check")) return writeFileSync(VECTORS_PATH, rendered);
    const upToDate = readFileSync(VECTORS_PATH, "utf8") === rendered;
    process.stdout.write(
      upToDate ? "upto vectors are up to date\n" : "upto vectors are out of date\n",
    );
    process.exitCode = upToDate ? 0 : 1;
  });
}
