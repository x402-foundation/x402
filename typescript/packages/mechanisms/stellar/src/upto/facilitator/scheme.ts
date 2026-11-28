import {
  Account,
  Address,
  BASE_FEE,
  FeeBumpTransaction,
  Operation,
  Transaction,
  TransactionBuilder,
  hash,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { STELLAR_WILDCARD_CAIP2 } from "../../constants";
import {
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  isStellarNetwork,
  type RpcConfig,
} from "../../utils";
import {
  DEFAULT_MAX_TIMEOUT_SECONDS,
  DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
  UPTO_DEPLOYMENTS,
  UPTO_SCHEME,
} from "../constants";
import { reject, type UptoCode, type UptoRejection } from "../errors";
import { isAccountAddress, parseAtomicAmount, resolveUptoContract } from "../shared";
import { authorityEntry, settleInvokeArgs } from "../terms";
import { checkProtocol, checkUptoPayment, type CheckedUptoPayment } from "./rules";
import {
  archivedKeys,
  archivedStateRejection,
  checkSimulationEvents,
  classifySimulationFailure,
  hostErrors,
  hostErrorsFromMessage,
  type SettlementParties,
} from "./simulation";
import type { FacilitatorStellarSigner } from "../../signer";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

/** Confirmation polling: attempts, one second apart. */
const CONFIRMATION_ATTEMPTS = 30;
/** Ledgers a settlement record is kept after its authorization expires, to answer repeats. */
const RECORD_RETENTION_LEDGERS = 120;

export interface UptoStellarFacilitatorOptions {
  readonly rpcConfig?: RpcConfig;
  /** The `G…` settlement authority named in the terms and used as the operation source (default: the first signer). */
  readonly settlementAuthority?: FacilitatorStellarSigner;
  /** Pays the fees through a fee bump. */
  readonly feeBumpSigner?: FacilitatorStellarSigner;
  /** Settlement contracts by network, for networks without a canonical deployment. */
  readonly contracts?: Readonly<Record<string, string>>;
  /** Inclusion fee bid of the transaction and of the fee bump, in stroops (default 100). */
  readonly inclusionFeeStroops?: number;
  /** Ceiling on the settlement fee in stroops (default 500,000). */
  readonly maxTransactionFeeStroops?: number;
  /** Largest `maxTimeoutSeconds` accepted (default 300). */
  readonly maxTimeoutSeconds?: number;
  /** Asset allow-list; every SEP-41 token is accepted when absent. */
  readonly isAssetAccepted?: (asset: string, network: string) => boolean;
}

interface Checked {
  readonly payment: CheckedUptoPayment;
  readonly network: Network;
  readonly contract: string;
  readonly server: rpc.Server;
  readonly currentLedger: number;
  readonly parties: SettlementParties;
  /** Rule 7's refusal, deferred at `settle` until the duplicate records are consulted. */
  readonly expiration?: UptoRejection;
}

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: UptoRejection; readonly payer?: string };

interface SettlementRecord {
  /** Binds the request: the signed entries and the amount. */
  readonly requestHash: string;
  readonly expirationLedger: number;
  result: Promise<SettleResponse>;
}

/**
 * Stellar facilitator for the x402 `upto` scheme.
 *
 * `verify` checks the payment for its maximum and simulates `settle(payer, terms, max)`. `settle`
 * re-checks it for `requirements.amount`, simulates again and submits the invocation: a signer is
 * the transaction source, the settlement authority the operation source, and an optional fee-bump
 * signer pays the fee. A zero amount is settled on-chain too. A repeat of a settlement returns its
 * result, also after the authorization expires, and a repeat for another amount is refused. These
 * records live in this process's memory for a while after the authorization expires.
 */
export class UptoStellarScheme implements SchemeNetworkFacilitator {
  readonly scheme = UPTO_SCHEME;
  readonly caipFamily = STELLAR_WILDCARD_CAIP2;
  readonly authority: FacilitatorStellarSigner;

  private readonly signers: readonly FacilitatorStellarSigner[];
  private readonly options: UptoStellarFacilitatorOptions;
  private readonly facilitatorAddresses: ReadonlySet<string>;
  private readonly settlements = new Map<string, SettlementRecord>();
  private readonly wasmHashes = new Map<string, string>();
  private readonly inclusionFee: string;
  private nextSigner = 0;

