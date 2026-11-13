import {
  Account,
  Address,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  authorizeEntry,
  hash,
  nativeToScVal,
  rpc,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "../../src/constants";
import { createEd25519Signer } from "../../src/signer";
import { unsignedPayerEntry, type UptoTerms } from "../../src/upto";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

export const NETWORK = "stellar:testnet" as const;
export const LEDGER = 1_000;
export const TOKEN = USDC_TESTNET_ADDRESS;
export const CONTRACT = StrKey.encodeContract(hash(Buffer.from("upto unit tests: contract")));
export const CAP = 1_000_000n;

const key = (seed: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed));
export const payer = key(21);
export const authority = key(22);
export const recipient = key(23);
export const channel = key(24);
export const sponsor = key(25);
export const authoritySigner = createEd25519Signer(authority.secret(), NETWORK);
export const channelSigner = createEd25519Signer(channel.secret(), NETWORK);
export const sponsorSigner = createEd25519Signer(sponsor.secret(), NETWORK);

export const requirements = (
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements => ({
  scheme: "upto",
  network: NETWORK,
  amount: CAP.toString(),
  asset: TOKEN,
  payTo: recipient.publicKey(),
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true, facilitatorAddress: authority.publicKey() },
  ...overrides,
});

export const terms = (overrides: Partial<UptoTerms> = {}): UptoTerms => ({
  expirationLedger: LEDGER + 12,
  facilitator: authority.publicKey(),
  maxAmount: CAP,
  recipient: recipient.publicKey(),
  token: TOKEN,
  validAfterLedger: 0,
  ...overrides,
});

let nextNonce = 1n;

/**
 * A payer entry signed by `key` (the payer by default) for `terms`.
 *
 * @param options - The terms and the signing key
 * @param options.terms - The terms
 * @param options.key - The signing key
 * @returns Base64 XDR of the entry
 */
export async function signedAuthorization(
  options: { terms?: UptoTerms; key?: Keypair } = {},
): Promise<string> {
  const signingKey = options.key ?? payer;
  const t = options.terms ?? terms();
  const entry = unsignedPayerEntry({
    contract: CONTRACT,
    payer: signingKey.publicKey(),
    terms: t,
    nonce: nextNonce++,
  });
  return (await authorizeEntry(entry, signingKey, t.expirationLedger, Networks.TESTNET)).toXDR(
    "base64",
  );
}

/**
 * A payment payload for the default requirements.
 *
 * @param options - Overrides
 * @param options.requirements - The accepted requirements
 * @param options.authorization - The payer entry
 * @returns The payload
 */
export async function payment(
  options: { requirements?: PaymentRequirements; authorization?: string } = {},
): Promise<PaymentPayload> {
  return {
    x402Version: 2,
    accepted: options.requirements ?? requirements(),
    payload: { authorization: options.authorization ?? (await signedAuthorization()) },
  };
}

export const address = (value: string) => nativeToScVal(value, { type: "address" });
export const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const sym = (value: string) => xdr.ScVal.scvSymbol(value);
const map = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.entries(fields).map(([k, val]) => new xdr.ScMapEntry({ key: sym(k), val })),
  );

/**
 * A diagnostic event of a contract.
 *
 * @param contract - The emitting contract, or undefined for the host
 * @param topics - The topics
 * @param data - The data
 * @param successful - Whether the call that emitted it succeeded
 * @param type - Contract or diagnostic event
 * @returns The event
 */
export function contractEvent(
  contract: string | undefined,
  topics: xdr.ScVal[],
  data: xdr.ScVal,
  successful = true,
  type = xdr.ContractEventType.contract(),
): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: successful,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId:
        contract === undefined
          ? null
          : (Address.fromString(contract).toBuffer() as unknown as xdr.ContractId),
      type,
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
    }),
  });
}

export const errorEvent = (
  contract: string | undefined,
  error: xdr.ScError,
  message = "error",
  ...args: xdr.ScVal[]
) =>
  contractEvent(
    contract,
    [sym("error"), xdr.ScVal.scvError(error)],
    xdr.ScVal.scvVec([xdr.ScVal.scvString(message), ...args]),
    false,
    xdr.ContractEventType.diagnostic(),
  );

export const transferEvent = (from: string, to: string, amount: bigint, token = TOKEN) =>
  contractEvent(token, [sym("transfer"), address(from), address(to)], i128(amount));

export const settledEvent = (
  amount: bigint,
  options: { payer?: string; cap?: bigint; facilitator?: string; token?: string } = {},
) =>
  contractEvent(
    CONTRACT,
    [
      sym("upto_settled"),
      address(options.payer ?? payer.publicKey()),
      address(recipient.publicKey()),
    ],
    map({
      amount: i128(amount),
      facilitator: address(options.facilitator ?? authority.publicKey()),
      max_amount: i128(options.cap ?? CAP),
      token: address(options.token ?? TOKEN),
    }),
  );

