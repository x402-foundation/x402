/**
 * Creates a testnet account for use as `payTo`, controlled by the facilitator's key.
 *
 * The facilitator must not be `payTo`: the fee payer is never `payTo`, so a facilitator
 * with a single account could not settle to itself. Run from `typescript/packages/mechanisms/hedera`:
 *
 *   pnpm exec tsx --env-file=.env.local test/integrations/mock-executor/create-account.ts
 *
 * Reads `HEDERA_FACILITATOR_ACCOUNT_ID` and `HEDERA_FACILITATOR_PRIVATE_KEY`, and optionally
 * `HEDERA_TE_NEW_ACCOUNT_HBAR` (initial balance, default 1).
 */
import { AccountCreateTransaction, AccountId, Client, Hbar, PrivateKey } from "@hiero-ledger/sdk";

/**
 * Creates the account and prints its id.
 */
async function main(): Promise<void> {
  const id = process.env.HEDERA_FACILITATOR_ACCOUNT_ID;
  const key = process.env.HEDERA_FACILITATOR_PRIVATE_KEY;
  if (!id || !key) {
    throw new Error(
      "HEDERA_FACILITATOR_ACCOUNT_ID and HEDERA_FACILITATOR_PRIVATE_KEY are required",
    );
  }
  const operatorKey = PrivateKey.fromStringECDSA(key);
  const client = Client.forTestnet().setOperator(AccountId.fromString(id), operatorKey);
  try {
    const response = await new AccountCreateTransaction()
      .setKeyWithoutAlias(operatorKey.publicKey)
      .setInitialBalance(new Hbar(Number(process.env.HEDERA_TE_NEW_ACCOUNT_HBAR || 1)))
      .execute(client);
    const accountId = (await response.getReceipt(client)).accountId;
    console.log(`Created account ${accountId?.toString()}`);
    console.log(`  HEDERA_RESOURCE_SERVER_ACCOUNT_ID=${accountId?.toString()}`);
  } finally {
    client.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