  /**
   * Creates the facilitator mechanism.
   *
   * @param signers - Transaction sources for settlements; at least one
   * @param options - See {@link UptoStellarFacilitatorOptions}
   */
  constructor(
    signers: readonly FacilitatorStellarSigner[],
    options: UptoStellarFacilitatorOptions = {},
  ) {
    const authority = options.settlementAuthority ?? signers[0];
    if (authority === undefined) throw new Error("at least one signer is required");
    if (!isAccountAddress(authority.address)) {
      throw new Error("the settlement authority must be a G… account");
    }
    this.authority = authority;
    this.signers = signers;
    this.options = options;
    this.inclusionFee = String(options.inclusionFeeStroops ?? BASE_FEE);
    this.facilitatorAddresses = new Set(this.getSigners());
  }

  /**
   * `extra` of the supported kind.
   *
   * @param _ - The network
   * @returns `areFeesSponsored` and the settlement authority
   */
  getExtra(_: Network): Record<string, unknown> {
    return { areFeesSponsored: true, facilitatorAddress: this.authority.address };
  }

  /**
   * The addresses this facilitator signs with.
   *
   * @param _ - The network
   * @returns The signers, the settlement authority and the fee-bump signer
   */
  getSigners(_?: string): string[] {
    const feeBump = this.options.feeBumpSigner;
    return [
      ...new Set([
        ...this.signers.map(signer => signer.address),
        this.authority.address,
        ...(feeBump === undefined ? [] : [feeBump.address]),
      ]),
    ];
  }

  /**
   * Verifies a payment for its maximum. Writes nothing.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements; `amount` is the maximum
   * @returns The verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    let payer: string | undefined;
    try {
      const checked = await this.check(payload, requirements, "verify");
      if (!checked.ok) return invalid(checked.rejection, checked.payer);
      payer = checked.value.payment.payer;
      const simulated = await this.simulate(checked.value, this.simulationSource());
      return simulated.ok ? { isValid: true, payer } : invalid(simulated.rejection, payer);
    } catch (error) {
      return invalid(reject("unexpected_verify_error", errorMessage(error)), payer);
    }
  }

  /**
   * Settles `requirements.amount`, from zero up to the accepted maximum.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements; `amount` is the amount to settle
   * @returns The settlement response; `amount` is always set when it is valid
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const { network } = requirements;
    const amount = parseAtomicAmount(requirements.amount)?.toString();
    let payer: string | undefined;
    try {
      const checked = await this.check(payload, requirements, "settle");
      if (!checked.ok) return failed(network, checked.rejection, checked.payer, amount);
      const { payment, currentLedger, expiration } = checked.value;
      payer = payment.payer;

      for (const [key, record] of this.settlements) {
        if (record.expirationLedger + RECORD_RETENTION_LEDGERS < currentLedger) {
          this.settlements.delete(key);
        }
      }
      const key = `${network}:${payer}:${payment.nonce}`;
      const body = payload.payload as { authorization: string; signerAuthorizations?: string[] };
      const requestHash = hash(
        Buffer.from(
          [body.authorization, ...(body.signerAuthorizations ?? []), payment.amount].join("\n"),
        ),
      ).toString("hex");

      const existing = this.settlements.get(key);
      if (existing !== undefined) {
        if (existing.requestHash === requestHash) return await this.repeat(existing, checked.value);
        const original = await existing.result;
        if (this.settlements.get(key) !== existing) return await this.settle(payload, requirements);
        const { transaction } = original;
        return failed(
          network,
          reject(
            "settle_upto_stellar_idempotency_conflict",
            `This authorization was already submitted in another settlement request${transaction === "" ? "" : ` (transaction ${transaction})`}.`,
          ),
          payer,
          amount,
          transaction,
        );
      }
      // Only a repeat is answered after the expiration window closes.
      if (expiration !== undefined) return failed(network, expiration, payer, amount);

      const record: SettlementRecord = {
        requestHash,
        expirationLedger: payment.terms.expirationLedger,
        result: this.execute(checked.value),
      };
      this.settlements.set(key, record);
      const result = await record.result;
      // Nothing reached the network: the payment may be settled again.
      if (!result.success && result.transaction === "") this.settlements.delete(key);
      return result;
    } catch (error) {
      return failed(network, reject("unexpected_settle_error", errorMessage(error)), payer, amount);
    }
  }

  /**
   * Static rules 1–9 at the current ledger.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements
   * @param phase - `verify` or `settle`
   * @returns The checked payment, or a refusal
   */
  private async check(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    phase: "verify" | "settle",
  ): Promise<Result<Checked>> {
    const network = requirements.network;
    const protocol = checkProtocol(payload, requirements);
    if (protocol !== undefined) return { ok: false, rejection: protocol };
    const contract = isStellarNetwork(network)
      ? resolveUptoContract(network, this.options.contracts)
      : undefined;
    if (contract === undefined) return { ok: false, rejection: reject("invalid_network") };
    const server = getRpcClient(network, this.options.rpcConfig);
    const [latest, ledgerSeconds] = await Promise.all([
      server.getLatestLedger(),
      getEstimatedLedgerCloseTimeSeconds(network),
    ]);
    const result = checkUptoPayment(payload, requirements, {
      phase,
      contract,
      authority: this.authority.address,
      facilitatorAddresses: this.facilitatorAddresses,
      currentLedger: latest.sequence,
      ledgerSeconds,
      maxTimeoutSeconds: this.options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
      isAssetAccepted: this.options.isAssetAccepted,
      deferExpiration: phase === "settle",
    });
    if (!result.ok) return result;
    const { payment, expiration } = result;
    return {
      ok: true,
      value: {
        payment,
        network,
        contract,
        server,
        currentLedger: latest.sequence,
        ...(expiration === undefined ? {} : { expiration }),
        parties: {
          contract,
          token: payment.terms.token,
          payer: payment.payer,
          recipient: payment.terms.recipient,
          authority: this.authority.address,
          facilitatorAddresses: this.facilitatorAddresses,
        },
      },
    };
  }

