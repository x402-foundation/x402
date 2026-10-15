/**
 * Exports TS @x402/cardano reference behaviour as JSON fixtures for
 * java/x402-mechanism-cardano.
 *
 * Every facilitator fixture carries the epoch millisecond TS ran at (`now`),
 * the requirements, the payload, a snapshot of the stub chain (UTxOs with
 * owner/coin/assets, protocol parameters, current slot, evidence, submission
 * behaviour) and the TS result. The Java test replays the same snapshot with
 * `Clock.fixed(now)` and must reach the same decision.
 *
 * Signed transactions come from the TS test helpers
 * (`test/helpers/{buildSignedTx,stubs,masumi}.ts`), used without edits.
 *
 * Run: npm run export:cardano (from java/tools/ts-vectors).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cardanoDir = join(here, "../../../typescript/packages/mechanisms/cardano");
// Resolve TS sources and their dependencies from the cardano package itself.
const require = createRequire(join(cardanoDir, "package.json"));
const src = (path: string) => require(join(cardanoDir, "src", path));
const helper = (path: string) => require(join(cardanoDir, "test/helpers", path));

const evo = require("@evolution-sdk/evolution");
const { Address, Client, PrivateKey, Transaction, preprod } = evo;

const constants = src("constants.ts");
const utils = src("utils.ts");
const { ExactCardanoScheme: Facilitator } = src("exact/facilitator/scheme.ts");
const { ExactCardanoScheme: Server } = src("exact/server/scheme.ts");
const digests = src("exact/masumi/digests.ts");
const { jcs } = src("exact/masumi/jcs.ts");
const identifier = src("exact/masumi/identifier.ts");
const blueprint = src("exact/masumi/blueprint.ts");
const { verifySellerTermsSignature } = src("exact/masumi/cose.ts");
const { issueMasumiRequirements: issueRaw, toMasumiSellerSigner } = src("exact/masumi/issue.ts");
const { validateMasumiExtra } = src("exact/masumi/schema.ts");
const { deriveScriptHashHex } = src("exact/facilitator/scriptAddress.ts");
const { buildScriptDatumInline } = src("exact/script/datum.ts");
const { InMemoryCardanoSettlementStore } = src("settlementStore.ts");

const { buildSignedTx, getFixtureInputSnapshot } = helper("buildSignedTx.ts");
const stubs = helper("stubs.ts");
const { issueMasumiRequirements, freshKeyAddress } = helper("masumi.ts");

const outDir = join(here, "../../x402-mechanism-cardano/src/test/resources/vectors");
mkdirSync(outDir, { recursive: true });
const tsCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here }).toString().trim();

/** JSON with bigints as decimal strings. */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
}

function write(name: string, body: Record<string, unknown>): void {
  const doc = { generatedFrom: "typescript/packages/mechanisms/cardano", tsCommit, ...body };
  writeFileSync(join(outDir, name), stringify(doc));
  console.log(`wrote ${name}`);
}

const NETWORK = constants.CARDANO_PREPROD_CAIP2;
const PROTOCOL_PARAMETERS = stubs.STUB_PROTOCOL_PARAMETERS;
const CURRENT_SLOT: bigint = stubs.STUB_CURRENT_SLOT;
const TTL_SLOT: bigint = stubs.TTL_SLOT;
const NOW = Date.now();

let nonceCounter = 0;
/** A fresh nonce reference per fixture, so the helper's snapshot registry never collides. */
function nextNonce(): string {
  nonceCounter++;
  return `${nonceCounter.toString(16).padStart(2, "0").repeat(32)}#${nonceCounter % 3}`;
}

type Snapshot = {
  exists: boolean;
  address?: string;
  coin?: bigint;
  assets?: Record<string, bigint>;
  paymentKeyHash?: string;
};

type Evidence = { status: "unknown" | "mempool" | "confirmed"; confirmations: number };

/** What the stub chain does; serialized as-is for the Java replay. */
interface ChainSpec {
  currentSlot: bigint;
  slotError?: string;
  protocolParameters: typeof PROTOCOL_PARAMETERS | null;
  protocolParametersError?: string;
  utxos: Record<string, Snapshot | { error: string }>;
  transactionEvidence: boolean;
  evidence: Record<string, Evidence>;
  evidenceError?: string;
  phase1Validator?: { error?: string };
  evaluate?: { error?: string };
  submit?: { status: "confirmed" | "mempool" } | { error: string; definitive: boolean };
  evidenceAfterSubmit?: Evidence;
  addresses: string[];
}

function baseChain(utxos: Record<string, Snapshot | { error: string }>): ChainSpec {
  return {
    currentSlot: CURRENT_SLOT,
    protocolParameters: PROTOCOL_PARAMETERS,
    utxos,
    transactionEvidence: true,
    evidence: {},
    addresses: [stubs.PAYER_ADDRESS],
  };
}

