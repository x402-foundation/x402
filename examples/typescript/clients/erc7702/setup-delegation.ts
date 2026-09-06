import { config } from "dotenv";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

config();

const privateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;

/**
 * Helper script to set up an ERC-7702 delegation on Base Sepolia.
 *
 * This submits a type-4 (EIP-7702) transaction that delegates the EOA's
 * execution to a target smart contract implementation. After delegation,
 * the EOA's address will contain the delegation designation (0xef0100 + address)
 * but the owner retains full ECDSA signing authority.
 *
 * Usage:
 *   1. Set EVM_PRIVATE_KEY in .env-local
 *   2. Update DELEGATION_TARGET below to your chosen implementation
 *   3. Run: pnpm setup-delegation
 */

// Biconomy Nexus — an ERC-7579 modular smart account.
// Matches the 7702 → 7579 stack used by Privy-based wallets like Bankr.
// Deterministically deployed at the same address across chains (incl. Base Sepolia).
const DELEGATION_TARGET = "0x000000004F43C49e93C970E84001853a70923B03";

async function main(): Promise<void> {
  const account = privateKeyToAccount(privateKey);
  console.log(`Account: ${account.address}`);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });

  const existingCode = await publicClient.getCode({ address: account.address });
  if (existingCode && existingCode.startsWith("0xef0100")) {
    console.log(`Already delegated to 0x${existingCode.slice(8)}`);
    return;
  }

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  });

  console.log(`Delegating to ${DELEGATION_TARGET}...`);

  const authorization = await walletClient.signAuthorization({
    contractAddress: DELEGATION_TARGET as `0x${string}`,
  });

  const hash = await walletClient.sendTransaction({
    authorizationList: [authorization],
    to: account.address,
    data: "0x",
  });

  console.log(`Transaction: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Status: ${receipt.status}`);

  const code = await publicClient.getCode({ address: account.address });
  if (code && code.startsWith("0xef0100")) {
    console.log(`Delegation active → 0x${code.slice(8)}`);
  } else {
    console.error("Delegation failed — no delegation designation found");
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
