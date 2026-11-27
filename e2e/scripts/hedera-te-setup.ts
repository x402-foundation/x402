/**
 * Lets the e2e client pay the Hedera `transferExecutor` routes through a `SignedOwnerExecutor`.
 *
 * The executor holds no funds: it moves HBAR from the payer under a HIP-336 allowance. This
 * script has the client account (CLIENT_HEDERA_ACCOUNT_ID) grant HEDERA_TE_EXECUTOR_ID an HBAR
 * allowance of HEDERA_TE_ALLOWANCE_HBAR (default 1), signed and paid by the client account, and
 * waits until the Mirror Node reports it: the facilitator simulates against the Mirror Node, so a
 * payment made before then reverts. Granting again replaces the allowance; 0 revokes it.
 *
 *   pnpm hedera:te:setup
 *
 * Each payment spends its amount from the allowance (100000 tinybars by default, so 1 HBAR covers
 * about 1000 payments). Run it again when the allowance runs low.
 */
import { config } from "dotenv";
import {
  AccountAllowanceApproveTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
} from "@hiero-ledger/sdk";

config();

const MIRROR_NODE_URLS: Record<string, string> = {
  "hedera:testnet": "https://testnet.mirrornode.hedera.com",
  "hedera:mainnet": "https://mainnet-public.mirrornode.hedera.com",
};

const required = [
  "CLIENT_HEDERA_ACCOUNT_ID",
  "CLIENT_HEDERA_PRIVATE_KEY",
  "HEDERA_TE_EXECUTOR_ID",
] as const;
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")} (see e2e/.env-local)`);
  process.exit(1);
}
const env = process.env as Record<(typeof required)[number], string>;

/**
 * Reads the allowance to grant.
 *
 * @returns Allowance in HBAR
 */
function allowanceHbar(): number {
  const raw = process.env.HEDERA_TE_ALLOWANCE_HBAR?.trim() || "1";
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`HEDERA_TE_ALLOWANCE_HBAR must be a non-negative number, got "${raw}"`);
  }
  return value;
}

/**
 * Reads the allowance the Mirror Node reports for the executor.
 *
 * @param mirrorNodeUrl - Mirror Node base URL
 * @param owner - Owner account id
 * @param spender - Executor contract id
 * @returns Remaining allowance in tinybars, or undefined when there is none
 */
async function mirrorAllowance(
  mirrorNodeUrl: string,
  owner: string,
  spender: string,
): Promise<bigint | undefined> {
  const response = await fetch(
    `${mirrorNodeUrl}/api/v1/accounts/${owner}/allowances/crypto?spender.id=${spender}`,
  );
  if (!response.ok) {
    return undefined;
  }
  const body = (await response.json()) as { allowances?: { amount?: number }[] };
  const amount = body.allowances?.[0]?.amount;
  return amount === undefined ? undefined : BigInt(amount);
}

async function main(): Promise<void> {
  const network = process.env.HEDERA_NETWORK?.trim() || "hedera:testnet";
  const mirrorNodeUrl = (
    process.env.HEDERA_MIRROR_NODE_URL?.trim() || MIRROR_NODE_URLS[network] || ""
  ).replace(/\/+$/, "");
  if (!mirrorNodeUrl) {
    throw new Error(`Unsupported HEDERA_NETWORK ${network}; set HEDERA_MIRROR_NODE_URL`);
  }
  const owner = AccountId.fromString(env.CLIENT_HEDERA_ACCOUNT_ID.trim());
  const ownerKey = PrivateKey.fromStringECDSA(env.CLIENT_HEDERA_PRIVATE_KEY.trim());
  const executor = AccountId.fromString(env.HEDERA_TE_EXECUTOR_ID.trim());
  const allowance = new Hbar(allowanceHbar());
  const expected = BigInt(allowance.toTinybars().toString());

  const client = (network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet())
    .setOperator(owner, ownerKey);
  try {
    const response = await new AccountAllowanceApproveTransaction()
      .approveHbarAllowance(owner, executor, allowance)
      .execute(client);
    const receipt = await response.getReceipt(client);
    console.log(
      `${owner} granted ${executor} an allowance of ${allowance.toString()}: ${receipt.status} ` +
        `(${response.transactionId.toString()})`,
    );
  } finally {
    client.close();
  }

  // The Mirror Node lags consensus by a few seconds.
  for (let attempt = 0; attempt < 30; attempt++) {
    const reported = await mirrorAllowance(mirrorNodeUrl, owner.toString(), executor.toString());
    if ((reported ?? 0n) === expected) {
      console.log(`Mirror Node reports the allowance: ${expected} tinybars`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error("Mirror Node did not report the new allowance within 60 s; retry in a minute");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
