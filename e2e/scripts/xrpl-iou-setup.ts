/**
 * Creates a reusable XRPL Testnet issued-currency fixture for e2e tests.
 *
 * The script funds dedicated issuer, payer, and payee accounts with Testnet XRP,
 * enables DefaultRipple on the issuer, creates payer/payee trust lines, issues
 * test currency to the payer, and persists the fixture to e2e/.env.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import {
  AccountSetAsfFlags,
  Client,
  parseAccountRootFlags,
  RippledError,
  Wallet,
  type AccountSet,
  type Payment,
  type SubmittableTransaction,
  type TrustSet,
} from "xrpl";

config();

const XRPL_TESTNET_NETWORK_ID = 1;
const DEFAULT_TESTNET_WS_URL = "wss://s.altnet.rippletest.net:51233";
const DEFAULT_CURRENCY = "USD";
const DEFAULT_PAYMENT_AMOUNT = 1n;
const DEFAULT_PAYER_BALANCE = 1_000n;
const DEFAULT_TRUST_LIMIT = 1_000_000n;
const E2E_PAYMENT_BUFFER = 20n;

type FixtureWallets = {
  issuer: Wallet;
  payer: Wallet;
  payee: Wallet;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAccountNotFound(error: unknown): boolean {
  if (!(error instanceof RippledError) || !isRecord(error.data)) {
    return false;
  }
  return error.data.error === "actNotFound";
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: bigint,
  name: string,
): bigint {
  const resolved = value?.trim() || fallback.toString();
  if (!/^\d+$/u.test(resolved) || BigInt(resolved) <= 0n) {
    throw new Error(`${name} must be a positive integer`);
  }
  return BigInt(resolved);
}

function parseSignedInteger(value: string, name: string): bigint {
  if (!/^-?\d+$/u.test(value)) {
    throw new Error(`${name} must be an integer, received ${value}`);
  }
  return BigInt(value);
}

function walletFromEnv(seed: string | undefined): Wallet {
  return seed ? Wallet.fromSeed(seed) : Wallet.generate();
}

function requireSeed(wallet: Wallet, label: string): string {
  if (!wallet.seed) {
    throw new Error(`${label} wallet seed is unavailable`);
  }
  return wallet.seed;
}

function resolveWallets(): FixtureWallets {
  const issuer = walletFromEnv(process.env.XRPL_IOU_ISSUER_SEED);
  const payer = walletFromEnv(process.env.CLIENT_XRPL_SEED);
  const payee = walletFromEnv(process.env.SERVER_XRPL_SEED);

  if (
    process.env.SERVER_XRPL_SEED &&
    process.env.SERVER_XRPL_ADDRESS &&
    process.env.SERVER_XRPL_ADDRESS !== payee.classicAddress
  ) {
    throw new Error("SERVER_XRPL_ADDRESS does not match SERVER_XRPL_SEED");
  }

  const addresses = new Set([
    issuer.classicAddress,
    payer.classicAddress,
    payee.classicAddress,
  ]);
  if (addresses.size !== 3) {
    throw new Error(
      "XRPL IOU fixture requires distinct issuer, payer, and payee accounts",
    );
  }

  return { issuer, payer, payee };
}

function upsertEnvFile(envPath: string, updates: Record<string, string>): void {
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(content)) {
      content = content.replace(pattern, line);
    } else {
      if (content.length > 0 && !content.endsWith("\n")) {
        content += "\n";
      }
      content += `${line}\n`;
    }
  }

  writeFileSync(envPath, content, { mode: 0o600 });
  chmodSync(envPath, 0o600);
}

async function ensureFunded(
  client: Client,
  wallet: Wallet,
  label: string,
): Promise<void> {
  try {
    await client.request({
      command: "account_info",
      account: wallet.classicAddress,
      ledger_index: "validated",
    });
    console.log(`✅ ${label} account exists: ${wallet.classicAddress}`);
  } catch (error) {
    if (!isAccountNotFound(error)) {
      throw error;
    }
    console.log(`🔄 Funding ${label} account from the XRPL Testnet faucet...`);
    await client.fundWallet(wallet, {
      usageContext: "x402 XRPL IOU e2e fixture",
    });
    console.log(`   ✅ Funded ${wallet.classicAddress}`);
  }
}

async function submitTransaction(
  client: Client,
  wallet: Wallet,
  transaction: SubmittableTransaction,
  label: string,
): Promise<void> {
  const prepared = await client.autofill(transaction);
  const signed = wallet.sign(prepared);
  const response = await client.submitAndWait(signed.tx_blob, {
    autofill: false,
    failHard: true,
  });
  const meta = response.result.meta;
  if (typeof meta !== "object" || meta === null) {
    throw new Error(`${label} returned no transaction metadata`);
  }
  if (meta.TransactionResult !== "tesSUCCESS") {
    throw new Error(`${label} failed: ${meta.TransactionResult}`);
  }
  if (response.result.validated !== true) {
    throw new Error(`${label} was not validated`);
  }
  console.log(`   ✅ ${label}: ${response.result.hash ?? signed.hash}`);
}

async function ensureDefaultRipple(
  client: Client,
  issuer: Wallet,
): Promise<void> {
  const response = await client.request({
    command: "account_info",
    account: issuer.classicAddress,
    ledger_index: "validated",
  });
  if (
    parseAccountRootFlags(response.result.account_data.Flags).lsfDefaultRipple
  ) {
    console.log("✅ Issuer DefaultRipple is enabled");
    return;
  }

  console.log("🔄 Enabling DefaultRipple on the issuer...");
  const transaction: AccountSet = {
    TransactionType: "AccountSet",
    Account: issuer.classicAddress,
    SetFlag: AccountSetAsfFlags.asfDefaultRipple,
  };
  await submitTransaction(client, issuer, transaction, "AccountSet");
}

async function getTrustLine(
  client: Client,
  account: string,
  issuer: string,
  currency: string,
) {
  const response = await client.request({
    command: "account_lines",
    account,
    peer: issuer,
    ledger_index: "validated",
  });
  return response.result.lines.find((line) => line.currency === currency);
}

async function ensureTrustLine(
  client: Client,
  holder: Wallet,
  issuer: Wallet,
  currency: string,
  limit: bigint,
  label: string,
): Promise<void> {
  const existing = await getTrustLine(
    client,
    holder.classicAddress,
    issuer.classicAddress,
    currency,
  );
  if (existing?.limit === limit.toString()) {
    console.log(`✅ ${label} trust line is configured`);
    return;
  }

  console.log(`🔄 Configuring ${label} trust line...`);
  const transaction: TrustSet = {
    TransactionType: "TrustSet",
    Account: holder.classicAddress,
    LimitAmount: {
      currency,
      issuer: issuer.classicAddress,
      value: limit.toString(),
    },
  };
  await submitTransaction(client, holder, transaction, `${label} TrustSet`);
}

async function ensurePayerBalance(
  client: Client,
  wallets: FixtureWallets,
  currency: string,
  targetBalance: bigint,
): Promise<void> {
  const line = await getTrustLine(
    client,
    wallets.payer.classicAddress,
    wallets.issuer.classicAddress,
    currency,
  );
  const currentBalance = parseSignedInteger(
    line?.balance ?? "0",
    "payer IOU balance",
  );
  if (currentBalance >= targetBalance) {
    console.log(`✅ Payer holds ${currentBalance} ${currency}`);
    return;
  }

  const issueAmount = targetBalance - currentBalance;
  console.log(`🔄 Issuing ${issueAmount} ${currency} to the payer...`);
  const transaction: Payment = {
    TransactionType: "Payment",
    Account: wallets.issuer.classicAddress,
    Destination: wallets.payer.classicAddress,
    Amount: {
      currency,
      issuer: wallets.issuer.classicAddress,
      value: issueAmount.toString(),
    },
  };
  await submitTransaction(
    client,
    wallets.issuer,
    transaction,
    "IOU issuance Payment",
  );
}

async function requireTestnet(client: Client): Promise<void> {
  const response = await client.request({ command: "server_info" });
  if (response.result.info.network_id !== XRPL_TESTNET_NETWORK_ID) {
    throw new Error(
      `XRPL IOU setup only supports Testnet network ID ${XRPL_TESTNET_NETWORK_ID}; ` +
        `connected to ${response.result.info.network_id ?? "unknown"}`,
    );
  }
}

async function main(): Promise<void> {
  const wsUrl = process.env.XRPL_TESTNET_WS_URL ?? DEFAULT_TESTNET_WS_URL;
  const currency = process.env.SERVER_XRPL_ASSET?.trim() || DEFAULT_CURRENCY;
  if (currency === "XRP") {
    throw new Error("SERVER_XRPL_ASSET must be an issued currency, not XRP");
  }

  const paymentAmount = parsePositiveInteger(
    process.env.SERVER_XRPL_AMOUNT,
    DEFAULT_PAYMENT_AMOUNT,
    "SERVER_XRPL_AMOUNT",
  );
  const configuredTarget = parsePositiveInteger(
    process.env.XRPL_IOU_PAYER_BALANCE,
    DEFAULT_PAYER_BALANCE,
    "XRPL_IOU_PAYER_BALANCE",
  );
  const minimumTarget = paymentAmount * E2E_PAYMENT_BUFFER;
  const targetBalance =
    configuredTarget > minimumTarget ? configuredTarget : minimumTarget;
  const trustLimit = parsePositiveInteger(
    process.env.XRPL_IOU_TRUST_LIMIT,
    DEFAULT_TRUST_LIMIT,
    "XRPL_IOU_TRUST_LIMIT",
  );
  if (trustLimit < targetBalance) {
    throw new Error("XRPL_IOU_TRUST_LIMIT must cover XRPL_IOU_PAYER_BALANCE");
  }

  const wallets = resolveWallets();
  const client = new Client(wsUrl);
  await client.connect();
  try {
    await requireTestnet(client);
    await ensureFunded(client, wallets.issuer, "issuer");
    await ensureFunded(client, wallets.payer, "payer");
    await ensureFunded(client, wallets.payee, "payee");
    await ensureDefaultRipple(client, wallets.issuer);
    await ensureTrustLine(
      client,
      wallets.payer,
      wallets.issuer,
      currency,
      trustLimit,
      "payer",
    );
    await ensureTrustLine(
      client,
      wallets.payee,
      wallets.issuer,
      currency,
      trustLimit,
      "payee",
    );
    await ensurePayerBalance(client, wallets, currency, targetBalance);
  } finally {
    await client.disconnect();
  }

  const envPath = join(process.cwd(), ".env");
  upsertEnvFile(envPath, {
    CLIENT_XRPL_SEED: requireSeed(wallets.payer, "payer"),
    SERVER_XRPL_ADDRESS: wallets.payee.classicAddress,
    SERVER_XRPL_SEED: requireSeed(wallets.payee, "payee"),
    SERVER_XRPL_ASSET: currency,
    SERVER_XRPL_AMOUNT: paymentAmount.toString(),
    SERVER_XRPL_ISSUER: wallets.issuer.classicAddress,
    XRPL_IOU_ISSUER_SEED: requireSeed(wallets.issuer, "issuer"),
    XRPL_IOU_PAYER_BALANCE: targetBalance.toString(),
    XRPL_IOU_TRUST_LIMIT: trustLimit.toString(),
    XRPL_TESTNET_WS_URL: wsUrl,
  });

  console.log(`💾 Saved XRPL IOU fixture settings to ${envPath}`);
  console.log(
    JSON.stringify({
      ok: true,
      network: "xrpl:1",
      issuer: wallets.issuer.classicAddress,
      payer: wallets.payer.classicAddress,
      payee: wallets.payee.classicAddress,
      currency,
      amount: paymentAmount.toString(),
    }),
  );
}

main().catch((error) => {
  console.error(
    "Error:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
