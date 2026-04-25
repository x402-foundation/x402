export * from "./exact";
export * from "./types";
export * from "./constants";
export * from "./signer";
export * from "./preflight";
export * from "./utils";

// Re-export the Hiero SDK primitives consumers need so that applications
// resolve a single SDK instance through @x402/hedera. Importing
// @hiero-ledger/sdk directly alongside this package in workspaces with
// independent pnpm stores yields duplicate installs whose `instanceof` and
// string-brand checks cross-fail at runtime ("t.startsWith is not a function").
export {
  AccountBalanceQuery,
  AccountId,
  AccountInfoQuery,
  Client,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
  Transaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