/** Builds a TS facilitator signer that behaves exactly like the snapshot says. */
function signerFor(chain: ChainSpec) {
  let submitted = false;
  const signer: Record<string, unknown> = {
    getAddresses: () => chain.addresses,
    getUtxo: async (ref: string) => {
      const entry = chain.utxos[ref.toLowerCase()];
      if (!entry) throw new Error(`stub chain has no utxo ${ref}`);
      if ("error" in entry) throw new Error(entry.error);
      return entry;
    },
    getCurrentSlot: async () => {
      if (chain.slotError) throw new Error(chain.slotError);
      return chain.currentSlot;
    },
    submitTransaction: async (transaction: string) => {
      const spec = chain.submit ?? { status: "confirmed" as const };
      if ("error" in spec) throw new Error(spec.error);
      submitted = true;
      return { txHash: utils.decodeCardanoTransaction(transaction).txHash, status: spec.status };
    },
    isDefinitiveSubmissionRejection: () =>
      chain.submit !== undefined && "error" in chain.submit && chain.submit.definitive,
  };
  if (chain.protocolParameters !== null || chain.protocolParametersError) {
    signer.getProtocolParameters = async () => {
      if (chain.protocolParametersError) throw new Error(chain.protocolParametersError);
      return chain.protocolParameters;
    };
  }
  if (chain.transactionEvidence) {
    signer.getTransactionEvidence = async (txHash: string) => {
      if (chain.evidenceError) throw new Error(chain.evidenceError);
      if (submitted && chain.evidenceAfterSubmit) return chain.evidenceAfterSubmit;
      return chain.evidence[txHash] ?? { status: "unknown", confirmations: -2 };
    };
  }
  if (chain.phase1Validator) {
    signer.validatePhase1Transaction = async () => {
      if (chain.phase1Validator?.error) throw new Error(chain.phase1Validator.error);
    };
  }
  if (chain.evaluate) {
    signer.evaluateTransaction = async () => {
      if (chain.evaluate?.error) throw new Error(chain.evaluate.error);
    };
  }
  return signer;
}

function requirements(
  payTo: string,
  amount: string,
  asset = constants.LOVELACE_ASSET,
  extra: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: 600,
    extra,
    ...overrides,
  };
}

function payloadFor(req: Record<string, unknown>, transaction: string, nonce: string) {
  return {
    x402Version: 2,
    resource: { url: "https://api.example.com/weather", mimeType: "application/json" },
    accepted: req,
    payload: { transaction, nonce },
  };
}

/** Snapshots of every input of a transaction, as the helper registered them. */
function inputSnapshots(transaction: string): Record<string, Snapshot> {
  const decoded = utils.decodeCardanoTransaction(transaction);
  const result: Record<string, Snapshot> = {};
  for (const ref of decoded.inputs) {
    const snapshot = getFixtureInputSnapshot(ref);
    if (!snapshot) throw new Error(`no snapshot for ${ref}`);
    result[ref.toLowerCase()] = { ...snapshot, assets: { ...(snapshot.assets ?? {}) } };
  }
  return result;
}

interface Fixture {
  id: string;
  rule: string;
  description: string;
  operation: "verify" | "settle";
  options: Record<string, unknown>;
  requirements: Record<string, unknown>;
  payload: Record<string, unknown>;
  chain: ChainSpec;
  expected?: unknown;
}

const fixtures: Fixture[] = [];

function add(f: Omit<Fixture, "options" | "operation"> & Partial<Pick<Fixture, "options" | "operation">>) {
  fixtures.push({ operation: "verify", options: {}, ...f });
}

