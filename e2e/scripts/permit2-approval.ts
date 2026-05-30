/**
 * Permit2 Approval Script
 *
 * This script manages Permit2 allowance for the client wallet.
 * It can grant unlimited approval or revoke existing approval.
 *
 * Usage:
 *   pnpm tsx scripts/permit2-approval.ts approve [tokenAddress]
 *   pnpm tsx scripts/permit2-approval.ts revoke  [tokenAddress]
 *
 * If tokenAddress is not provided, processes all known tokens.
 *
 * Environment variables required:
 *   CLIENT_EVM_PRIVATE_KEY - Private key of the client wallet
 */

import { config } from 'dotenv';
import {
  createWalletClient,
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  formatUnits,
  getAddress,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as allViemChains from 'viem/chains';
import { DEFAULT_STABLECOINS } from '@x402/evm';

config();

// Permit2 canonical address (same on all EVM chains)
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const evmNetwork = process.env.EVM_NETWORK || 'eip155:84532';
const evmRpcUrl = process.env.EVM_RPC_URL;

// Resolve any CAIP-2 EVM chain — viem's chain database first, with a
// minimal defineChain fallback for any SDK chain that viem hasn't packaged yet.
function resolveEvmChain(network: string): Chain {
  const [namespace, ref] = network.split(':');
  if (namespace !== 'eip155') {
    throw new Error(`resolveEvmChain: not an EVM network: ${network}`);
  }
  const chainId = Number(ref);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`resolveEvmChain: invalid EVM chain id in ${network}`);
  }
  const known = (Object.values(allViemChains) as Chain[]).find(
    (c) => c && typeof c === 'object' && c.id === chainId,
  );
  if (known) return known;
  return defineChain({
    id: chainId,
    name: `EVM ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
}
const evmChain = resolveEvmChain(evmNetwork);

// Token list is driven by EVM_PERMIT2_ASSET (canonical Permit2 target for the
// configured chain). Pass an explicit `[tokenAddress]` CLI arg to operate on a
// non-default token (e.g. MockERC20 on Base Sepolia).
//
// Decimals + display name flow from `DEFAULT_STABLECOINS[evmNetwork]` when the
// chain is in the SDK's catalog (the canonical case). Custom tokens supplied
// via the CLI override read decimals from the contract's `decimals()` view.
const permit2AssetEnv = process.env.EVM_PERMIT2_ASSET;
const sdkAsset = DEFAULT_STABLECOINS[evmNetwork];
const TOKENS: Record<string, { address: `0x${string}`; decimals: number; name: string }> = {};
if (permit2AssetEnv) {
  TOKENS.PRIMARY = {
    address: getAddress(permit2AssetEnv) as `0x${string}`,
    decimals: sdkAsset?.decimals ?? 6,
    name: sdkAsset?.name ?? 'TOKEN',
  };
}

// Maximum uint256 for unlimited approval
const MAX_UINT256 = 2n ** 256n - 1n;

// ERC20 ABI for approve, allowance, balanceOf, and decimals
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

async function main() {
  const action = process.argv[2];
  const tokenAddressArg = process.argv[3];
  const filterAddress = tokenAddressArg ? (getAddress(tokenAddressArg) as `0x${string}`) : undefined;

  if (!action || (action !== 'approve' && action !== 'revoke')) {
    console.log(`
Permit2 Approval Script

Usage:
  pnpm tsx scripts/permit2-approval.ts approve [tokenAddress]
  pnpm tsx scripts/permit2-approval.ts revoke  [tokenAddress]

If tokenAddress is not provided, processes the chain's primary Permit2 asset
(EVM_PERMIT2_ASSET). Pass an explicit address to operate on a different token.

Environment variables required:
  CLIENT_EVM_PRIVATE_KEY - Private key of the client wallet
  EVM_NETWORK            - CAIP-2 EVM chain id (e.g. eip155:84532)
  EVM_PERMIT2_ASSET      - Permit2 target token address for EVM_NETWORK
                           (optional when [tokenAddress] is provided)
  EVM_RPC_URL            - Optional RPC override; falls back to viem chain default
`);
    process.exit(1);
  }

  const privateKey = process.env.CLIENT_EVM_PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ CLIENT_EVM_PRIVATE_KEY environment variable is required');
    process.exit(1);
  }

  if (!filterAddress && Object.keys(TOKENS).length === 0) {
    console.error(
      '❌ EVM_PERMIT2_ASSET environment variable is required when no tokenAddress is provided',
    );
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const publicClient = createPublicClient({
    chain: evmChain,
    transport: http(evmRpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: evmChain,
    transport: http(evmRpcUrl),
  });

  // For a CLI-override token not already in TOKENS, read its decimals on-chain.
  if (
    filterAddress &&
    !Object.values(TOKENS).some((t) => getAddress(t.address) === filterAddress)
  ) {
    const decimals = await publicClient.readContract({
      address: filterAddress,
      abi: erc20Abi,
      functionName: 'decimals',
    });
    TOKENS[filterAddress] = {
      address: filterAddress,
      decimals: Number(decimals),
      name: filterAddress,
    };
  }

  console.log(`\n🔑 Wallet: ${account.address}`);
  console.log(`📍 Network: ${evmChain.name} (${evmNetwork})`);
  console.log(`🔐 Permit2: ${PERMIT2_ADDRESS}\n`);

  // Display balance and allowance for all known tokens
  const tokenStates: { name: string; address: `0x${string}`; decimals: number; balance: bigint; allowance: bigint }[] = [];

  for (const token of Object.values(TOKENS)) {
    const balance = await publicClient.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    });

    const allowance = await publicClient.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, PERMIT2_ADDRESS],
    });

    tokenStates.push({ ...token, balance, allowance });

    const formattedBalance = `${formatUnits(balance, token.decimals)} ${token.name}`;
    const formattedAllowance =
      allowance === MAX_UINT256
        ? 'unlimited'
        : `${formatUnits(allowance, token.decimals)} ${token.name}`;

    console.log(`💰 ${token.name} (${token.address})`);
    console.log(`   💵 Balance: ${formattedBalance}`);
    console.log(`   📋 Permit2 Allowance: ${formattedAllowance}`);
  }
  console.log();

  const tokensToProcess = filterAddress
    ? tokenStates.filter((t) => getAddress(t.address) === filterAddress)
    : tokenStates;

  if (tokensToProcess.length === 0) {
    const addr = filterAddress ?? 'none';
    console.error(`❌ No matching token found for address ${addr}`);
    process.exit(1);
  }

  let nonce = await publicClient.getTransactionCount({ address: account.address });

  if (action === 'revoke') {
    for (const token of tokensToProcess) {
      if (token.allowance === 0n) {
        console.log(`✅ ${token.name}: Permit2 approval already revoked (allowance is 0)`);
        continue;
      }

      console.log(`🔄 ${token.name}: Revoking Permit2 approval...`);

      const hash = await walletClient.writeContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'approve',
        args: [PERMIT2_ADDRESS, 0n],
        nonce: nonce++,
      });

      console.log(`   ✅ Revoke submitted (tx: ${hash})`);
    }
    return;
  }

  // action === 'approve'
  for (const token of tokensToProcess) {
    if (token.allowance === MAX_UINT256) {
      console.log(`✅ ${token.name}: Permit2 already has unlimited approval`);
      continue;
    }

    console.log(`🔄 ${token.name}: Granting unlimited Permit2 approval...`);

    const hash = await walletClient.writeContract({
      address: token.address,
      abi: erc20Abi,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, MAX_UINT256],
      nonce: nonce++,
    });

    console.log(`   ✅ Approve submitted (tx: ${hash})`);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
