/**
 * Deploys a test executor to Hedera testnet. TEST ONLY: neither contract is audited or a
 * reference executor.
 *
 * Run from `typescript/packages/mechanisms/hedera`:
 *
 *   pnpm exec tsx --env-file=.env.local test/integrations/mock-executor/deploy.ts [CONTRACT]
 *
 * CONTRACT is `MockTransferExecutor` (default; also funded with HBAR, since it pays from its own
 * balance) or `SignedOwnerExecutor` (takes no funds: it spends an owner's allowance).
 *
 * Reads, from the environment or `.env.local`:
 * - `HEDERA_FACILITATOR_ACCOUNT_ID` / `HEDERA_FACILITATOR_PRIVATE_KEY`: the account that
 *   deploys and pays (ECDSA key, DER or 0x-hex)
 * - `HEDERA_TE_EXTRA_RECIPIENT_ACCOUNT_ID` (optional, mock only): recipient of the mock's
 *   `EXTRA_CREDIT` mode, defaults to the deployer
 * - `HEDERA_TE_FUND_HBAR` (optional, mock only): HBAR to deposit in the mock, default 20
 *
 * Prints the variable to set in `.env.local`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AccountId,
  Client,
  ContractCreateFlow,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  Hbar,
  PrivateKey,
} from "@hiero-ledger/sdk";

const CONTRACTS = {
  MockTransferExecutor: "HEDERA_TE_MOCK_EXECUTOR_ID",
  SignedOwnerExecutor: "HEDERA_TE_SIGNED_EXECUTOR_ID",
} as const;
type ContractName = keyof typeof CONTRACTS;

/**
 * Reads a required environment variable.
 *
 * @param name - Variable name
 * @returns Its value
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (set it in the shell or .env.local)`);
  }
  return value;
}

/**
 * Returns the EVM address the mirror node reports for an account: its alias where it has one.
 * A native transfer to the long-zero form of an alias-bearing account fails, so the mock must be
 * given the alias.
 *
 * @param account - Account id
 * @returns 0x-hex address
 */
async function resolveEvmAddress(account: string): Promise<string> {
  const mirror = process.env.HEDERA_MIRROR_NODE_URL || "https://testnet.mirrornode.hedera.com";
  const response = await fetch(`${mirror}/api/v1/accounts/${account}`);
  if (!response.ok) {
    throw new Error(`mirror node: account ${account} -> ${response.status}`);
  }
  return ((await response.json()) as { evm_address: string }).evm_address;
}

/**
 * Deploys the chosen contract and prints its ids.
 */
async function main(): Promise<void> {
  const name = (process.argv[2] ?? "MockTransferExecutor") as ContractName;
  if (!(name in CONTRACTS)) {
    throw new Error(`unknown contract ${name}; one of ${Object.keys(CONTRACTS).join(", ")}`);
  }
  const artifact = JSON.parse(
    readFileSync(
      join(process.cwd(), "test/integrations/mock-executor/artifacts", `${name}.json`),
      "utf8",
    ),
  ) as { bytecode: string };
  const isMock = name === "MockTransferExecutor";
  const operatorId = AccountId.fromString(requireEnv("HEDERA_FACILITATOR_ACCOUNT_ID"));
  const operatorKey = PrivateKey.fromStringECDSA(requireEnv("HEDERA_FACILITATOR_PRIVATE_KEY"));
  const extraRecipient = AccountId.fromString(
    process.env.HEDERA_TE_EXTRA_RECIPIENT_ACCOUNT_ID || operatorId.toString(),
  );
  const fundHbar = Number(process.env.HEDERA_TE_FUND_HBAR || 20);

  // The SDK's default fee cap is too low for a contract create.
  const client = Client.forTestnet()
    .setOperator(operatorId, operatorKey)
    .setDefaultMaxTransactionFee(new Hbar(20));
  try {
    const flow = new ContractCreateFlow().setBytecode(artifact.bytecode).setGas(1_500_000);
    if (isMock) {
      flow.setConstructorParameters(
        new ContractFunctionParameters().addAddress(
          await resolveEvmAddress(extraRecipient.toString()),
        ),
      );
    }
    const created = await flow.execute(client);
    const receipt = await created.getReceipt(client);
    const contractId = receipt.contractId;
    if (!contractId) {
      throw new Error("deployment returned no contract id");
    }

    if (isMock) {
      // An empty call carrying HBAR lands in the contract's `receive()`.
      await (
        await new ContractExecuteTransaction()
          .setContractId(contractId)
          .setGas(100_000)
          .setPayableAmount(new Hbar(fundHbar))
          .execute(client)
      ).getReceipt(client);
    }

    console.log(`${name} deployed: ${contractId.toString()}`);
    console.log(`  evm address:   0x${contractId.toEvmAddress()}`);
    console.log(`  hashscan:      https://hashscan.io/testnet/contract/${contractId.toString()}`);
    if (isMock) {
      console.log(`  funded:        ${fundHbar} HBAR`);
      console.log(`  extra recipient (EXTRA_CREDIT mode): ${extraRecipient.toString()}`);
    }
    console.log("");
    console.log("Set in .env.local:");
    console.log(`  ${CONTRACTS[name]}=${contractId.toString()}`);
  } finally {
    client.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
