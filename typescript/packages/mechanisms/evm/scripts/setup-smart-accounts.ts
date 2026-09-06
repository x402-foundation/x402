/**
 * One-time setup: generate owner keys, deploy Coinbase Smart Wallet + Biconomy Nexus
 * on Base Sepolia, verify isValidSignature wrapping, and write integration .env files.
 *
 * Lives in @x402/evm (not exported in package exports) so viem + test helpers resolve.
 *
 * Usage (from this package):
 *   FACILITATOR_PRIVATE_KEY=0x... pnpm setup:smart-accounts
 *
 * Or from repo root:
 *   FACILITATOR_PRIVATE_KEY=0x... pnpm --filter @x402/evm setup:smart-accounts
 *
 * After running, fund the printed account addresses with Base Sepolia USDC.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, hashTypedData, http } from "viem";
import { baseSepolia } from "viem/chains";
import {
  COINBASE_SMART_WALLET_FACTORY,
  NEXUS_ACCOUNT_FACTORY,
  NEXUS_K1_VALIDATOR,
  deployCoinbaseSmartWallet,
  deployNexusAccount,
  predictCoinbaseSmartWalletAddress,
  predictNexusAccountAddress,
  signCoinbaseSmartWalletTypedData,
  signNexusTypedData,
  verifyIsValidSignature,
} from "../test/integrations/helpers/smartAccounts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PACKAGE_ROOT, "../../../..");
const RPC_URL = process.env.EVM_RPC_URL ?? "https://sepolia.base.org";

const FACILITATOR_KEY = process.env.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined;
if (!FACILITATOR_KEY) {
  console.error("FACILITATOR_PRIVATE_KEY is required (pays deploy gas)");
  process.exit(1);
}

/**
 * Polls `eth_getCode` until bytecode appears at `address` or 30 attempts are exhausted.
 *
 * @param pc - Viem public client used for the `eth_getCode` calls.
 * @param address - Contract address to poll.
 * @param label - Human-readable label included in the timeout error message.
 */
