/**
 * Prints an `HEDERA_TE_AUTHORIZATION` for MockTransferExecutor.
 *
 *   pnpm exec tsx --env-file=.env.local test/integrations/mock-executor/authorize.ts [MODE]
 *
 * MODE is a name from `MockMode` (default `OK`). An authorization is single-use, so run this
 * again before each live run. Reads `HEDERA_TE_EXECUTOR_ID`, `HEDERA_TE_PAYER_ACCOUNT_ID`,
 * `HEDERA_RESOURCE_SERVER_ACCOUNT_ID`, `HEDERA_TE_AMOUNT` (default 100000) and optionally
 * `HEDERA_TE_ASSET`, `HEDERA_MIRROR_NODE_URL`. `from` and `to` are resolved the way the
 * facilitator resolves them: the mirror node's `evm_address`, the alias where one exists.
 */
import { buildMockAuthorization, MockMode, readBinding, type MockModeValue } from "./authorization";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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
 * Returns the EVM address the mirror node reports for an account.
 *
 * @param mirrorNodeUrl - Mirror node base URL
 * @param account - Account id
 * @returns Lowercase 0x-hex address
 */
async function resolveEvmAddress(mirrorNodeUrl: string, account: string): Promise<string> {
  const response = await fetch(`${mirrorNodeUrl}/api/v1/accounts/${account}`);
  if (!response.ok) {
    throw new Error(`mirror node: account ${account} -> ${response.status}`);
  }
  const { evm_address } = (await response.json()) as { evm_address: string };
  return evm_address.toLowerCase();
}

/**
 * Returns the long-zero EVM address of an HTS token.
 *
 * @param token - Token id
 * @returns 0x-hex address
 */
function tokenAddress(token: string): string {
  const num = BigInt(token.split(".")[2]);
  return `0x${num.toString(16).padStart(40, "0")}`;
}

/**
 * Prints the authorization.
 */
async function main(): Promise<void> {
  const modeName = (process.argv[2] ?? "OK").toUpperCase();
  if (!(modeName in MockMode)) {
    throw new Error(`unknown mode ${modeName}; one of ${Object.keys(MockMode).join(", ")}`);
  }
  const mode = MockMode[modeName as keyof typeof MockMode] as MockModeValue;
  const mirrorNodeUrl =
    process.env.HEDERA_MIRROR_NODE_URL || "https://testnet.mirrornode.hedera.com";
  const executorId = requireEnv("HEDERA_TE_EXECUTOR_ID");
  const asset = process.env.HEDERA_TE_ASSET || "0.0.0";
  const amount = BigInt(process.env.HEDERA_TE_AMOUNT || "100000");

  const binding = await readBinding({
    mirrorNodeUrl,
    executorId,
    from: await resolveEvmAddress(mirrorNodeUrl, requireEnv("HEDERA_TE_PAYER_ACCOUNT_ID")),
    asset: asset === "0.0.0" ? ZERO_ADDRESS : tokenAddress(asset),
    to: await resolveEvmAddress(mirrorNodeUrl, requireEnv("HEDERA_RESOURCE_SERVER_ACCOUNT_ID")),
    amount,
  });
  console.log(`# mode ${modeName}, amount ${amount}, asset ${asset}`);
  console.log(`HEDERA_TE_AUTHORIZATION=${buildMockAuthorization({ mode, binding })}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