/**
 * The events a correct settlement of `amount` emits.
 *
 * @param amount - The settled amount
 * @param shape - Stellar Asset Contract (four topics, i128 data) or SEP-41 (three topics, map data)
 * @returns The events
 */
export function settlementEvents(amount: bigint, shape: "sac" | "sep41" = "sac") {
  const from = payer.publicKey();
  const to = recipient.publicKey();
  const transfer =
    shape === "sep41"
      ? contractEvent(
          TOKEN,
          [sym("transfer"), address(from), address(to)],
          map({ amount: i128(amount), to_muxed_id: xdr.ScVal.scvVoid() }),
        )
      : contractEvent(
          TOKEN,
          [sym("transfer"), address(from), address(to), xdr.ScVal.scvString("USDC:ISSUER")],
          i128(amount),
        );
  const approve = contractEvent(
    TOKEN,
    [sym("approve"), address(from), address(CONTRACT)],
    xdr.ScVal.scvVec([i128(CAP), xdr.ScVal.scvU32(LEDGER + 12)]),
  );
  return [...(amount > 0n ? [approve, transfer] : []), settledEvent(amount)];
}

export const successSimulation = (
  events: xdr.DiagnosticEvent[],
  options: { minResourceFee?: number; data?: xdr.SorobanTransactionData } = {},
): rpc.Api.SimulateTransactionSuccessResponse => ({
  id: "1",
  latestLedger: LEDGER,
  events,
  _parsed: true,
  transactionData: new SorobanDataBuilder(options.data).setResourceFee(
    options.minResourceFee ?? 150_000,
  ),
  minResourceFee: String(options.minResourceFee ?? 150_000),
  result: { auth: [], retval: xdr.ScVal.scvVoid() },
});

export const errorSimulation = (
  events: xdr.DiagnosticEvent[],
  error = "HostError",
): rpc.Api.SimulateTransactionErrorResponse => ({
  id: "1",
  latestLedger: LEDGER,
  events,
  _parsed: true,
  error,
});

/** A scripted RPC server: records what the mechanism sends and answers from queues. */
export class FakeRpc {
  ledger = LEDGER;
  simulations: rpc.Api.SimulateTransactionResponse[] = [];
  defaultSimulation?: (transaction: Transaction) => rpc.Api.SimulateTransactionResponse;
  simulated: Transaction[] = [];
  sent: (Transaction | FeeBumpTransaction)[] = [];
  sendStatus: rpc.Api.SendTransactionStatus = "PENDING";
  statuses: rpc.Api.GetTransactionStatus[] = [];
  failedResult?: xdr.TransactionResult;
  /** The settlement contract's WASM hash, returned with its instance. */
  wasmHash?: Buffer;

  getLatestLedger() {
    return Promise.resolve({ id: "x", sequence: this.ledger, protocolVersion: 25 });
  }

  getAccount(account: string) {
    return Promise.resolve(new Account(account, "100"));
  }

  simulateTransaction(transaction: Transaction) {
    this.simulated.push(transaction);
    const next = this.simulations.shift() ?? this.defaultSimulation?.(transaction);
    if (next === undefined) throw new Error("no simulation scripted");
    return Promise.resolve(next);
  }

  sendTransaction(transaction: Transaction | FeeBumpTransaction) {
    this.sent.push(transaction);
    return Promise.resolve({
      status: this.sendStatus,
      hash: transaction.hash().toString("hex"),
      latestLedger: this.ledger,
      latestLedgerCloseTime: 0,
    } as rpc.Api.SendTransactionResponse);
  }

  getLedgerEntries(key: xdr.LedgerKey) {
    const instance = xdr.ScVal.scvContractInstance(
      new xdr.ScContractInstance({
        executable: xdr.ContractExecutable.contractExecutableWasm(
          this.wasmHash ?? Buffer.alloc(32),
        ),
        storage: null,
      }),
    );
    const val = xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: key.contractData().contract(),
        key: key.contractData().key(),
        durability: key.contractData().durability(),
        val: instance,
      }),
    );
    return Promise.resolve({ latestLedger: this.ledger, entries: [{ key, val }] });
  }

  getTransaction(_hash: string) {
    const status = this.statuses.shift() ?? rpc.Api.GetTransactionStatus.SUCCESS;
    return Promise.resolve({
      status,
      resultXdr: this.failedResult,
    } as unknown as rpc.Api.GetTransactionResponse);
  }
}