async function waitForContractCode(
  pc: ReturnType<typeof createPublicClient>,
  address: `0x${string}`,
  label: string,
) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = await pc.getCode({ address });
    if (code && code !== "0x") return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${label} not indexed at ${address} after deploy`);
}

/**
 * Writes or updates `KEY=value` entries in an env file, creating it if absent.
 *
 * @param path - Absolute path to the `.env` file to create or update.
 * @param entries - Map of env var names to their values.
 */
function upsertEnv(path: string, entries: Record<string, string>) {
  mkdirSync(dirname(path), { recursive: true });
  let content = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const [key, value] of Object.entries(entries)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content += (content.endsWith("\n") || content.length === 0 ? "" : "\n") + line + "\n";
    }
  }
  writeFileSync(path, content);
  console.log(`Updated ${path}`);
}

/**
 * Deploys Coinbase Smart Wallet and Biconomy Nexus accounts on Base Sepolia,
 * verifies their `isValidSignature` implementations, and writes the resulting
 * addresses and owner keys into the integration `.env` files.
 */
async function main() {
  const owner4337Key = (process.env.CLIENT_4337_OWNER_PRIVATE_KEY ??
    generatePrivateKey()) as `0x${string}`;
  const owner7579Key = (process.env.CLIENT_7579_OWNER_PRIVATE_KEY ??
    generatePrivateKey()) as `0x${string}`;

  const owner4337 = privateKeyToAccount(owner4337Key);
  const owner7579 = privateKeyToAccount(owner7579Key);

  console.log("Predicting addresses...");
  const addr4337 = await predictCoinbaseSmartWalletAddress(owner4337.address, 0n, RPC_URL);
  const addr7579 = await predictNexusAccountAddress(owner7579.address, 0n, RPC_URL);
  console.log(`Coinbase Smart Wallet (4337): ${addr4337}`);
  console.log(`Biconomy Nexus (7579):        ${addr7579}`);

  const pc = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
  const code4337 = await pc.getCode({ address: addr4337 });
  const code7579 = await pc.getCode({ address: addr7579 });

  if (!code4337 || code4337 === "0x") {
    console.log("Deploying Coinbase Smart Wallet...");
    await deployCoinbaseSmartWallet(FACILITATOR_KEY, owner4337.address, 0n, RPC_URL);
  } else {
    console.log("Coinbase Smart Wallet already deployed");
  }

  if (!code7579 || code7579 === "0x") {
    console.log("Deploying Biconomy Nexus...");
    await deployNexusAccount(FACILITATOR_KEY, owner7579.address, 0n, RPC_URL);
  } else {
    console.log("Biconomy Nexus already deployed");
  }

  await waitForContractCode(pc, addr4337, "Coinbase Smart Wallet");
  await waitForContractCode(pc, addr7579, "Biconomy Nexus");

  const sampleTypedData = {
    domain: {
      name: "USDC",
      version: "2",
      chainId: baseSepolia.id,
      verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: addr4337,
      to: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      value: 100n,
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
    },
  };

  const digest4337 = hashTypedData(sampleTypedData);
  const sig4337 = await signCoinbaseSmartWalletTypedData(owner4337, addr4337, sampleTypedData);
  const ok4337 = await verifyIsValidSignature(addr4337, digest4337, sig4337, RPC_URL);
  console.log(`Coinbase isValidSignature: ${ok4337 ? "✅ 0x1626ba7e" : "❌ FAILED"}`);
  if (!ok4337) process.exit(1);

  const sample7579 = {
    ...sampleTypedData,
    message: { ...sampleTypedData.message, from: addr7579 },
  };
  const digest7579 = hashTypedData(sample7579);
  const sig7579 = await signNexusTypedData(
    owner7579,
    addr7579,
    NEXUS_K1_VALIDATOR,
    sample7579,
    RPC_URL,
  );
  const ok7579 = await verifyIsValidSignature(addr7579, digest7579, sig7579, RPC_URL);
  console.log(`Nexus isValidSignature:    ${ok7579 ? "✅ 0x1626ba7e" : "❌ FAILED"}`);
  if (!ok7579) process.exit(1);

  upsertEnv(join(PACKAGE_ROOT, ".env"), {
    CLIENT_4337_ADDRESS: addr4337,
    CLIENT_4337_OWNER_PRIVATE_KEY: owner4337Key,
    CLIENT_7579_ADDRESS: addr7579,
    CLIENT_7579_OWNER_PRIVATE_KEY: owner7579Key,
    CLIENT_7579_VALIDATOR: NEXUS_K1_VALIDATOR,
    SIMPLE_WALLET_FACTORY: COINBASE_SMART_WALLET_FACTORY,
  });

  upsertEnv(join(REPO_ROOT, "go/.env"), {
    EVM_CLIENT_4337_ADDRESS: addr4337,
    EVM_CLIENT_4337_OWNER_PRIVATE_KEY: owner4337Key,
    EVM_CLIENT_7579_ADDRESS: addr7579,
    EVM_CLIENT_7579_OWNER_PRIVATE_KEY: owner7579Key,
    EVM_CLIENT_7579_VALIDATOR: NEXUS_K1_VALIDATOR,
  });

  upsertEnv(join(REPO_ROOT, "python/x402/.env"), {
    EVM_CLIENT_4337_ADDRESS: addr4337,
    EVM_CLIENT_4337_OWNER_PRIVATE_KEY: owner4337Key,
    EVM_CLIENT_7579_ADDRESS: addr7579,
    EVM_CLIENT_7579_OWNER_PRIVATE_KEY: owner7579Key,
    EVM_CLIENT_7579_VALIDATOR: NEXUS_K1_VALIDATOR,
  });

  const logPath = join(PACKAGE_ROOT, "scripts/setup-smart-accounts.log");
  appendFileSync(logPath, `\n[${new Date().toISOString()}] 4337=${addr4337} 7579=${addr7579}\n`);

  console.log("\n✅ Setup complete. Fund these addresses with Base Sepolia USDC:");
  console.log(`   ${addr4337}  (Coinbase Smart Wallet)`);
  console.log(`   ${addr7579}  (Biconomy Nexus)`);
  console.log(`\nFactories: ${COINBASE_SMART_WALLET_FACTORY}, ${NEXUS_ACCOUNT_FACTORY}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
