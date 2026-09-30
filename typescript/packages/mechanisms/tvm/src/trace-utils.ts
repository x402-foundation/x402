export type TvmTraceTransaction = Record<string, unknown>;
export type TvmTraceData = Record<string, unknown>;

export function parseTraceTransactions(traceData: TvmTraceData): TvmTraceTransaction[] {
  const transactions = traceData.transactions;
  if (!transactions || typeof transactions !== "object" || Array.isArray(transactions)) {
    throw new Error("Toncenter trace did not return transactions dict");
  }
  return Object.values(transactions as Record<string, TvmTraceTransaction>);
}

export function transactionSucceeded(transaction: TvmTraceTransaction): boolean {
  const description = transactionPhases(transaction);
  if (description.aborted === true) {
    return false;
  }
  const computePhase = asRecord(description.compute_ph);
  if (computePhase.skipped === true || computePhase.success !== true) {
    return false;
  }
  const actionPhase = asRecordOrNull(description.action);
  if (actionPhase !== null && actionPhase.success !== true) {
    return false;
  }
  return true;
}

export function bodyHashToBase64(rawHash: Buffer): string {
  return rawHash.toString("base64");
}

export function traceTransactionHashToHex(encodedHash: string): string {
  const normalized = encodedHash.trim();
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) {
    return normalized.toLowerCase();
  }
  return Buffer.from(normalized, "base64").toString("hex");
}

export function messageBodyHashMatches(message: unknown, expectedHash: Buffer): boolean {
  const messageContent = asRecord(asRecord(message).message_content);
  return messageContent.hash === bodyHashToBase64(expectedHash);
}

export function traceTransactionFwdFees(
  transaction: TvmTraceTransaction,
  options: { expectedCount?: number } = {},
): bigint {
  const outMsgs = Array.isArray(transaction.out_msgs) ? transaction.out_msgs : [];
  const exactFees = outMsgs
    .map(message => parseInteger(asRecord(message).fwd_fee))
    .filter((fee): fee is bigint => fee !== null);
  if (exactFees.length) {
    return exactFees.reduce((sum, fee) => sum + fee, 0n);
  }

  const actionPhase = asRecordOrNull(transactionPhases(transaction).action);
  if (actionPhase) {
    const totalFwdFees = parseInteger(actionPhase.total_fwd_fees);
    if (totalFwdFees !== null) {
      return totalFwdFees;
    }
    const fwdFee = parseInteger(actionPhase.fwd_fee);
    if (fwdFee !== null) {
      return fwdFee * BigInt(options.expectedCount ?? 1);
    }
  }
  return 0n;
}

export function traceTransactionComputeFees(transaction: TvmTraceTransaction): bigint {
  return parseInteger(asRecord(transactionPhases(transaction).compute_ph).gas_fees) ?? 0n;
}

export function traceTransactionStorageFees(transaction: TvmTraceTransaction): bigint {
  const storagePhase = asRecord(transactionPhases(transaction).storage_ph);
  return (
    (parseInteger(storagePhase.storage_fees_collected) ?? 0n) +
    (parseInteger(storagePhase.storage_fees_due) ?? 0n)
  );
}

export function traceTransactionBalanceBefore(transaction: TvmTraceTransaction): bigint {
  const beforeState = asRecordOrNull(transaction.account_state_before);
  if (beforeState) {
    const balance = parseInteger(beforeState.balance);
    if (balance !== null) return balance;
  }
  const accountState = asRecordOrNull(transaction.account_state);
  if (accountState) {
    const balance = parseInteger(accountState.balance);
    if (balance !== null) return balance;
  }
  const balance = parseInteger(transaction.balance);
  if (balance !== null) return balance;
  throw new Error("Trace transaction is missing account_state_before balance");
}

function transactionPhases(transaction: TvmTraceTransaction): Record<string, unknown> {
  return asRecord(transaction.description ?? transaction);
}

function parseInteger(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "string" && value.length) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return Object.keys(record).length ? record : null;
}
