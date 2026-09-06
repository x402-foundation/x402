import { Transaction, Address, Operation, xdr } from "@stellar/stellar-sdk";
import { Api, assembleTransaction } from "@stellar/stellar-sdk/rpc";

/**
 * Handles the simulation result of a Stellar transaction.
 *
 * @param simulation - The simulation result to handle
 * @throws An error if the simulation result is of type "RESTORE" or "ERROR"
 */
export function handleSimulationResult(simulation?: Api.SimulateTransactionResponse) {
  if (!simulation) {
    throw new Error("Simulation result is undefined");
  }

  if (Api.isSimulationRestore(simulation)) {
    throw new Error(
      `Stellar simulation result has type "RESTORE" with restorePreamble: ${simulation.restorePreamble}`,
    );
  }

  if (Api.isSimulationError(simulation)) {
    const msg = `Stellar simulation failed${simulation.error ? ` with error message: ${simulation.error}` : ""}`;

    throw new Error(msg);
  }
}

/**
 * Returns the address credentials carried by a Soroban credential union, for
 * both the legacy V1 `sorobanCredentialsAddress` arm and the CAP-71 V2
 * `sorobanCredentialsAddressV2` arm, which networks accept from Protocol 28
 * onward. Both arms wrap the same `SorobanAddressCredentials` structure and
 * differ only in the preimage the signer commits to. Returns `undefined` for
 * every other arm (source-account, delegated).
 *
 * @param credentials - The credential union from an auth entry
 * @returns The address credentials, or undefined for non-address arms
 */
export function getAddressCredentials(
  credentials: xdr.SorobanCredentials,
): xdr.SorobanAddressCredentials | undefined {
  const credentialsType = credentials.switch();
  if (credentialsType === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    return credentials.address();
  }
  if (credentialsType === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()) {
    return credentials.addressV2();
  }
  return undefined;
}

/**
 * Analysis result of transaction signers
 */
export type ContractSigners = {
  /** Accounts that have already signed auth entries */
  alreadySigned: string[];
  /** Accounts that still need to sign auth entries */
  pendingSignature: string[];
};

/**
 * Input parameters for gathering auth entry signature status
 */
export type GatherAuthEntrySignatureStatusInput = {
  /** The transaction to analyze */
  transaction: Transaction;
  /** Optional simulation response to assemble with transaction before analysis */
  simulationResponse?: Api.SimulateTransactionResponse;
  /** Whether to simulate/assemble the transaction with simulation data (default: true if simulationResponse was not provided) */
  simulate?: boolean;
};

/**
 * Gathers the signature status of auth entries in a Stellar transaction.
 *
 * This function inspects the auth entries in the transaction's InvokeHostFunction
 * operation and categorizes them based on their signature status.
 *
 * @param input - Input containing transaction and optional simulation data
 * @param input.transaction - The transaction to analyze
 * @param input.simulationResponse - Optional simulation response to assemble with transaction before analysis
 * @param input.simulate - Whether to simulate/assemble the transaction with simulation data (default: true if simulationResponse was not provided)
 * @returns ContractSigners with arrays of signed and pending signer addresses
 * @throws Error if transaction doesn't have exactly one InvokeHostFunction operation
 *
 * @example
 * ```ts
 * const status = gatherAuthEntrySignatureStatus({
 *   transaction: tx,
 *   simulationResponse: simResult
 * });
 * console.log('Already signed:', status.alreadySigned);
 * console.log('Pending:', status.pendingSignature);
 * ```
 */
export function gatherAuthEntrySignatureStatus({
  transaction,
  simulationResponse,
  simulate,
}: GatherAuthEntrySignatureStatusInput): ContractSigners {
  // Determine if we should assemble with simulation
  const shouldAssemble = simulate ?? simulationResponse !== undefined;
  let assembledTx = transaction;

  // Assemble transaction with simulation if requested
  if (shouldAssemble && simulationResponse) {
    const assembledTxBuilder = assembleTransaction(transaction, simulationResponse);
    assembledTx = assembledTxBuilder.build();
  }

  // Validate transaction structure
  if (assembledTx.operations.length !== 1) {
    throw new Error(
      `Expected transaction with exactly one operation, got ${assembledTx.operations.length}`,
    );
  }

  const operation = assembledTx.operations[0];
  if (operation.type !== "invokeHostFunction") {
    throw new Error(`Expected InvokeHostFunction operation, got ${operation.type}`);
  }

  const invokeOp = operation as Operation.InvokeHostFunction;

  const alreadySigned: string[] = [];
  const pendingSignature: string[] = [];

  for (const entry of invokeOp.auth ?? []) {
    // Handle address-based credentials, both legacy V1 and CAP-71 V2 (accepted
    // by the network from Protocol 28 onward). Source-account credentials are
    // skipped - these use the transaction source.
    const addressCredentials = getAddressCredentials(entry.credentials());
    if (addressCredentials) {
      const address = Address.fromScAddress(addressCredentials.address()).toString();
      const signature = addressCredentials.signature();

      // Check if already signed (signature is not scvVoid)
      const isSigned = signature.switch().name !== "scvVoid";

      if (isSigned) {
        alreadySigned.push(address);
      } else {
        pendingSignature.push(address);
      }
    }
  }

  return {
    alreadySigned: [...new Set(alreadySigned)], // Remove duplicates
    pendingSignature: [...new Set(pendingSignature)],
  };
}