  /**
   * Builds and simulates the settlement (rules 10–12), returning the assembled transaction.
   *
   * @param checked - The checked payment
   * @param source - The transaction source account
   * @returns The assembled transaction, or a refusal
   */
  private async simulate(checked: Checked, source: Account): Promise<Result<Transaction>> {
    const { payment, contract, network, parties } = checked;
    const draft = new TransactionBuilder(source, {
      fee: this.inclusionFee,
      networkPassphrase: getNetworkPassphrase(network),
      // Exclusive bound: the settlement cannot be included after the authorization expires.
      ledgerbounds: { minLedger: 0, maxLedger: payment.terms.expirationLedger + 1 },
    })
      .setTimeout(this.options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS)
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            settleInvokeArgs(contract, payment.payer, payment.terms, payment.amount),
          ),
          auth: [
            payment.entry,
            ...payment.signerAuthorizations,
            authorityEntry(contract, payment.payer, payment.terms, payment.amount),
          ],
          source: this.authority.address,
        }),
      )
      .build();
    const simulation = await checked.server.simulateTransaction(draft);

    const refuse = (rejection: UptoRejection): Result<Transaction> => ({ ok: false, rejection });
    if (rpc.Api.isSimulationError(simulation)) {
      const errors = hostErrors(simulation.events);
      return refuse(
        classifySimulationFailure(
          errors.length > 0 ? errors : hostErrorsFromMessage(simulation.error),
          parties,
          simulation.error,
        ),
      );
    }
    if (rpc.Api.isSimulationRestore(simulation)) {
      return refuse(
        (await this.archivedState(simulation.restorePreamble.transactionData.build(), checked)) ??
          reject("invalid_upto_stellar_payload_archived_state"),
      );
    }
    const archived = await this.archivedState(simulation.transactionData.build(), checked);
    if (archived !== undefined) return refuse(archived);

    // A fee bump pays the inclusion fee once more for itself.
    const inclusionFees = this.options.feeBumpSigner === undefined ? 1 : 2;
    const fee = Number(simulation.minResourceFee) + Number(this.inclusionFee) * inclusionFees;
    const ceiling = this.options.maxTransactionFeeStroops ?? DEFAULT_MAX_TRANSACTION_FEE_STROOPS;
    if (!(fee <= ceiling)) {
      return refuse(
        reject(
          "invalid_upto_stellar_payload_fee_exceeds_maximum",
          `The settlement fee would be ${fee} stroops; the ceiling is ${ceiling}.`,
        ),
      );
    }
    const events = checkSimulationEvents(
      simulation.events,
      parties,
      payment.amount,
      payment.maxAmount,
    );
    if (events !== undefined) return refuse(events);
    return { ok: true, value: rpc.assembleTransaction(draft, simulation).build() };
  }

  /**
   * Refuses a simulation that needs archived entries restored.
   *
   * @param data - The simulated transaction data
   * @param checked - The checked payment
   * @returns The refusal, or `undefined` when nothing is archived
   */
  private async archivedState(
    data: xdr.SorobanTransactionData,
    checked: Checked,
  ): Promise<UptoRejection | undefined> {
    const keys = archivedKeys(data);
    if (keys.length === 0) return undefined;
    const code = keys.some(key => key.switch() === xdr.LedgerEntryType.contractCode());
    const wasmHash = code ? await this.contractWasmHash(checked) : undefined;
    return archivedStateRejection(keys, checked.contract, wasmHash);
  }

  /**
   * The WASM hash of the settlement contract: the canonical deployment's, or read from its instance.
   *
   * @param checked - The checked payment
   * @returns The hex hash, or `undefined` when it cannot be read
   */
  private async contractWasmHash(checked: Checked): Promise<string | undefined> {
    const { contract, network, server } = checked;
    const deployment = UPTO_DEPLOYMENTS[network];
    if (deployment?.address === contract) return deployment.wasmHash;
    const known = this.wasmHashes.get(contract);
    if (known !== undefined) return known;
    try {
      const instanceKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: Address.fromString(contract).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );
      const [entry] = (await server.getLedgerEntries(instanceKey)).entries;
      const executable = entry?.val.contractData().val().instance().executable();
      if (executable?.switch() !== xdr.ContractExecutableType.contractExecutableWasm()) {
        return undefined;
      }
      const wasmHash = executable.wasmHash().toString("hex");
      this.wasmHashes.set(contract, wasmHash);
      return wasmHash;
    } catch {
      return undefined;
    }
  }

  /**
   * Simulates, signs and submits the settlement. Never rejects.
   *
   * @param checked - The checked payment
   * @returns The settlement response
   */
  private async execute(checked: Checked): Promise<SettleResponse> {
    const { payment, network, server } = checked;
    const { payer } = payment;
    const amount = payment.amount.toString();
    const fail = (code: UptoCode, reason?: string, transaction = "") =>
      failed(network, reject(code, reason), payer, amount, transaction);
    try {
      const signer = this.signers[this.nextSigner++ % this.signers.length] ?? this.authority;
      const simulated = await this.simulate(checked, await server.getAccount(signer.address));
      if (!simulated.ok) return failed(network, simulated.rejection, payer, amount);

      const networkPassphrase = getNetworkPassphrase(network);
      let signed = simulated.value.toXDR();
      for (const key of signer.address === this.authority.address
        ? [signer]
        : [signer, this.authority]) {
        const result = await key.signTransaction(signed, { networkPassphrase });
        if (result.error !== undefined)
          return fail("settle_upto_stellar_transaction_signing_failed");
        signed = result.signedTxXdr;
      }
      let envelope: Transaction | FeeBumpTransaction = new Transaction(signed, networkPassphrase);
      const feeBumpSigner = this.options.feeBumpSigner;
      if (feeBumpSigner !== undefined) {
        const bump = TransactionBuilder.buildFeeBumpTransaction(
          feeBumpSigner.address,
          this.inclusionFee,
          envelope,
          networkPassphrase,
        );
        const result = await feeBumpSigner.signTransaction(bump.toXDR(), { networkPassphrase });
        if (result.error !== undefined) return fail("settle_upto_stellar_fee_bump_signing_failed");
        envelope = new FeeBumpTransaction(result.signedTxXdr, networkPassphrase);
      }

      const transaction = envelope.hash().toString("hex");
      let sent: rpc.Api.SendTransactionResponse;
      try {
        sent = await server.sendTransaction(envelope);
      } catch {
        // The RPC may have forwarded it before failing: it can still land.
        return fail("settlement_pending", undefined, transaction);
      }
      if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
        const code = resultCode(sent.errorResult);
        return fail(
          "settle_upto_stellar_transaction_submission_failed",
          `The network refused the settlement (${code ?? sent.status}); no funds moved.`,
        );
      }
      return await this.confirm(server, transaction, network, payer, amount);
    } catch (error) {
      // Thrown before anything was submitted.
      return fail("unexpected_settle_error", errorMessage(error));
    }
  }

  /**
   * Polls a submitted settlement until it succeeds or fails, or answers `settlement_pending`.
   *
   * @param server - The RPC client
   * @param transaction - The submitted transaction's hash
   * @param network - The network
   * @param payer - The payer
   * @param amount - The settled amount
   * @returns The settlement response
   */
  private async confirm(
    server: rpc.Server,
    transaction: string,
    network: Network,
    payer: string,
    amount: string,
  ): Promise<SettleResponse> {
    for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1000));
      const result = await server.getTransaction(transaction).catch(() => undefined);
      if (result?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { success: true, transaction, network, payer, amount };
      }
      if (result?.status === rpc.Api.GetTransactionStatus.FAILED) {
        const code = resultCode(result.resultXdr);
        const rejection =
          code === "txTooLate"
            ? reject("settle_upto_stellar_transaction_expired")
            : reject(
                "settle_upto_stellar_transaction_failed",
                `The settlement transaction failed (${code ?? "unknown"}); no funds moved.`,
              );
        return failed(network, rejection, payer, amount, transaction);
      }
    }
    return failed(network, reject("settlement_pending"), payer, amount, transaction);
  }

  /**
   * A repeat of a recorded settlement: its result, polled again while it is pending.
   *
   * @param record - The recorded settlement
   * @param checked - The checked payment
   * @returns The settlement response
   */
  private async repeat(record: SettlementRecord, checked: Checked): Promise<SettleResponse> {
    const previous = await record.result;
    if (previous.errorReason !== "settlement_pending") return previous;
    const { server, network, payment } = checked;
    const amount = payment.amount.toString();
    record.result = this.confirm(server, previous.transaction, network, payment.payer, amount);
    return record.result;
  }

  /**
   * The source of simulations that submit nothing.
   *
   * @returns The first signer, at sequence 0
   */
  private simulationSource(): Account {
    return new Account((this.signers[0] ?? this.authority).address, "0");
  }
}

