/**
 * Error thrown when a Stellar transaction simulation fails.
 */
export class SimulationFailedError extends Error {
  readonly cause: string;

  /**
   * Creates a simulation failure error.
   *
   * @param cause - Raw error message returned by Stellar RPC
   */
  constructor(cause: string) {
    super(`Stellar simulation failed${cause ? ` with error message: ${cause}` : ""}`);
    this.name = "SimulationFailedError";
    this.cause = cause;
  }
}

/**
 * Error thrown when a Stellar account lacks a trustline for an asset.
 */
export class TrustlineMissingError extends SimulationFailedError {
  readonly account: string;
  readonly asset: string;

  /**
   * Creates a missing trustline error.
   *
   * @param account - Account missing the trustline
   * @param asset - Asset contract address
   * @param cause - Raw error message returned by Stellar RPC
   */
  constructor(account: string, asset: string, cause: string) {
    super(cause);
    this.name = "TrustlineMissingError";
    this.message = `Stellar trustline is missing for account ${account} and asset ${asset}${cause ? `: ${cause}` : ""}`;
    this.account = account;
    this.asset = asset;
  }
}

/**
 * Error thrown when a Stellar account has insufficient balance for an asset.
 */
export class InsufficientBalanceError extends SimulationFailedError {
  readonly account: string;
  readonly asset: string;

  /**
   * Creates an insufficient balance error.
   *
   * @param account - Account with insufficient balance
   * @param asset - Asset contract address
   * @param cause - Raw error message returned by Stellar RPC
   */
  constructor(account: string, asset: string, cause: string) {
    super(cause);
    this.name = "InsufficientBalanceError";
    this.message = `Stellar account ${account} has insufficient balance for asset ${asset}${cause ? `: ${cause}` : ""}`;
    this.account = account;
    this.asset = asset;
  }
}