async function main(): Promise<void> {
  const payTo = await stubs.freshPreprodAddress();
  const otherAddress = await stubs.freshPreprodAddress();

  // ---------------------------------------------------------------- default
  {
    const nonce = nextNonce();
    const built = await buildSignedTx({ payTo, asset: "lovelace", amount: 2_000_000n, nonceUtxoRef: nonce, ttlSlot: TTL_SLOT });
    const req = requirements(payTo, "2000000");
    add({
      id: "01-default-happy",
      rule: "all",
      description: "plain lovelace payment, default confirmation policy",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });

    // 02 wrong network: the client echoes another network than the requirements.
    const req2 = requirements(payTo, "2000000");
    const accepted2 = { ...req2, network: constants.CARDANO_MAINNET_CAIP2 };
    add({
      id: "02a-wrong-network-accepted",
      rule: "1",
      description: "accepted.network differs from requirements.network",
      requirements: req2,
      payload: { ...payloadFor(req2, built.transaction, nonce), accepted: accepted2 },
      chain: baseChain(inputSnapshots(built.transaction)),
    });
    // A testnet transaction offered against mainnet requirements.
    const mainnetPayTo = Address.toBech32(
      Address.fromHex("01" + Address.toHex(Address.fromBech32(payTo)).slice(2)),
    );
    const req2b = requirements(mainnetPayTo, "2000000", "lovelace", {}, { network: constants.CARDANO_MAINNET_CAIP2 });
    add({
      id: "02b-wrong-network-testnet-tx",
      rule: "1",
      description: "preprod transaction against mainnet requirements (address network tag)",
      requirements: req2b,
      payload: payloadFor(req2b, built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });

    // 03 no payTo output.
    const req3 = requirements(otherAddress, "2000000");
    add({
      id: "03-no-payto-output",
      rule: "2",
      description: "no output pays requirements.payTo",
      requirements: req3,
      payload: payloadFor(req3, built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });

    // 04 underpay.
    const req4 = requirements(payTo, "2500000");
    add({
      id: "04-underpay",
      rule: "3",
      description: "payTo output carries less than amount",
      requirements: req4,
      payload: payloadFor(req4, built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });

    // 05 wrong asset.
    const req5 = requirements(payTo, "2000000", constants.USDM_PREPROD_ASSET);
    add({
      id: "05-wrong-asset",
      rule: "4",
      description: "payTo output pays lovelace, requirements ask for USDM",
      requirements: req5,
      payload: payloadFor(req5, built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });

    // 06 nonce not an input.
    const foreignNonce = `${"f".repeat(64)}#7`;
    add({
      id: "06-nonce-not-input",
      rule: "5",
      description: "payload.nonce is not one of the transaction inputs",
      requirements: req,
      payload: payloadFor(req, built.transaction, foreignNonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });

    // 07 nonce already spent.
    const spent = inputSnapshots(built.transaction);
    spent[nonce.toLowerCase()] = { exists: false, address: spent[nonce.toLowerCase()].address };
    add({
      id: "07-nonce-spent",
      rule: "5",
      description: "nonce UTxO is no longer in the UTxO set",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: baseChain(spent),
    });

    // 09 TTL beyond maxTimeoutSeconds.
    const req9 = requirements(payTo, "2000000", "lovelace", {}, { maxTimeoutSeconds: 120 });
    add({
      id: "09-ttl-too-far",
      rule: "7",
      description: "TTL is later than now + maxTimeoutSeconds",
      requirements: req9,
      payload: payloadFor(req9, built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });
    // 09b TTL already passed.
    add({
      id: "09b-ttl-expired",
      rule: "7",
      description: "current slot is past the TTL",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: { ...baseChain(inputSnapshots(built.transaction)), currentSlot: TTL_SLOT + 1n },
    });

    // 11 confirmation policy out of range.
    const req11 = requirements(payTo, "2000000", "lovelace", { confirmationPolicy: { l1Confirmations: 21 } });
    add({
      id: "11a-l1-out-of-range",
      rule: "9",
      description: "confirmationPolicy.l1Confirmations above 20",
      requirements: req11,
      payload: payloadFor(req11, built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });
    const req11c = requirements(payTo, "2000000", "lovelace", { confirmationPolicy: { l1Confirmations: 2 } });
    add({
      id: "11b-depth-without-evidence",
      rule: "9",
      description: "l1Confirmations 2 with a backend that cannot read evidence",
      requirements: req11c,
      payload: payloadFor(req11c, built.transaction, nonce),
      chain: { ...baseChain(inputSnapshots(built.transaction)), transactionEvidence: false },
    });
    const req11d = requirements(payTo, "2000000", "lovelace", { confirmationPolicy: { l1Confirmations: -1 } });
    add({
      id: "11c-mempool-policy-without-acceptMempool",
      rule: "9",
      operation: "settle",
      options: { acceptMempool: false },
      description: "l1Confirmations -1, operator did not opt into mempool evidence, submitter reports mempool",
      requirements: req11d,
      payload: payloadFor(req11d, built.transaction, nonce),
      chain: {
        ...baseChain(inputSnapshots(built.transaction)),
        transactionEvidence: false,
        submit: { status: "mempool" },
      },
    });
    add({
      id: "11d-mempool-policy-with-acceptMempool",
      rule: "9",
      operation: "settle",
      options: { acceptMempool: true },
      description: "l1Confirmations -1 with acceptMempool: the node's acceptance settles",
      requirements: req11d,
      payload: payloadFor(req11d, built.transaction, nonce),
      chain: { ...baseChain(inputSnapshots(built.transaction)), submit: { status: "mempool" } },
    });
    add({
      id: "11e-settle-confirmed",
      rule: "9",
      operation: "settle",
      options: { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      description: "default policy, evidence shows one confirmation after submit",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: { ...baseChain(inputSnapshots(built.transaction)), evidenceAfterSubmit: { status: "confirmed", confirmations: 1 } },
    });
    add({
      id: "11f-settle-pending",
      rule: "9",
      operation: "settle",
      options: { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      description: "included but below the required depth → settlement_pending with the transaction id",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: { ...baseChain(inputSnapshots(built.transaction)), evidenceAfterSubmit: { status: "confirmed", confirmations: 0 } },
    });
    add({
      id: "11g-settle-submit-failed",
      rule: "9",
      operation: "settle",
      options: { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      description: "submit throws, evidence unknown, not definitive → settlement failed (claim retained)",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: { ...baseChain(inputSnapshots(built.transaction)), submit: { error: "node unreachable", definitive: false } },
    });
    add({
      id: "11h-settle-definitive-rejection",
      rule: "9",
      operation: "settle",
      options: { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      description: "submit throws a definitive rejection",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: { ...baseChain(inputSnapshots(built.transaction)), submit: { error: "BadInputsUTxO", definitive: true } },
    });

    // Phase-1 data variations (rule 6).
    const unbalanced = inputSnapshots(built.transaction);
    unbalanced[nonce.toLowerCase()] = { ...unbalanced[nonce.toLowerCase()], coin: 11_000_000n };
    add({
      id: "06b-value-not-conserved",
      rule: "6",
      description: "authenticated input value does not balance outputs plus fee",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: baseChain(unbalanced),
    });
    const noValue = inputSnapshots(built.transaction);
    noValue[nonce.toLowerCase()] = { exists: true, address: noValue[nonce.toLowerCase()].address };
    add({
      id: "06c-input-value-unavailable",
      rule: "6",
      description: "chain layer reports an input without its value",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: baseChain(noValue),
    });
    add({
      id: "06d-fee-below-minimum",
      rule: "6",
      description: "fee below minFeeB + minFeeA * size",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: {
        ...baseChain(inputSnapshots(built.transaction)),
        protocolParameters: { ...PROTOCOL_PARAMETERS, minFeeConstant: 10_000_000n },
      },
    });
    add({
      id: "07b-chain-lookup-failed",
      rule: "5",
      description: "input lookup fails at the provider",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: baseChain({ [nonce.toLowerCase()]: { error: "provider timeout" } }),
    });
    add({
      id: "07c-already-on-ledger",
      rule: "5",
      description: "evidence shows the transaction on the ledger; its spent nonce no longer fails verify",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: {
        ...baseChain(spent),
        evidence: { [utils.decodeCardanoTransaction(built.transaction).txHash]: { status: "confirmed", confirmations: 3 } },
      },
    });

    // Invalid signature: flip one byte of the vkey witness signature.
    const tx = Transaction.fromCBORBytes(Buffer.from(built.transaction, "base64"));
    const sig = Buffer.from(tx.witnessSet.vkeyWitnesses[0].signature.bytes).toString("hex");
    const raw = Buffer.from(built.transaction, "base64").toString("hex");
    const flipped = sig.slice(0, -2) + (sig.endsWith("00") ? "01" : "00");
    const badSig = Buffer.from(raw.replace(sig, flipped), "hex").toString("base64");
    add({
      id: "01b-invalid-signature",
      rule: "witness",
      description: "vkey witness signature does not verify over the body hash",
      requirements: req,
      payload: payloadFor(req, badSig, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });
    add({
      id: "01c-garbage-transaction",
      rule: "decode",
      description: "transaction is not CBOR",
      requirements: req,
      payload: payloadFor(req, Buffer.from("not a transaction").toString("base64"), nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });
    add({
      id: "01d-requirements-not-canonical",
      rule: "envelope",
      description: "uppercase asset unit in requirements",
      requirements: requirements(payTo, "2000000", constants.USDM_PREPROD_ASSET.toUpperCase()),
      payload: payloadFor(requirements(payTo, "2000000"), built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });
  }

  // ------------------------------------------------------------ native asset
  {
    const nonce = nextNonce();
    const built = await buildSignedTx({
      payTo,
      asset: constants.USDM_PREPROD_ASSET,
      amount: 1_500_000n,
      nonceUtxoRef: nonce,
      ttlSlot: TTL_SLOT,
    });
    const req = requirements(payTo, "1500000", constants.USDM_PREPROD_ASSET);
    add({
      id: "01e-native-asset-happy",
      rule: "all",
      description: "USDM payment with the min-UTxO lovelace the builder adds",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });
  }

  // ------------------------------------------------------------- min-UTxO
  {
    const nonce = nextNonce();
    const built = await buildSignedTx({
      payTo,
      asset: constants.USDM_PREPROD_ASSET,
      amount: 1_500_000n,
      nonceUtxoRef: nonce,
      ttlSlot: TTL_SLOT,
      outputLovelace: 500_000n,
    });
    const req = requirements(payTo, "1500000", constants.USDM_PREPROD_ASSET);
    add({
      id: "10-below-min-utxo",
      rule: "8",
      description: "payTo output carries less lovelace than the protocol min-UTxO",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });
  }

  // ------------------------------------------------- balance-changing body (8)
  {
    const nonce = nextNonce();
    const mnemonic = PrivateKey.generateMnemonic();
    const client = Client.make(preprod).withBlockfrost({ baseUrl: "http://offline.invalid" }).withSeed({ mnemonic });
    const address = await client.address();
    const payer = Address.toBech32(address);
    const stakeCredential = Address.getStakingCredential(Address.toHex(address));
    const { UTxO, TransactionHash, Assets } = evo;
    const [h, i] = nonce.split("#");
    const funding = Assets.fromLovelace(20_000_000n);
    const utxo = new UTxO.UTxO({
      transactionId: TransactionHash.fromHex(h),
      index: BigInt(i),
      address,
      assets: funding,
      datumOption: undefined,
      scriptRef: undefined,
    });
    const sc = preprod.slotConfig;
    const signBuilder = await client
      .newTx()
      .collectFrom({ inputs: [utxo] })
      .payToAddress({ address: Address.fromBech32(payTo), assets: Assets.fromLovelace(2_000_000n) })
      .registerStakeLegacy({ stakeCredential })
      .setValidity({ to: sc.zeroTime + (TTL_SLOT - sc.zeroSlot) * BigInt(sc.slotLength) })
      .build({
        availableUtxos: [utxo],
        changeAddress: address,
        fullProtocolParameters: {
          minFeeA: 44, minFeeB: 155381, maxTxSize: 16384, maxValSize: 5000,
          keyDeposit: 2_000_000n, poolDeposit: 500_000_000n, drepDeposit: 500_000_000n,
          govActionDeposit: 100_000_000_000n, priceMem: 0.0577, priceStep: 0.0000721,
          maxTxExMem: 14_000_000n, maxTxExSteps: 10_000_000_000n, coinsPerUtxoByte: 4310n,
          collateralPercentage: 150, maxCollateralInputs: 3, minFeeRefScriptCostPerByte: 15,
          costModels: { PlutusV1: {}, PlutusV2: {}, PlutusV3: {} },
        },
      });
    const submitBuilder = await signBuilder.sign();
    const unsigned = await signBuilder.toTransaction();
    const signed = new Transaction.Transaction({
      body: unsigned.body,
      witnessSet: submitBuilder.witnessSet,
      isValid: true,
      auxiliaryData: null,
    });
    const transaction = Buffer.from(Transaction.toCBORBytes(signed)).toString("base64");
    const pkh = Address.getPaymentCredential(Address.toHex(address));
    const req = requirements(payTo, "2000000");
    add({
      id: "08-certificate-present",
      rule: "6",
      description: "transaction carries a stake registration certificate",
      requirements: req,
      payload: payloadFor(req, transaction, nonce),
      chain: baseChain({
        [nonce.toLowerCase()]: {
          exists: true,
          address: payer,
          coin: 20_000_000n,
          assets: {},
          paymentKeyHash: Buffer.from(pkh.hash).toString("hex"),
        },
      }),
    });
  }

  // ---------------------------------------------------------------- masumi
  const masumiPayBy = BigInt(NOW) + 590_000n;
  const issued = await issueMasumiRequirements({
    network: NETWORK,
    amount: "5000000",
    asset: "lovelace",
    payByTimeMs: masumiPayBy,
  });
  const masumiReq = issued.requirements;
  const masumiNonce = nextNonce();
  const lock = await stubs.buildStubMasumiLockTx(
    masumiReq.extra,
    NETWORK,
    masumiReq.payTo,
    "lovelace",
    5_000_000n,
    masumiNonce,
  );
  const masumiChain = baseChain(inputSnapshots(lock.transaction));
  add({
    id: "12-masumi-happy",
    rule: "masumi",
    description: "seller-signed Masumi quote, escrow lock with a FundsLocked datum",
    requirements: masumiReq,
    payload: payloadFor(masumiReq, lock.transaction, lock.nonce),
    chain: masumiChain,
  });
  // A second, different transaction for the same quote (other nonce) — used by MasumiTermsBindingTest.
  const secondNonce = nextNonce();
  const secondLock = await stubs.buildStubMasumiLockTx(
    masumiReq.extra,
    NETWORK,
    masumiReq.payTo,
    "lovelace",
    5_000_000n,
    secondNonce,
  );
  add({
    id: "12b-masumi-second-transaction",
    rule: "masumi",
    description: "another valid lock for the same quote (different nonce)",
    requirements: masumiReq,
    payload: payloadFor(masumiReq, secondLock.transaction, secondLock.nonce),
    chain: baseChain(inputSnapshots(secondLock.transaction)),
  });
  {
    // 13 tampered datum: the lock is built from terms with another sellerNonce.
    const tampered = structuredClone(masumiReq.extra);
    tampered.terms.sellerNonce = "cd".repeat(32);
    const nonce = nextNonce();
    // The stub helper builds the lock (buyer = the stub buyer wallet) from the tampered terms.
    const built = await stubs.buildStubMasumiLockTx(tampered, NETWORK, masumiReq.payTo, "lovelace", 5_000_000n, nonce);
    add({
      id: "13-masumi-tampered-datum",
      rule: "masumi",
      description: "escrow datum seller_nonce differs from the signed terms",
      requirements: masumiReq,
      payload: payloadFor(masumiReq, built.transaction, built.nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });
  }
  {
    // 14 bad COSE signature: flip the last signature byte.
    const sigHex: string = masumiReq.extra.referenceSignature;
    const flippedSig = sigHex.slice(0, -2) + (sigHex.endsWith("00") ? "01" : "00");
    const bad = structuredClone(masumiReq);
    bad.extra.referenceSignature = flippedSig;
    add({
      id: "14-masumi-bad-cose-signature",
      rule: "masumi",
      description: "referenceSignature does not verify over termsDigest",
      requirements: bad,
      payload: payloadFor(bad, lock.transaction, lock.nonce),
      chain: masumiChain,
    });
  }
  {
    // 15 unknown field in the closed schema.
    const bad = structuredClone(masumiReq);
    bad.extra.memo = "hello";
    add({
      id: "15-masumi-unknown-field",
      rule: "masumi",
      description: "extra carries a field outside the closed Masumi schema",
      requirements: bad,
      payload: payloadFor(bad, lock.transaction, lock.nonce),
      chain: masumiChain,
    });
  }
  {
    // Masumi with the wrong payTo (not the escrow of the deployment).
    const bad = structuredClone(masumiReq);
    bad.payTo = payTo;
    add({
      id: "15b-masumi-payto-not-escrow",
      rule: "masumi",
      description: "payTo is not the derived escrow address",
      requirements: bad,
      payload: payloadFor(bad, lock.transaction, lock.nonce),
      chain: masumiChain,
    });
  }
  add({
    id: "12c-masumi-settle",
    rule: "masumi",
    operation: "settle",
    options: { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
    description: "settles a Masumi lock with one confirmation",
    requirements: masumiReq,
    payload: payloadFor(masumiReq, lock.transaction, lock.nonce),
    chain: { ...masumiChain, evidenceAfterSubmit: { status: "confirmed", confirmations: 1 } },
  });

  // ---------------------------------------------------------------- script
  const MINIMAL = stubs.MINIMAL_PLUTUS_V3;
  const scriptTarget = stubs.scriptAddressFor(MINIMAL);
  const datumHex = "d8799f4568656c6c6f182aff";
  {
    const extra = {
      assetTransferMethod: "script",
      script: { type: "plutusV3", code: MINIMAL },
      datum: datumHex,
    };
    const nonce = nextNonce();
    const built = await buildSignedTx({
      payTo: scriptTarget.address,
      asset: "lovelace",
      amount: 3_000_000n,
      nonceUtxoRef: nonce,
      ttlSlot: TTL_SLOT,
      datum: buildScriptDatumInline(extra),
    });
    const req = requirements(scriptTarget.address, "3000000", "lovelace", extra);
    add({
      id: "16-script-happy",
      rule: "script",
      description: "payment to the script address with the declared inline datum",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });

    // 17 wrong datum: the transaction carries another datum than extra.datum.
    const nonce17 = nextNonce();
    const built17 = await buildSignedTx({
      payTo: scriptTarget.address,
      asset: "lovelace",
      amount: 3_000_000n,
      nonceUtxoRef: nonce17,
      ttlSlot: TTL_SLOT,
      datum: buildScriptDatumInline({ ...extra, datum: "d87980" }),
    });
    add({
      id: "17-script-wrong-datum",
      rule: "script",
      description: "output datum differs from extra.datum (TS does not verify script datums)",
      requirements: req,
      payload: payloadFor(req, built17.transaction, nonce17),
      chain: baseChain(inputSnapshots(built17.transaction)),
    });

    // 18 wrong address: payTo is a key address while extra declares a script.
    const nonce18 = nextNonce();
    const built18 = await buildSignedTx({ payTo, asset: "lovelace", amount: 3_000_000n, nonceUtxoRef: nonce18, ttlSlot: TTL_SLOT });
    const req18 = requirements(payTo, "3000000", "lovelace", extra);
    add({
      id: "18-script-wrong-address",
      rule: "script",
      description: "payTo is not the address of the declared script",
      requirements: req18,
      payload: payloadFor(req18, built18.transaction, nonce18),
      chain: baseChain(inputSnapshots(built18.transaction)),
    });
  }
  {
    // Script with parameters applied (bit-level apply-params parity).
    const extra = {
      assetTransferMethod: "script",
      script: { type: "plutusV3", code: MINIMAL },
      parameters: {
        owner: { type: "bytes", value: "deadbeef" },
        "2": { type: "integer", value: 42 },
        flag: { type: "boolean", value: true },
        label: { type: "string", value: "x402" },
      },
    };
    const hash = deriveScriptHashHex(extra);
    const { EnterpriseAddress, ScriptHash } = evo;
    const address = Address.toBech32(
      new EnterpriseAddress.EnterpriseAddress({ networkId: 0, paymentCredential: ScriptHash.fromHex(hash) }),
    );
    const nonce = nextNonce();
    const built = await buildSignedTx({ payTo: address, asset: "lovelace", amount: 3_000_000n, nonceUtxoRef: nonce, ttlSlot: TTL_SLOT });
    const req = requirements(address, "3000000", "lovelace", extra);
    add({
      id: "16b-script-parameters",
      rule: "script",
      description: "script address derived after applying four typed parameters",
      requirements: req,
      payload: payloadFor(req, built.transaction, nonce),
      chain: baseChain(inputSnapshots(built.transaction)),
    });
  }

  // ------------------------------------------------------------ run them all
  for (const fixture of fixtures) {
    const scheme = new Facilitator(signerFor(fixture.chain), {
      settlementStore: new InMemoryCardanoSettlementStore(),
      ...fixture.options,
    });
    try {
      fixture.expected =
        fixture.operation === "verify"
          ? await scheme.verify(fixture.payload, fixture.requirements)
          : await scheme.settle(fixture.payload, fixture.requirements);
    } catch (error) {
      fixture.expected = { thrown: String(error) };
    }
  }

  const supported = [
    { acceptMempool: false, transactionEvidence: true },
    { acceptMempool: true, transactionEvidence: true },
    { acceptMempool: false, transactionEvidence: false },
    { acceptMempool: true, transactionEvidence: false },
  ].map(c => {
    const chain = { ...baseChain({}), transactionEvidence: c.transactionEvidence };
    const scheme = new Facilitator(signerFor(chain), { acceptMempool: c.acceptMempool });
    return { ...c, extra: scheme.getExtra(NETWORK) };
  });

  write("cardano-facilitator.json", {
    now: NOW,
    network: NETWORK,
    fixtures,
    supported,
  });

  // ---------------------------------------------------------- server vectors
  const server = new Server();
  const parsePrice = [];
  const priceCases: Array<[unknown, string]> = [
    ["$0.50", constants.CARDANO_PREPROD_CAIP2],
    ["0.50", constants.CARDANO_MAINNET_CAIP2],
    ["1 USDM", constants.CARDANO_PREPROD_CAIP2],
    ["0.1234567 USD", constants.CARDANO_MAINNET_CAIP2],
    ["$1", constants.CARDANO_PREVIEW_CAIP2],
    ["1.5 ADA", constants.CARDANO_PREPROD_CAIP2],
    ["$0.50", constants.CARDANO_PREPROD_CIP34],
    [{ amount: "1500000", asset: "lovelace" }, constants.CARDANO_PREPROD_CAIP2],
    [{ amount: "1500000", asset: constants.USDM_PREPROD_ASSET, extra: { note: "x" } }, constants.CARDANO_PREPROD_CAIP2],
    [{ amount: "1500000", asset: constants.USDM_PREPROD_ASSET.toUpperCase() }, constants.CARDANO_PREPROD_CAIP2],
    [{ amount: "01", asset: "lovelace" }, constants.CARDANO_PREPROD_CAIP2],
    [{ amount: "0", asset: "lovelace" }, constants.CARDANO_PREPROD_CAIP2],
    ["abc", constants.CARDANO_PREPROD_CAIP2],
  ];
  for (const [price, network] of priceCases) {
    try {
      parsePrice.push({ price, network, result: await server.parsePrice(price, network) });
    } catch (error) {
      parsePrice.push({ price, network, error: (error as Error).message });
    }
  }
  const decimals = [
    [constants.USDM_PREPROD_ASSET, constants.CARDANO_PREPROD_CAIP2],
    [constants.USDM_PREPROD_ASSET.toUpperCase(), constants.CARDANO_PREPROD_CAIP2],
    [constants.USDM_MAINNET_ASSET, constants.CARDANO_MAINNET_CAIP2],
    [constants.USDM_MAINNET_ASSET, constants.CARDANO_PREPROD_CAIP2],
    ["lovelace", constants.CARDANO_PREPROD_CAIP2],
    [constants.USDM_PREPROD_ASSET, constants.CARDANO_PREVIEW_CAIP2],
  ].map(([asset, network]) => ({ asset, network, result: server.getAssetDecimals(asset, network) ?? null }));

  const kind = (extra: unknown, network = NETWORK) => ({ x402Version: 2, scheme: "exact", network, ...(extra === undefined ? {} : { extra }) });
  const fullAdvert = {
    assetTransferMethods: ["default", "masumi", "script"],
    areFeesSponsored: false,
    l1Confirmations: { minimum: 0, maximum: 20 },
  };
  const enhanceCases: Array<[string, Record<string, unknown>, unknown]> = [
    ["no-advertisement", requirements(payTo, "1000000"), undefined],
    ["full-advertisement", requirements(payTo, "1000000", "lovelace", { assetTransferMethod: "default" }), fullAdvert],
    ["sponsored-not-boolean", requirements(payTo, "1000000"), { ...fullAdvert, areFeesSponsored: "no" }],
    ["method-missing", requirements(payTo, "1000000", "lovelace", { assetTransferMethod: "script" }), { ...fullAdvert, assetTransferMethods: ["default"] }],
    ["no-methods", requirements(payTo, "1000000"), { l1Confirmations: { minimum: 0, maximum: 20 } }],
    ["depth-out-of-range", requirements(payTo, "1000000", "lovelace", { confirmationPolicy: { l1Confirmations: 3 } }), { ...fullAdvert, l1Confirmations: { minimum: 0, maximum: 0 } }],
    ["mempool-allowed", requirements(payTo, "1000000", "lovelace", { confirmationPolicy: { l1Confirmations: -1 } }), { ...fullAdvert, l1Confirmations: { minimum: -1, maximum: 20 } }],
    ["bad-policy", requirements(payTo, "1000000", "lovelace", { confirmationPolicy: { l1Confirmations: 1, x: 1 } }), fullAdvert],
    ["no-range", requirements(payTo, "1000000"), { assetTransferMethods: ["default"] }],
    // An array-shaped advertisement is not exported: Java's SupportedKind.extra is a Map, so the
    // TS "malformed capability block" branch is unreachable there.
    ["masumi-issued", masumiReq, fullAdvert],
    ["masumi-template-without-issuer", requirements(masumiReq.payTo, "1000000", "lovelace", { assetTransferMethod: "masumi" }), fullAdvert],
    ["non-cardano-kind", requirements(payTo, "1000000"), fullAdvert],
  ];
  const enhance = [];
  for (const [name, req, advert] of enhanceCases) {
    const supportedKind = name === "non-cardano-kind" ? kind(advert, "eip155:8453") : kind(advert);
    try {
      enhance.push({ name, requirements: req, supportedKind, result: await server.enhancePaymentRequirements(req, supportedKind, []) });
    } catch (error) {
      enhance.push({ name, requirements: req, supportedKind, error: (error as Error).message });
    }
  }
  write("cardano-server.json", { parsePrice, getAssetDecimals: decimals, enhance });

  // ---------------------------------------------------------- masumi digests
  const jcsValues: unknown[] = [
    { b: 1, a: [true, false, null], c: "x" },
    { num: [0, -0, 1, -1, 0.5, 1e21, 1e-7, 123456789012345680000, 0.1, 1.5e-10, 5e-324, 1.7976931348623157e308, 100, 1e20, 0.000001] },
    { s: "\u0000\u0008\t\n\u000c\r\u001f\"\\/ä€😀 " },
    { "é": 1, e: 2, E: 3, "": 4, "😀": 5, "￿": 6 },
    [],
    {},
    "plain",
    [{ nested: { deeper: [1, { x: "y" }] } }],
  ];
  const jcsVectors = jcsValues.map(value => ({ value, jcs: jcs(value) }));

  const parts = [
    { name: "body", canonicalization: "jcs", mediaType: "application/json", content: { days: 3, units: "metric" } },
    { name: "raw", canonicalization: "raw", content: "aGVsbG8gd29ybGQ" },
    { name: "empty", canonicalization: "raw", content: "" },
    { name: "num", canonicalization: "jcs", content: [1.5, 100, "x"] },
  ];
  const partDigests = parts.map(p => ({ part: p, digest: digests.commitmentPartDigest(p) }));
  const commitment = {
    version: "1",
    algorithm: "sha256",
    parts: parts.map(p => ({ name: p.name, canonicalization: p.canonicalization, ...(p.mediaType ? { mediaType: p.mediaType } : {}), digest: digests.commitmentPartDigest(p) })),
    digest: "",
  };
  const inputHash = digests.computeInputHash(commitment);

  const termsCases = [masumiReq];
  {
    // Variants: null agentIdentifier, empty agentIdentifier, seller return address, deployment.
    for (const agentIdentifier of [null, ""]) {
      const v = await issueMasumiRequirements({ network: NETWORK, amount: "1", asset: "lovelace", payByTimeMs: masumiPayBy, agentIdentifier });
      termsCases.push(v.requirements);
    }
    const ret = freshKeyAddress(NETWORK).address;
    termsCases.push((await issueMasumiRequirements({ network: NETWORK, amount: "7", asset: constants.USDM_PREPROD_ASSET, payByTimeMs: masumiPayBy, sellerReturnAddress: ret, buyerNonce: "0102030405060708" })).requirements);
  }
  const termsDigests = termsCases.map(r => ({
    requirements: r,
    signedTerms: digests.buildSignedTerms(r.extra, r),
    termsDigest: digests.computeTermsDigest(digests.buildSignedTerms(r.extra, r)),
    signatureValid: verifySellerTermsSignature(
      r.extra.referenceKey,
      r.extra.referenceSignature,
      r.extra.terms.sellerAddress,
      digests.computeTermsDigest(digests.buildSignedTerms(r.extra, r)),
    ),
    identifier: identifier.decodeBlockchainIdentifier(r.extra.blockchainIdentifier),
    schemaOk: validateMasumiExtra(r.extra, r.network).ok,
  }));

  const identifierTexts = [
    { sellerNonce: "ab".repeat(32), agentIdentifier: "", buyerNonce: "", referenceSignature: "84", referenceKey: "a4", contractAddress: masumiReq.payTo },
    { sellerNonce: "00".repeat(32), agentIdentifier: "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b0011", buyerNonce: "0102030405060708", referenceSignature: masumiReq.extra.referenceSignature, referenceKey: masumiReq.extra.referenceKey, contractAddress: masumiReq.payTo },
  ].map(parts => ({ parts, text: identifier.buildIdentifierText(parts), encoded: identifier.encodeBlockchainIdentifier(parts) }));

  const deployments = [
    blueprint.MASUMI_DEFAULT_DEPLOYMENT,
    { requiredAdmins: "1", adminVkeys: ["fc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75"], cooldownPeriod: "0" },
    { requiredAdmins: "2", adminVkeys: ["fc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75", "fc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75"], cooldownPeriod: "18446744073709551616" },
  ];
  const escrow = deployments.flatMap(d =>
    [constants.CARDANO_PREPROD_CAIP2, constants.CARDANO_MAINNET_CAIP2].map(network => ({
      network,
      deployment: d,
      scriptHash: blueprint.masumiEscrowScriptHash(d),
      address: blueprint.masumiEscrowAddress(network, d),
    })),
  );

  const scriptExtras: Record<string, unknown>[] = [
    { script: { type: "plutusV3", code: MINIMAL } },
    { script: { type: "plutusV2", code: MINIMAL } },
    { script: { type: "plutusV1", code: MINIMAL } },
    { script: { type: "plutusV3", code: MINIMAL }, parameters: { a: { type: "bytes", value: "" } } },
    { script: { type: "plutusV3", code: MINIMAL }, parameters: { big: { type: "bigint", value: "-123456789012345678901234567890" } } },
    { script: { type: "plutusV3", code: MINIMAL }, parameters: { z: { type: "integer", value: 1 }, "10": { type: "integer", value: 2 }, "1": { type: "integer", value: 3 }, a: { type: "boolean", value: false } } },
    { script: { type: "plutusV3", code: MINIMAL }, parameters: { long: { type: "bytes", value: "ab".repeat(100) } } },
    { script: { type: "plutusV3", code: MINIMAL }, parameters: { s: { type: "string", value: "héllo" } } },
    { scriptHash: "ab".repeat(28) },
    { script: { type: "plutusV3", code: blueprint.MASUMI_VALIDATOR_TITLE ? src("exact/masumi/blueprintCode.ts").MASUMI_VESTED_PAY_COMPILED_CODE : MINIMAL }, parameters: { a: { type: "integer", value: 2 } } },
  ];
  const scriptHashes = scriptExtras.map(extra => {
    try {
      return { extra, scriptHash: deriveScriptHashHex(extra) };
    } catch (error) {
      return { extra, error: (error as Error).message };
    }
  });

  // Deterministic seller signer and issuance (fixed key, nonce and deadlines).
  const SELLER_MNEMONIC =
    "test walk nut penalty hip pave soap entry language right filter choice";
  const seller = toMasumiSellerSigner({ mnemonic: SELLER_MNEMONIC, network: NETWORK });
  const sellerSignature = await seller.signTerms(seller.sellerAddress, "11".repeat(32));
  const fixedIssue = await issueRaw({
    network: NETWORK,
    asset: "lovelace",
    amount: "5000000",
    maxTimeoutSeconds: 600,
    sellerAddress: seller.sellerAddress,
    signTerms: seller.signTerms,
    commitment: [
      { name: "resource", canonicalization: "jcs", mediaType: "application/json", content: { url: "https://api.example.com/jobs" } },
    ],
    payByTime: "1785756000000",
    submitResultTime: "1785756900000",
    unlockTime: "1785758100000",
    externalDisputeUnlockTime: "1785759300000",
    sellerNonce: "5a".repeat(32),
    confirmationPolicy: { l1Confirmations: 0 },
    unsafeSkipPolicyChecks: true,
  });

  write("masumi-digests.json", {
    jcs: jcsVectors,
    partDigests,
    commitment: { ...commitment, digest: inputHash },
    termsDigests,
    identifiers: identifierTexts,
    escrow,
    scriptHashes,
    seller: {
      mnemonic: SELLER_MNEMONIC,
      network: NETWORK,
      sellerAddress: seller.sellerAddress,
      digest: "11".repeat(32),
      key: sellerSignature.key,
      signature: sellerSignature.signature,
      issued: fixedIssue,
    },
    datum: {
      requirements: masumiReq,
      transaction: lock.transaction,
      datumHex: (() => {
        const out = utils
          .decodeCardanoTransaction(lock.transaction)
          .outputs.find((o: { address: string }) => o.address === masumiReq.payTo);
        return out?.datum;
      })(),
    },
  });

}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