/**
 * A negative verification response.
 *
 * @param rejection - The refusal
 * @param payer - The payer, when known
 * @returns The response
 */
function invalid(rejection: UptoRejection, payer: string | undefined): VerifyResponse {
  return { isValid: false, invalidReason: rejection.code, invalidMessage: rejection.reason, payer };
}

/**
 * A failed settlement response.
 *
 * @param network - The network
 * @param rejection - The refusal
 * @param payer - The payer, when known
 * @param amount - The requested amount, when valid
 * @param transaction - The transaction hash, when one was submitted
 * @returns The response
 */
function failed(
  network: Network,
  rejection: UptoRejection,
  payer: string | undefined,
  amount: string | undefined,
  transaction = "",
): SettleResponse {
  return {
    success: false,
    errorReason: rejection.code,
    errorMessage: rejection.reason,
    transaction,
    network,
    payer,
    ...(amount === undefined ? {} : { amount }),
  };
}

/**
 * The result code of a transaction, looking inside a fee bump.
 *
 * @param result - The transaction result
 * @returns The code's name, or `undefined`
 */
function resultCode(result: xdr.TransactionResult | undefined): string | undefined {
  try {
    const outer = result?.result();
    return outer?.switch() === xdr.TransactionResultCode.txFeeBumpInnerFailed()
      ? outer.innerResultPair().result().result().switch().name
      : outer?.switch().name;
  } catch {
    return undefined;
  }
}

/**
 * The message of a thrown value.
 *
 * @param error - The thrown value
 * @returns Its message
 */
function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}
