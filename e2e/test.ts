import { config } from 'dotenv';
import { spawn, execSync, ChildProcess } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { createWalletClient, createPublicClient, http, parseEther, formatEther, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { TestDiscovery } from './src/discovery';
import { ClientConfig, ScenarioResult, ServerConfig, TestScenario, endpointAssetTransferMethod, endpointPaymentScheme, endpointUsesBatchSettlement } from './src/types';
import { config as loggerConfig, log, verboseLog, errorLog, close as closeLogger, createComboLogger } from './src/logger';
import { handleDiscoveryValidation, shouldRunDiscoveryValidation } from './extensions/bazaar';
import { parseArgs, printHelp } from './src/cli/args';
import { runInteractiveMode } from './src/cli/interactive';
import { filterScenarios, TestFilters, shouldShowExtensionOutput } from './src/cli/filters';
import { minimizeScenarios } from './src/sampling';
import { getNetworkSet, NetworkMode, getNetworkModeDescription, resolveEvmPermit2Asset } from './src/networks/networks';
import { GenericServerProxy } from './src/servers/generic-server';
import { Semaphore, FacilitatorLock } from './src/concurrency';
import { FacilitatorManager } from './src/facilitators/facilitator-manager';
import { waitForHealth } from './src/health';

/**
 * Generates a fresh 32-byte hex salt for a batch-settlement test scenario so
 * concurrent runs don't collide on the same on-chain channel id.
 *
 * @returns Hex-encoded 32-byte salt prefixed with `0x`.
 */
function generateChannelSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Approve Permit2 so that the standard/direct settle path can be exercised.
 * Grants unlimited Permit2 allowance for the given token (permit2-approval script default if omitted).
 */
async function approvePermit2Approval(tokenAddress?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const label = tokenAddress ? `token ${tokenAddress}` : '(script default token)';
    verboseLog(`  🔓 Approving Permit2 for ${label}...`);

    const args = ['scripts/permit2-approval.ts', 'approve'];
    if (tokenAddress) {
      args.push(tokenAddress);
    }
    const child = spawn('tsx', args, {
      cwd: process.cwd(),
      stdio: 'pipe',
      shell: true,
    });

    let stderr = '';

    child.stdout?.on('data', (data) => {
      verboseLog(data.toString().trim());
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
      verboseLog(data.toString().trim());
    });

    child.on('close', (code) => {
      if (code === 0) {
        verboseLog('  ✅ Permit2 approval granted');
        resolve(true);
      } else {
        errorLog(`  ❌ Permit2 approve failed (exit code ${code})`);
        if (stderr) {
          errorLog(`  Error: ${stderr}`);
        }
        resolve(false);
      }
    });

    child.on('error', (error) => {
      errorLog(`  ❌ Failed to run Permit2 approve: ${error.message}`);
      resolve(false);
    });
  });
}

/**
 * Revoke Permit2 approval so that gas sponsoring extensions are exercised.
 * Sets the Permit2 allowance to 0 for the given token (permit2-approval script default if omitted).
 */
async function revokePermit2Approval(tokenAddress?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const label = tokenAddress ? `token ${tokenAddress}` : '(script default token)';
    verboseLog(`  🔓 Revoking Permit2 approval for ${label}...`);

    const args = ['scripts/permit2-approval.ts', 'revoke'];
    if (tokenAddress) {
      args.push(tokenAddress);
    }
    const child = spawn('tsx', args, {
      cwd: process.cwd(),
      stdio: 'pipe',
      shell: true,
    });

    let stderr = '';

    child.stdout?.on('data', (data) => {
      verboseLog(data.toString().trim());
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
      verboseLog(data.toString().trim());
    });

    child.on('close', (code) => {
      if (code === 0) {
        verboseLog('  ✅ Permit2 approval revoked (allowance set to 0)');
        resolve(true);
      } else {
        errorLog(`  ❌ Permit2 revoke failed (exit code ${code})`);
        if (stderr) {
          errorLog(`  Error: ${stderr}`);
        }
        resolve(false);
      }
    });

    child.on('error', (error) => {
      errorLog(`  ❌ Failed to run Permit2 revoke: ${error.message}`);
      resolve(false);
    });
  });
}

/**
 * Shared EVM clients for the ETH sandwich helpers.
 * Lazily initialised on first use so that missing env vars don't blow up
 * non-EVM test runs.
 */
function getEvmClients() {
  const evmNetwork = process.env.EVM_NETWORK || 'eip155:84532';
  const evmRpcUrl = process.env.EVM_RPC_URL;
  const evmChain = evmNetwork === 'eip155:8453' ? base : baseSepolia;

  const facilitatorKey = process.env.FACILITATOR_EVM_PRIVATE_KEY;
  const clientKey = process.env.CLIENT_EVM_PRIVATE_KEY;
  if (!facilitatorKey || !clientKey) {
    throw new Error('FACILITATOR_EVM_PRIVATE_KEY and CLIENT_EVM_PRIVATE_KEY must be set');
  }

  const facilitatorAccount = privateKeyToAccount(facilitatorKey as `0x${string}`);
  const clientAccount = privateKeyToAccount(clientKey as `0x${string}`);

  const publicClient = createPublicClient({
    chain: evmChain,
    transport: http(evmRpcUrl),
  });
  const facilitatorWallet = createWalletClient({
    account: facilitatorAccount,
    chain: evmChain,
    transport: http(evmRpcUrl),
  });
  const clientWallet = createWalletClient({
    account: clientAccount,
    chain: evmChain,
    transport: http(evmRpcUrl),
  });

  return { publicClient, facilitatorWallet, clientWallet, facilitatorAccount, clientAccount };
}

const REVOKE_FUND_AMOUNT = parseEther('0.001');

/**
 * Send a small amount of ETH from the facilitator wallet to the client wallet
 * so the client can pay gas for Permit2 revocation transactions.
 */
async function fundClientForRevoke(): Promise<boolean> {
  const { publicClient, facilitatorWallet, facilitatorAccount, clientAccount } = getEvmClients();

  const clientBalance = await publicClient.getBalance({ address: clientAccount.address });
  if (clientBalance >= REVOKE_FUND_AMOUNT) {
    verboseLog(`  ℹ️  Client already has ${formatEther(clientBalance)} ETH, skipping fund`);
    return true;
  }

  const facilitatorBalance = await publicClient.getBalance({ address: facilitatorAccount.address });
  if (facilitatorBalance < REVOKE_FUND_AMOUNT) {
    errorLog(`  ❌ Facilitator wallet ${facilitatorAccount.address} has insufficient ETH (${formatEther(facilitatorBalance)}) to fund client for revoke.`);
    errorLog(`     Please fund the facilitator wallet with testnet ETH (need at least ${formatEther(REVOKE_FUND_AMOUNT)} ETH).`);
    return false;
  }

  verboseLog(`  💸 Funding client ${clientAccount.address} with ${formatEther(REVOKE_FUND_AMOUNT)} ETH for revoke...`);
  // Retry on nonce errors: load-balanced RPCs can return stale pending nonces,
  // especially when the facilitator SERVICE process (same private key) is settling
  // payments concurrently. A fresh nonce fetch + small delay usually resolves it.
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 500));
    try {
      const nonce = await publicClient.getTransactionCount({
        address: facilitatorAccount.address,
        blockTag: 'pending',
      });
      const hash = await facilitatorWallet.sendTransaction({
        to: clientAccount.address,
        value: REVOKE_FUND_AMOUNT,
        nonce,
      });
      verboseLog(`  ✅ Funded client (tx: ${hash})`);
      return true;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const isNonceError = lastErr.message.toLowerCase().includes('nonce');
      if (!isNonceError) break;
    }
  }
  const errLines = lastErr!.message.split('\n');
  errorLog(`  ❌ Failed to fund client for revoke: ${errLines[0].trim()}`);
  if (errLines.length > 1) verboseLog(errLines.slice(1).join('\n'));
  return false;
}

/**
 * Drain all ETH from the client wallet back to the facilitator wallet,
 * leaving the client with ~0 ETH so the gas sponsoring funding step is
 * exercised during the test.
 */
async function drainClientETH(): Promise<boolean> {
  try {
    const { publicClient, clientWallet, facilitatorAccount, clientAccount } = getEvmClients();

    // Use pending balance so we see any in-flight fund transaction that hasn't confirmed yet.
    const balance = await publicClient.getBalance({ address: clientAccount.address, blockTag: 'pending' });

    // Reserve enough for gas. On L2s getGasPrice() returns a tiny value but
    // viem's sendTransaction uses a higher maxFeePerGas with safety margin.
    // Use a generous fixed buffer to avoid "insufficient funds" from the
    // estimateGas pre-check.
    const GAS_RESERVE = parseEther('0.0001');
    const sendAmount = balance - GAS_RESERVE;

    if (sendAmount <= 0n) {
      verboseLog(`  ℹ️  Client balance (${formatEther(balance)} ETH) too small to drain, leaving as dust`);
      return true;
    }

    verboseLog(`  💸 Draining ${formatEther(sendAmount)} ETH from client back to facilitator...`);
    // Retry on nonce/replacement errors: the revoke tx may still be pending on
    // some RPC nodes so the pending nonce can be stale. A short delay + explicit
    // pending-nonce fetch resolves it the same way fundClientForRevoke does.
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
      try {
        const nonce = await publicClient.getTransactionCount({
          address: clientAccount.address,
          blockTag: 'pending',
        });
        const hash = await clientWallet.sendTransaction({
          to: facilitatorAccount.address,
          value: sendAmount,
          nonce,
        });
        verboseLog(`  ✅ Drained client ETH (tx: ${hash})`);
        return true;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const isNonceError =
          lastErr.message.toLowerCase().includes('nonce') ||
          lastErr.message.toLowerCase().includes('replacement') ||
          lastErr.message.toLowerCase().includes('underpriced');
        if (!isNonceError) break;
      }
    }
    const errLines = lastErr!.message.split('\n');
    errorLog(`  ❌ Failed to drain client ETH: ${errLines[0].trim()}`);
    if (errLines.length > 1) verboseLog(errLines.slice(1).join('\n'));
    return false;
  } catch (err) {
    errorLog(`  ❌ Failed to drain client ETH: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// Load environment variables
config();

// Parse command line arguments
const parsedArgs = parseArgs();

async function startServer(
  server: any,
  serverConfig: ServerConfig
): Promise<boolean> {
  verboseLog(`  🚀 Starting server on port ${serverConfig.port}...`);
  await server.start(serverConfig);

  return waitForHealth(
    () => server.health(),
    { initialDelayMs: 250, label: 'Server' },
  );
}

/**
 * Returns true when the settle response omits the on-chain transaction hash
 * because the request was settled off-chain (e.g. a batch-settlement voucher
 * recorded by the receiver but not yet claimed).
 *
 * @param paymentResponse - Decoded payment-response payload from the server.
 * @returns Whether to skip the transaction-hash presence assertion.
 */
function isOffchainSettleResponse(paymentResponse: any): boolean {
  if (!paymentResponse) return false;
  const extra = paymentResponse.extra ?? {};
  const channelState = extra.channelState ?? {};
  const isBatchSettlement =
    (typeof extra.channelId === 'string' && extra.channelId.length > 0) ||
    (typeof channelState.channelId === 'string' && channelState.channelId.length > 0);
  return isBatchSettlement;
}

async function runClientTest(
  client: any,
  callConfig: ClientConfig
): Promise<ScenarioResult & { verboseLogs?: string[] }> {
  const verboseLogs: string[] = [];

  const bufferLog = (msg: string) => {
    verboseLogs.push(msg);
  };

  try {
    bufferLog(`  📞 Running client: ${JSON.stringify(callConfig, null, 2)}`);
    const result = await client.call(callConfig);
    bufferLog(`  📊 Client result: ${JSON.stringify(result, null, 2)}`);
    // Check if the client execution succeeded
    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Client execution failed',
        verboseLogs
      };
    }

    // Check if we got a 402 Payment Required response (payment failed)
    if (result.status_code === 402) {
      const errorData = result.data as any;
      const errorMsg = errorData?.error || 'Payment required - payment failed';
      return {
        success: false,
        error: `Payment failed (402): ${errorMsg}`,
        data: result.data,
        status_code: result.status_code,
        verboseLogs
      };
    }

    // For protected endpoints, verify the payment actually succeeded
    const paymentResponse = result.payment_response;
    if (paymentResponse) {
      // Payment was required - verify it succeeded
      if (!paymentResponse.success) {
        return {
          success: false,
          error: `Payment failed: ${paymentResponse.errorReason || 'unknown error'}`,
          data: result.data,
          status_code: result.status_code,
          payment_response: paymentResponse,
          verboseLogs
        };
      }

      // Payment should have a transaction hash, except for off-chain settle
      // responses (e.g. batch-settlement vouchers that the server records but
      // does not yet claim on-chain).
      if (!paymentResponse.transaction && !isOffchainSettleResponse(paymentResponse)) {
        return {
          success: false,
          error: 'Payment succeeded but no transaction hash returned',
          data: result.data,
          status_code: result.status_code,
          payment_response: paymentResponse,
          verboseLogs
        };
      }

      // Payment should not have an error reason
      if (paymentResponse.errorReason) {
        return {
          success: false,
          error: `Payment has error reason: ${paymentResponse.errorReason}`,
          data: result.data,
          status_code: result.status_code,
          payment_response: paymentResponse,
          verboseLogs
        };
      }
    }

    // All checks passed
    return {
      success: true,
      data: result.data,
      status_code: result.status_code,
      payment_response: paymentResponse,
      verboseLogs
    };
  } catch (error) {
    bufferLog(`  💥 Client failed: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      verboseLogs
    };
  } finally {
    await client.forceStop();
  }
}

type ClientTestResult = ScenarioResult & { verboseLogs?: string[] };

function getBatchStep(result: ClientTestResult, step: string): any {
  return (result.data as any)?.batchSettlement?.[step];
}

function validateBatchPaymentStep(
  result: ClientTestResult,
  step: string,
  label: string,
  requireTransaction: boolean,
): string | undefined {
  const stepResult = getBatchStep(result, step);
  if (!stepResult) {
    return `Batch-settlement ${label} result missing`;
  }

  if (!stepResult.success) {
    const reason = stepResult.payment_response?.errorReason || stepResult.error || 'unknown error';
    return `Batch-settlement ${label} failed: ${reason}`;
  }

  const paymentResponse = stepResult.payment_response;
  if (!paymentResponse) {
    return `Batch-settlement ${label} missing payment response`;
  }

  if (!paymentResponse.success) {
    return `Batch-settlement ${label} payment failed: ${paymentResponse.errorReason || 'unknown error'}`;
  }

  if (paymentResponse.errorReason) {
    return `Batch-settlement ${label} payment has error reason: ${paymentResponse.errorReason}`;
  }

  if (requireTransaction && !paymentResponse.transaction) {
    return `Batch-settlement ${label} succeeded but no transaction hash returned`;
  }

  if (!requireTransaction && !paymentResponse.transaction && !isOffchainSettleResponse(paymentResponse)) {
    return `Batch-settlement ${label} succeeded but no transaction hash or channel state returned`;
  }

  return undefined;
}

function mergeVerboseLogs(...results: ClientTestResult[]): string[] {
  return results.flatMap(result => result.verboseLogs ?? []);
}

function envFlagDefaultTrue(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

async function runTest() {
  // Show help if requested
  if (parsedArgs.showHelp) {
    printHelp();
    return;
  }

  // Initialize logger
  loggerConfig({ logFile: parsedArgs.logFile, verbose: parsedArgs.verbose });

  log('🚀 Starting X402 E2E Test Suite');
  log('===============================');

  // Load configuration from environment
  const serverEvmAddress = process.env.SERVER_EVM_ADDRESS;
  const serverSvmAddress = process.env.SERVER_SVM_ADDRESS;
  const serverAvmAddress = process.env.SERVER_AVM_ADDRESS;
  const serverAptosAddress = process.env.SERVER_APTOS_ADDRESS;
  const serverHederaAddress = process.env.SERVER_HEDERA_ADDRESS;
  const serverStellarAddress = process.env.SERVER_STELLAR_ADDRESS;
  const serverTvmAddress = process.env.SERVER_TVM_ADDRESS;
  const clientEvmPrivateKey = process.env.CLIENT_EVM_PRIVATE_KEY;
  const clientSvmPrivateKey = process.env.CLIENT_SVM_PRIVATE_KEY;
  const clientAvmPrivateKey = process.env.CLIENT_AVM_PRIVATE_KEY;
  const clientAptosPrivateKey = process.env.CLIENT_APTOS_PRIVATE_KEY;
  const clientHederaAccountId = process.env.CLIENT_HEDERA_ACCOUNT_ID;
  const clientHederaPrivateKey = process.env.CLIENT_HEDERA_PRIVATE_KEY;
  const clientStellarPrivateKey = process.env.CLIENT_STELLAR_PRIVATE_KEY;
  const clientTvmPrivateKey = process.env.CLIENT_TVM_PRIVATE_KEY;
  const facilitatorEvmPrivateKey = process.env.FACILITATOR_EVM_PRIVATE_KEY;
  const facilitatorSvmPrivateKey = process.env.FACILITATOR_SVM_PRIVATE_KEY;
  const facilitatorAvmPrivateKey = process.env.FACILITATOR_AVM_PRIVATE_KEY;
  const facilitatorAptosPrivateKey = process.env.FACILITATOR_APTOS_PRIVATE_KEY;
  const facilitatorHederaAccountId = process.env.FACILITATOR_HEDERA_ACCOUNT_ID;
  const facilitatorHederaPrivateKey = process.env.FACILITATOR_HEDERA_PRIVATE_KEY;
  const facilitatorStellarPrivateKey = process.env.FACILITATOR_STELLAR_PRIVATE_KEY;
  const facilitatorTvmPrivateKey = process.env.FACILITATOR_TVM_PRIVATE_KEY;
  const batchSettlementRecovery = envFlagDefaultTrue(process.env.BATCH_SETTLEMENT_RECOVERY);
  if (!serverEvmAddress || !serverSvmAddress || !clientEvmPrivateKey || !clientSvmPrivateKey || !facilitatorEvmPrivateKey || !facilitatorSvmPrivateKey) {
    errorLog('❌ Missing required environment variables:');
    errorLog(' SERVER_EVM_ADDRESS, SERVER_SVM_ADDRESS, CLIENT_EVM_PRIVATE_KEY, CLIENT_SVM_PRIVATE_KEY, FACILITATOR_EVM_PRIVATE_KEY, and FACILITATOR_SVM_PRIVATE_KEY must be set');
    process.exit(1);
  }

  // Discover all servers, clients, and facilitators (always include legacy)
  const discovery = new TestDiscovery('.', true); // Always discover legacy

  const allClients = discovery.discoverClients();
  const allServers = discovery.discoverServers();
  const allFacilitators = discovery.discoverFacilitators();

  discovery.printDiscoverySummary();

  // Generate all possible scenarios
  const allScenarios = discovery.generateTestScenarios();

  if (allScenarios.length === 0) {
    log('❌ No test scenarios found');
    return;
  }

  let filters: TestFilters;
  let selectedExtensions: string[] | undefined;
  let networkMode: NetworkMode;

  // Interactive or programmatic mode
  if (parsedArgs.mode === 'interactive') {
    const selections = await runInteractiveMode(
      allClients,
      allServers,
      allFacilitators,
      allScenarios,
      parsedArgs.minimize,
      parsedArgs.networkMode // Pass preselected network mode (may be undefined)
    );

    if (!selections) {
      log('\n❌ Cancelled by user');
      return;
    }

    filters = selections;
    selectedExtensions = selections.extensions;
    networkMode = selections.networkMode;
  } else {
    log('\n🤖 Programmatic Mode');
    log('===================\n');

    filters = parsedArgs.filters;
    selectedExtensions = parsedArgs.filters.extensions;

    // In programmatic mode, network mode defaults to testnet if not specified
    networkMode = parsedArgs.networkMode || 'testnet';

    // Print active filters
    const filterEntries = Object.entries(filters).filter(([_, v]) => v && (Array.isArray(v) ? v.length > 0 : true));
    if (filterEntries.length > 0) {
      log('Active filters:');
      filterEntries.forEach(([key, value]) => {
        if (Array.isArray(value) && value.length > 0) {
          log(`  - ${key}: ${value.join(', ')}`);
        }
      });
      log('');
    }
  }

  // Get network configuration based on selected mode
  const networks = getNetworkSet(networkMode);
  const evmPermit2Asset = resolveEvmPermit2Asset(networks);

  const permit2AssetSource = process.env.EVM_PERMIT2_ASSET?.trim()
    ? 'EVM_PERMIT2_ASSET'
    : networks.evm.permit2Asset
      ? 'network default'
      : 'unset';

  log(`\n🌐 Network Mode: ${networkMode.toUpperCase()}`);
  log(`   EVM: ${networks.evm.name} (${networks.evm.caip2})`);
  log(`   EVM Permit2 asset: ${evmPermit2Asset || '(missing)'} (${permit2AssetSource})`);
  log(`   SVM: ${networks.svm.name} (${networks.svm.caip2})`);
  log(`   APTOS: ${networks.aptos.name} (${networks.aptos.caip2})`);
  log(`   HEDERA: ${networks.hedera.name} (${networks.hedera.caip2})`);
  log(`   STELLAR: ${networks.stellar.name} (${networks.stellar.caip2})`);
  log(`   TVM: ${networks.tvm.name} (${networks.tvm.caip2})`);

  if (networkMode === 'mainnet') {
    log('\n⚠️  WARNING: Running on MAINNET - real funds will be used!');
  }
  log('');

  // Apply filters to scenarios
  let filteredScenarios = filterScenarios(allScenarios, filters);

  if (filteredScenarios.length === 0) {
    log('❌ No scenarios match the selections');
    log('💡 Try selecting more options or run without filters\n');
    return;
  }

  const requiredEnvByFamily: Record<string, Array<[string, string | undefined]>> = {
    evm: [
      ['SERVER_EVM_ADDRESS', serverEvmAddress],
      ['CLIENT_EVM_PRIVATE_KEY', clientEvmPrivateKey],
      ['FACILITATOR_EVM_PRIVATE_KEY', facilitatorEvmPrivateKey],
    ],
    svm: [
      ['SERVER_SVM_ADDRESS', serverSvmAddress],
      ['CLIENT_SVM_PRIVATE_KEY', clientSvmPrivateKey],
      ['FACILITATOR_SVM_PRIVATE_KEY', facilitatorSvmPrivateKey],
    ],
    aptos: [
      ['SERVER_APTOS_ADDRESS', serverAptosAddress],
      ['CLIENT_APTOS_PRIVATE_KEY', clientAptosPrivateKey],
      ['FACILITATOR_APTOS_PRIVATE_KEY', facilitatorAptosPrivateKey],
    ],
    stellar: [
      ['SERVER_STELLAR_ADDRESS', serverStellarAddress],
      ['CLIENT_STELLAR_PRIVATE_KEY', clientStellarPrivateKey],
      ['FACILITATOR_STELLAR_PRIVATE_KEY', facilitatorStellarPrivateKey],
    ],
    tvm: [
      ['SERVER_TVM_ADDRESS', serverTvmAddress],
      ['CLIENT_TVM_PRIVATE_KEY', clientTvmPrivateKey],
      ['FACILITATOR_TVM_PRIVATE_KEY', facilitatorTvmPrivateKey],
    ],
  };

  // Apply coverage-based minimization if --min flag is set
  if (parsedArgs.minimize) {
    filteredScenarios = minimizeScenarios(filteredScenarios);

    if (filteredScenarios.length === 0) {
      log('❌ All scenarios are already covered');
      log('💡 This should not happen - coverage tracking may have an issue\n');
      return;
    }
  } else {
    log(`\n✅ ${filteredScenarios.length} scenarios selected`);
  }

  const selectedProtocolFamilies = new Set(filteredScenarios.map(scenario => scenario.protocolFamily));
  const missingRequiredEnv = new Set<string>();
  for (const family of selectedProtocolFamilies) {
    for (const [name, value] of requiredEnvByFamily[family] || []) {
      if (!value) {
        missingRequiredEnv.add(name);
      }
    }
  }

  if (missingRequiredEnv.size > 0) {
    errorLog('❌ Missing required environment variables for selected protocol families:');
    Array.from(missingRequiredEnv).forEach(name => errorLog(` ${name}`));
    process.exit(1);
  }

  if (selectedExtensions && selectedExtensions.length > 0) {
    log(`🎁 Extensions enabled: ${selectedExtensions.join(', ')}`);
  }
  log('');

  // Branch coverage assertions for EVM scenarios
  const evmScenarios = filteredScenarios.filter(s => s.protocolFamily === 'evm');
  if (evmScenarios.length > 0) {
    const hasExactEip3009 = evmScenarios.some(
      s => endpointPaymentScheme(s.endpoint) === 'exact' && endpointAssetTransferMethod(s.endpoint) === 'eip3009',
    );
    const hasExactPermit2 = evmScenarios.some(
      s => endpointPaymentScheme(s.endpoint) === 'exact' && endpointAssetTransferMethod(s.endpoint) === 'permit2',
    );
    const hasPermit2Direct = evmScenarios.some(
      s =>
        endpointPaymentScheme(s.endpoint) === 'exact' &&
        endpointAssetTransferMethod(s.endpoint) === 'permit2' &&
        s.endpoint.schemeOptions?.permit2Direct === true,
    );
    const hasPermit2Eip2612 = evmScenarios.some(
      s =>
        endpointPaymentScheme(s.endpoint) === 'exact' &&
        endpointAssetTransferMethod(s.endpoint) === 'permit2' &&
        !s.endpoint.extensions?.includes('erc20ApprovalGasSponsoring') &&
        s.endpoint.schemeOptions?.permit2Direct !== true,
    );
    const hasPermit2Erc20 = evmScenarios.some(
      s =>
        endpointPaymentScheme(s.endpoint) === 'exact' &&
        endpointAssetTransferMethod(s.endpoint) === 'permit2' &&
        s.endpoint.extensions?.includes('erc20ApprovalGasSponsoring'),
    );

    const hasUpto = evmScenarios.some(s => endpointPaymentScheme(s.endpoint) === 'upto');
    const hasUptoDirect = evmScenarios.some(
      s =>
        endpointPaymentScheme(s.endpoint) === 'upto' && s.endpoint.schemeOptions?.permit2Direct === true,
    );
    const hasUptoEip2612 = evmScenarios.some(
      s =>
        endpointPaymentScheme(s.endpoint) === 'upto' &&
        !s.endpoint.extensions?.includes('erc20ApprovalGasSponsoring') &&
        s.endpoint.schemeOptions?.permit2Direct !== true,
    );
    const hasUptoErc20 = evmScenarios.some(
      s =>
        endpointPaymentScheme(s.endpoint) === 'upto' &&
        s.endpoint.extensions?.includes('erc20ApprovalGasSponsoring'),
    );

    const hasBatchSettlementEip3009 = evmScenarios.some(
      s =>
        endpointPaymentScheme(s.endpoint) === 'batch-settlement' &&
        endpointAssetTransferMethod(s.endpoint) === 'eip3009',
    );
    const hasBatchSettlementPermit2 = evmScenarios.some(
      s =>
        endpointPaymentScheme(s.endpoint) === 'batch-settlement' &&
        endpointAssetTransferMethod(s.endpoint) === 'permit2',
    );
    const hasBatchSettlementPermit2Direct = evmScenarios.some(
      s =>
        endpointPaymentScheme(s.endpoint) === 'batch-settlement' &&
        endpointAssetTransferMethod(s.endpoint) === 'permit2' &&
        s.endpoint.schemeOptions?.permit2Direct === true,
    );
    const hasBatchSettlementPermit2Eip2612 = evmScenarios.some(
      s =>
        endpointPaymentScheme(s.endpoint) === 'batch-settlement' &&
        endpointAssetTransferMethod(s.endpoint) === 'permit2' &&
        !s.endpoint.extensions?.includes('erc20ApprovalGasSponsoring') &&
        s.endpoint.schemeOptions?.permit2Direct !== true,
    );
    const hasBatchSettlementPermit2Erc20 = evmScenarios.some(
      s =>
        endpointPaymentScheme(s.endpoint) === 'batch-settlement' &&
        endpointAssetTransferMethod(s.endpoint) === 'permit2' &&
        s.endpoint.extensions?.includes('erc20ApprovalGasSponsoring'),
    );

    log('🔍 EVM Branch Coverage Check:');
    log(`   Exact EIP-3009 route:          ${hasExactEip3009 ? '✅' : '⚠️  not found'}`);
    log(`   Exact Permit2 route:           ${hasExactPermit2 ? '✅' : '⚠️  not found'}`);
    log(`   Exact Permit2+direct settle:   ${hasPermit2Direct ? '✅' : '⚠️  not found'}`);
    log(`   Exact Permit2+EIP2612 route:   ${hasPermit2Eip2612 ? '✅' : '⚠️  not found (may be covered by permit2 route if eip2612 extension enabled)'}`);
    log(`   Exact Permit2+ERC20 route:     ${hasPermit2Erc20 ? '✅' : '⚠️  not found'}`);
    log(`   Upto route:                    ${hasUpto ? '✅' : '⚠️  not found'}`);
    log(`   Upto+direct settle:            ${hasUptoDirect ? '✅' : '⚠️  not found'}`);
    log(`   Upto+EIP2612 route:            ${hasUptoEip2612 ? '✅' : '⚠️  not found'}`);
    log(`   Upto+ERC20 route:              ${hasUptoErc20 ? '✅' : '⚠️  not found'}`);
    log(`   Batch-settlement EIP-3009:     ${hasBatchSettlementEip3009 ? '✅' : '⚠️  not found'}`);
    log(`   Batch-settlement Permit2:      ${hasBatchSettlementPermit2 ? '✅' : '⚠️  not found'}`);
    log(`   Batch-settlement+direct:       ${hasBatchSettlementPermit2Direct ? '✅' : '⚠️  not found'}`);
    log(`   Batch-settlement+EIP2612:      ${hasBatchSettlementPermit2Eip2612 ? '✅' : '⚠️  not found'}`);
    log(`   Batch-settlement+ERC20:        ${hasBatchSettlementPermit2Erc20 ? '✅' : '⚠️  not found'}`);
    log('');
  }

  // Auto-detect Permit2 scenarios (upto uses Permit2 under the hood)
  const hasPermit2Scenarios = filteredScenarios.some(s => endpointAssetTransferMethod(s.endpoint) === 'permit2');

  if (hasPermit2Scenarios) {
    log('🔐 Permit2 scenarios detected — revoke before gas-sponsored tests, approve before permit2-direct tests');
    if (!evmPermit2Asset) {
      errorLog(
        '❌ Permit2 scenarios need a token address: set EVM_PERMIT2_ASSET or networks.evm.permit2Asset for this mode.',
      );
      process.exit(1);
    }
  }

  // Collect unique facilitators and servers
  const uniqueFacilitators = new Map<string, any>();
  const uniqueServers = new Map<string, any>();

  filteredScenarios.forEach(scenario => {
    if (scenario.facilitator) {
      uniqueFacilitators.set(scenario.facilitator.name, scenario.facilitator);
    }
    uniqueServers.set(scenario.server.name, scenario.server);
  });

  // Validate environment variables for all selected facilitators
  log('\n🔍 Validating facilitator environment variables...\n');
  const missingEnvVars: { facilitatorName: string; missingVars: string[] }[] = [];

  // Environment variables managed by the test framework (don't require user to set)
  const systemManagedVars = new Set([
    'PORT',
    'EVM_PRIVATE_KEY',
    'SVM_PRIVATE_KEY',
    'APTOS_PRIVATE_KEY',
    'HEDERA_ACCOUNT_ID',
    'HEDERA_PRIVATE_KEY',
    'STELLAR_PRIVATE_KEY',
    'TVM_PRIVATE_KEY',
    'EVM_NETWORK',
    'SVM_NETWORK',
    'APTOS_NETWORK',
    'HEDERA_NETWORK',
    'STELLAR_NETWORK',
    'TVM_NETWORK',
    'EVM_RPC_URL',
    'SVM_RPC_URL',
    'APTOS_RPC_URL',
    'HEDERA_NODE_URL',
    'STELLAR_RPC_URL',
    'TONCENTER_BASE_URL',
    'TVM_PROVIDER',
    'TONAPI_API_KEY',
    'TONAPI_BASE_URL',
  ]);

  for (const [facilitatorName, facilitator] of uniqueFacilitators) {
    const requiredVars = facilitator.config.environment?.required || [];
    const missing: string[] = [];

    for (const envVar of requiredVars) {
      // Skip variables managed by the test framework
      if (systemManagedVars.has(envVar)) {
        continue;
      }

      if (!process.env[envVar]) {
        missing.push(envVar);
      }
    }

    if (missing.length > 0) {
      missingEnvVars.push({ facilitatorName, missingVars: missing });
    }
  }

  if (missingEnvVars.length > 0) {
    errorLog('❌ Missing required environment variables for selected facilitators:\n');
    for (const { facilitatorName, missingVars } of missingEnvVars) {
      errorLog(`   ${facilitatorName}:`);
      missingVars.forEach(varName => errorLog(` - ${varName}`));
    }
    errorLog('\n💡 Please set the required environment variables and try again.\n');
    process.exit(1);
  }

  log('  ✅ All required environment variables are present\n');

  // Clean up any processes on test ports from previous runs
  try {
    execSync('pnpm clean:ports', { cwd: process.cwd(), stdio: 'pipe' });
    verboseLog('  🧹 Cleared test ports from previous runs');
    await new Promise(resolve => setTimeout(resolve, 500)); // Allow OS to release ports
  } catch {
    // clean:ports may exit non-zero if no processes were found; that's fine
  }

  interface DetailedTestResult {
    testNumber: number;
    client: string;
    server: string;
    endpoint: string;
    facilitator: string;
    protocolFamily: string;
    passed: boolean;
    error?: string;
    transaction?: string;
    depositTransaction?: string;
    refundTransaction?: string;
    network?: string;
  }

  let testResults: DetailedTestResult[] = [];
  let currentPort = 4022;

  // Assign ports and start all facilitators
  const facilitatorManagers = new Map<string, FacilitatorManager>();

  // Group scenarios by server + facilitator combination
  // This ensures we restart servers when switching facilitators
  interface ServerFacilitatorCombo {
    serverName: string;
    facilitatorName: string | undefined;
    scenarios: typeof filteredScenarios;
    comboIndex: number;
    port: number;
  }

  const serverFacilitatorCombos: ServerFacilitatorCombo[] = [];
  const groupKey = (serverName: string, facilitatorName: string | undefined) =>
    `${serverName}::${facilitatorName || 'none'}`;

  const comboMap = new Map<string, typeof filteredScenarios>();

  for (const scenario of filteredScenarios) {
    const key = groupKey(scenario.server.name, scenario.facilitator?.name);
    if (!comboMap.has(key)) {
      comboMap.set(key, []);
    }
    comboMap.get(key)!.push(scenario);
  }

  // Convert map to array of combos, assigning a unique port to each
  let comboIndex = 0;
  for (const [, scenarios] of comboMap) {
    const firstScenario = scenarios[0];
    serverFacilitatorCombos.push({
      serverName: firstScenario.server.name,
      facilitatorName: firstScenario.facilitator?.name,
      scenarios,
      comboIndex,
      port: currentPort++,
    });
    comboIndex++;
  }

  // Start all facilitators with unique ports
  for (const [facilitatorName, facilitator] of uniqueFacilitators) {
    const port = currentPort++;
    log(`\n🏛️ Starting facilitator: ${facilitatorName} on port ${port}`);

    const manager = new FacilitatorManager(
      facilitator.proxy,
      port,
      networks
    );
    facilitatorManagers.set(facilitatorName, manager);
  }

  // Wait for all facilitators to be ready
  log('\n⏳ Waiting for all facilitators to be ready...');
  const facilitatorUrls = new Map<string, string>();

  for (const [facilitatorName, manager] of facilitatorManagers) {
    const url = await manager.ready();
    if (!url) {
      log(`❌ Failed to start facilitator ${facilitatorName}`);
      process.exit(1);
    }
    facilitatorUrls.set(facilitatorName, url);
    log(`  ✅ Facilitator ${facilitatorName} ready at ${url}`);
  }

  // Start mock facilitator (claims to support everything, used as fallback so
  // servers with routes unsupported by the real facilitator can still start)
  const mockFacilitatorPort = currentPort++;
  log(`\n🎭 Starting mock facilitator on port ${mockFacilitatorPort}...`);
  const mockFacilitatorProcess: ChildProcess = spawn(
    'npx', ['tsx', 'index.ts'],
    {
      cwd: join(process.cwd(), 'mock-facilitator'),
      env: {
        ...process.env,
        PORT: mockFacilitatorPort.toString(),
        EVM_NETWORK: networks.evm.caip2,
        SVM_NETWORK: networks.svm.caip2,
        APTOS_NETWORK: networks.aptos.caip2,
        STELLAR_NETWORK: networks.stellar.caip2,
        TVM_NETWORK: networks.tvm.caip2,
      },
      stdio: 'pipe',
    },
  );
  mockFacilitatorProcess.stderr?.on('data', (data: Buffer) => {
    verboseLog(`[mock-facilitator] stderr: ${data.toString().trim()}`);
  });
  mockFacilitatorProcess.stdout?.on('data', (data: Buffer) => {
    verboseLog(`[mock-facilitator] stdout: ${data.toString().trim()}`);
  });

  const mockFacilitatorUrl = `http://localhost:${mockFacilitatorPort}`;
  const mockHealthy = await waitForHealth(
    async () => {
      try {
        const res = await fetch(`${mockFacilitatorUrl}/health`);
        return { success: res.ok };
      } catch {
        return { success: false };
      }
    },
    { label: 'Mock facilitator' },
  );
  if (!mockHealthy) {
    log('❌ Failed to start mock facilitator');
    mockFacilitatorProcess.kill();
    process.exit(1);
  }
  log(`  ✅ Mock facilitator ready at ${mockFacilitatorUrl}`);

  log('\n✅ All facilitators are ready! Servers will be started/restarted as needed per test scenario.\n');

  log(`🔧 Server/Facilitator combinations: ${serverFacilitatorCombos.length}`);
  serverFacilitatorCombos.forEach(combo => {
    log(`   • ${combo.serverName} + ${combo.facilitatorName || 'none'}: ${combo.scenarios.length} test(s)`);
  });
  if (parsedArgs.parallel) {
    log(`\n⚡ Parallel mode enabled (concurrency: ${parsedArgs.concurrency})`);
  }
  log('');

  // Track which facilitators processed which servers (for discovery validation)
  const facilitatorServerMap = new Map<string, Set<string>>(); // facilitatorName -> Set<serverName>

  // ── Helper: run a single test scenario ────────────────────────────────
  async function runSingleTest(
    scenario: TestScenario,
    port: number,
    localTestNumber: number,
    cLog: { log: typeof log; verboseLog: typeof verboseLog; errorLog: typeof errorLog },
  ): Promise<DetailedTestResult> {
    const facilitatorLabel = scenario.facilitator ? ` via ${scenario.facilitator.name}` : '';
    const testName = `${scenario.client.name} → ${scenario.server.name} → ${scenario.endpoint.path}${facilitatorLabel}`;

    const isBatchSettlement = endpointUsesBatchSettlement(scenario.endpoint);
    const voucherSignerPrivateKey = process.env.CLIENT_EVM_VOUCHER_SIGNER_PRIVATE_KEY;
    const baseClientConfig: ClientConfig = {
      evmPrivateKey: clientEvmPrivateKey!,
      svmPrivateKey: clientSvmPrivateKey!,
      avmPrivateKey: clientAvmPrivateKey || '',
      aptosPrivateKey: clientAptosPrivateKey || '',
      hederaAccountId: clientHederaAccountId || '',
      hederaPrivateKey: clientHederaPrivateKey || '',
      stellarPrivateKey: clientStellarPrivateKey || '',
      tvmPrivateKey: clientTvmPrivateKey || '',
      serverUrl: `http://localhost:${port}`,
      endpointPath: scenario.endpoint.path,
      evmNetwork: networks.evm.caip2,
      evmRpcUrl: networks.evm.rpcUrl,
      hederaNetwork: networks.hedera.caip2,
      hederaNodeUrl: networks.hedera.rpcUrl,
      tvmNetwork: networks.tvm.caip2,
      tvmRpcUrl: networks.tvm.rpcUrl,
    };

    try {
      cLog.log(`🧪 Test #${localTestNumber}: ${testName}`);

      if (isBatchSettlement) {
        const channelSalt = generateChannelSalt();
        const batchBase = {
          channelSalt,
          ...(voucherSignerPrivateKey ? { voucherSignerPrivateKey } : {}),
        };

        if (!batchSettlementRecovery) {
          const fullResult = await runClientTest(scenario.client.proxy, {
            ...baseClientConfig,
            batchSettlement: { ...batchBase, phase: 'full' },
          });
          const fullError = fullResult.success
            ? validateBatchPaymentStep(fullResult, 'deposit', 'deposit', true) ||
            validateBatchPaymentStep(fullResult, 'voucher', 'voucher', false) ||
            validateBatchPaymentStep(fullResult, 'refund', 'refund', true)
            : fullResult.error || 'Batch-settlement client phase failed';

          const depositTransaction = getBatchStep(fullResult, 'deposit')?.payment_response?.transaction;
          const refundTransaction = getBatchStep(fullResult, 'refund')?.payment_response?.transaction;
          const network =
            getBatchStep(fullResult, 'refund')?.payment_response?.network ||
            getBatchStep(fullResult, 'deposit')?.payment_response?.network ||
            fullResult.payment_response?.network;

          const detailedResult: DetailedTestResult = {
            testNumber: localTestNumber,
            client: scenario.client.name,
            server: scenario.server.name,
            endpoint: scenario.endpoint.path,
            facilitator: scenario.facilitator?.name || 'none',
            protocolFamily: scenario.protocolFamily,
            passed: !fullError,
            error: fullError,
            transaction: refundTransaction || depositTransaction,
            depositTransaction,
            refundTransaction,
            network,
          };

          if (fullError) {
            cLog.log(`  ❌ Test failed: ${fullError}`);
            const verboseLogs = fullResult.verboseLogs ?? [];
            if (verboseLogs.length > 0) {
              cLog.log(`  🔍 Verbose logs:`);
              verboseLogs.forEach(logLine => cLog.log(logLine));
            }
            cLog.verboseLog(`  🔍 Error details: ${JSON.stringify(fullResult, null, 2)}`);
          } else {
            cLog.log(`  ✅ Test passed`);
          }

          return detailedResult;
        }

        const initialResult = await runClientTest(scenario.client.proxy, {
          ...baseClientConfig,
          batchSettlement: { ...batchBase, phase: 'initial' },
        });
        const initialError = initialResult.success
          ? validateBatchPaymentStep(initialResult, 'deposit', 'deposit', true) ||
          validateBatchPaymentStep(initialResult, 'voucher', 'voucher', false)
          : initialResult.error || 'Initial batch-settlement client phase failed';

        if (initialError) {
          const detailedResult: DetailedTestResult = {
            testNumber: localTestNumber,
            client: scenario.client.name,
            server: scenario.server.name,
            endpoint: scenario.endpoint.path,
            facilitator: scenario.facilitator?.name || 'none',
            protocolFamily: scenario.protocolFamily,
            passed: false,
            error: initialError,
            depositTransaction: getBatchStep(initialResult, 'deposit')?.payment_response?.transaction,
            network: initialResult.payment_response?.network,
          };
          cLog.log(`  ❌ Test failed: ${initialError}`);
          const verboseLogs = initialResult.verboseLogs ?? [];
          if (verboseLogs.length > 0) {
            cLog.log(`  🔍 Verbose logs:`);
            verboseLogs.forEach(logLine => cLog.log(logLine));
          }
          cLog.verboseLog(`  🔍 Error details: ${JSON.stringify(initialResult, null, 2)}`);
          return detailedResult;
        }

        const recoveryResult = await runClientTest(scenario.client.proxy, {
          ...baseClientConfig,
          batchSettlement: { ...batchBase, phase: 'recovery-refund' },
        });
        const recoveryError = recoveryResult.success
          ? validateBatchPaymentStep(recoveryResult, 'recoveryVoucher', 'recovery voucher', false) ||
          validateBatchPaymentStep(recoveryResult, 'refund', 'refund', true)
          : recoveryResult.error || 'Recovery/refund batch-settlement client phase failed';

        const depositTransaction = getBatchStep(initialResult, 'deposit')?.payment_response?.transaction;
        const refundTransaction = getBatchStep(recoveryResult, 'refund')?.payment_response?.transaction;
        const network =
          getBatchStep(recoveryResult, 'refund')?.payment_response?.network ||
          getBatchStep(initialResult, 'deposit')?.payment_response?.network ||
          recoveryResult.payment_response?.network ||
          initialResult.payment_response?.network;

        if (recoveryError) {
          const detailedResult: DetailedTestResult = {
            testNumber: localTestNumber,
            client: scenario.client.name,
            server: scenario.server.name,
            endpoint: scenario.endpoint.path,
            facilitator: scenario.facilitator?.name || 'none',
            protocolFamily: scenario.protocolFamily,
            passed: false,
            error: recoveryError,
            transaction: refundTransaction || depositTransaction,
            depositTransaction,
            refundTransaction,
            network,
          };
          cLog.log(`  ❌ Test failed: ${recoveryError}`);
          const verboseLogs = mergeVerboseLogs(initialResult, recoveryResult);
          if (verboseLogs.length > 0) {
            cLog.log(`  🔍 Verbose logs:`);
            verboseLogs.forEach(logLine => cLog.log(logLine));
          }
          cLog.verboseLog(`  🔍 Error details: ${JSON.stringify({ initialResult, recoveryResult }, null, 2)}`);
          return detailedResult;
        }

        const detailedResult: DetailedTestResult = {
          testNumber: localTestNumber,
          client: scenario.client.name,
          server: scenario.server.name,
          endpoint: scenario.endpoint.path,
          facilitator: scenario.facilitator?.name || 'none',
          protocolFamily: scenario.protocolFamily,
          passed: true,
          transaction: refundTransaction || depositTransaction,
          depositTransaction,
          refundTransaction,
          network,
        };

        cLog.log(`  ✅ Test passed`);
        return detailedResult;
      }

      const result = await runClientTest(scenario.client.proxy, baseClientConfig);

      const detailedResult: DetailedTestResult = {
        testNumber: localTestNumber,
        client: scenario.client.name,
        server: scenario.server.name,
        endpoint: scenario.endpoint.path,
        facilitator: scenario.facilitator?.name || 'none',
        protocolFamily: scenario.protocolFamily,
        passed: result.success,
        error: result.error,
        transaction: result.payment_response?.transaction,
        network: result.payment_response?.network,
      };

      if (result.success) {
        cLog.log(`  ✅ Test passed`);
      } else {
        cLog.log(`  ❌ Test failed: ${result.error}`);
        if (result.verboseLogs && result.verboseLogs.length > 0) {
          cLog.log(`  🔍 Verbose logs:`);
          result.verboseLogs.forEach(logLine => cLog.log(logLine));
        }
        cLog.verboseLog(`  🔍 Error details: ${JSON.stringify(result, null, 2)}`);
      }

      return detailedResult;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      cLog.log(`  ❌ Test failed with exception: ${errorMsg}`);
      cLog.verboseLog(`  🔍 Exception details: ${error}`);
      return {
        testNumber: localTestNumber,
        client: scenario.client.name,
        server: scenario.server.name,
        endpoint: scenario.endpoint.path,
        facilitator: scenario.facilitator?.name || 'none',
        protocolFamily: scenario.protocolFamily,
        passed: false,
        error: errorMsg,
      };
    }
  }

  // ── Execute a single server+facilitator combo ─────────────────────────
  async function executeCombo(
    combo: ServerFacilitatorCombo,
    evmLock: FacilitatorLock | null,
    nextTestNumber: () => number,
  ): Promise<DetailedTestResult[]> {
    const { serverName, facilitatorName, scenarios, port } = combo;
    const server = uniqueServers.get(serverName)!;
    const cLog = createComboLogger(combo.comboIndex, serverName, facilitatorName);

    // Track facilitator→server mapping
    if (facilitatorName) {
      if (!facilitatorServerMap.has(facilitatorName)) {
        facilitatorServerMap.set(facilitatorName, new Set());
      }
      facilitatorServerMap.get(facilitatorName)!.add(serverName);
    }

    // Create a fresh server instance for this combo (own port, own process)
    const serverProxy = new GenericServerProxy(server.directory);

    const facilitatorUrl = facilitatorName
      ? facilitatorUrls.get(facilitatorName)
      : undefined;

    cLog.log(`🚀 Starting server: ${serverName} (port ${port}) with facilitator: ${facilitatorName || 'none'}`);

    const facilitatorConfig = facilitatorName ? uniqueFacilitators.get(facilitatorName)?.config : undefined;
    const facilitatorSupportsAvm = facilitatorConfig?.protocolFamilies?.includes('avm') ?? false;
    const facilitatorSupportsAptos = facilitatorConfig?.protocolFamilies?.includes('aptos') ?? false;
    const facilitatorSupportsHedera = facilitatorConfig?.protocolFamilies?.includes('hedera') ?? false;
    const facilitatorSupportsStellar = facilitatorConfig?.protocolFamilies?.includes('stellar') ?? false;

    const serverConfig: ServerConfig = {
      port,
      evmPayTo: serverEvmAddress!,
      svmPayTo: serverSvmAddress!,
      avmPayTo: facilitatorSupportsAvm ? (serverAvmAddress || '') : '',
      aptosPayTo: facilitatorSupportsAptos ? (serverAptosAddress || '') : '',
      hederaPayTo:
        facilitatorSupportsHedera &&
          facilitatorHederaAccountId &&
          facilitatorHederaPrivateKey
          ? (serverHederaAddress || '')
          : '',
      hederaAsset: process.env.HEDERA_ASSET,
      hederaAmount: process.env.HEDERA_AMOUNT,
      stellarPayTo: facilitatorSupportsStellar ? (serverStellarAddress || '') : '',
      tvmPayTo: serverTvmAddress || '',
      networks,
      facilitatorUrl,
      mockFacilitatorUrl,
      // Forward the optional receiver-authorizer EOA key so the server can
      // self-manage batch-settlement claim/refund signatures when set.
      ...(process.env.SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY
        ? {
          batchSettlement: {
            receiverAuthorizerPrivateKey:
              process.env.SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY,
          },
        }
        : {}),
    };

    const started = await startServer(serverProxy, serverConfig);
    if (!started) {
      cLog.log(`❌ Failed to start server ${serverName}`);
      return scenarios.map(scenario => ({
        testNumber: nextTestNumber(),
        client: scenario.client.name,
        server: scenario.server.name,
        endpoint: scenario.endpoint.path,
        facilitator: scenario.facilitator?.name || 'none',
        protocolFamily: scenario.protocolFamily,
        passed: false,
        error: 'Server failed to start',
      }));
    }
    cLog.log(`  ✅ Server ${serverName} ready`);

    const results: DetailedTestResult[] = [];
    // Track which endpoint paths have already been "cold started" in this combo.
    // The first test for each path runs the full state-setup (fund/revoke/drain);
    // subsequent tests for the same path skip the setup and run warm.
    const coldStartedEndpoints = new Set<string>();
    try {
      for (const scenario of scenarios) {
        const tn = nextTestNumber();
        const isEvm = scenario.protocolFamily === 'evm';

        if (scenario.endpoint.schemeOptions?.permit2Direct === true) {
          await approvePermit2Approval(evmPermit2Asset);
        } else if (scenario.endpoint.schemeOptions?.coldstart === true) {
          // Key on (client, path) so each client independently runs its own
          // fund → revoke → drain cycle. Without the client name, the second
          // client in a combo silently skips the coldstart and inherits
          // whatever wallet state the first client left behind.
          const endpointKey = `${scenario.client.name}::${scenario.endpoint.path}`;
          if (!coldStartedEndpoints.has(endpointKey)) {
            coldStartedEndpoints.add(endpointKey);
            await fundClientForRevoke();
            // Give fund tx 1s to propagate before submitting revoke (from client wallet)
            await new Promise(resolve => setTimeout(resolve, 1000));
            await revokePermit2Approval(evmPermit2Asset);
            // Give revoke tx 2s to propagate before drain reads pending nonce.
            // Load-balanced RPCs can return a stale pending nonce if queried
            // immediately after the revoke submission, causing the drain to
            // collide with the revoke's nonce ("replacement transaction underpriced").
            await new Promise(resolve => setTimeout(resolve, 2000));
            await drainClientETH();
            // Wait for RPC nonce propagation across load-balanced nodes before the
            // test client (which may use a separate RPC connection) queries the nonce.
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        const isAvm = scenario.protocolFamily === 'avm';

        if (isEvm && facilitatorName && evmLock) {
          const releaseLock = await evmLock.acquire(facilitatorName);
          try {
            results.push(await runSingleTest(scenario, port, tn, cLog));
            await new Promise(resolve => setTimeout(resolve, 1000));
          } finally {
            releaseLock();
          }
        } else {
          results.push(await runSingleTest(scenario, port, tn, cLog));
          if (isAvm) {
            // Pause between AVM tests to avoid 403 rate limiting on free public Algorand nodes
            await new Promise(resolve => setTimeout(resolve, 8000));
          } else if (isEvm) {
            // Brief pause between sequential EVM tests so the facilitator wallet's
            // settlement tx has time to propagate before the next cold-start setup
            // sends from the same account (fundClientForRevoke). Without this,
            // the two can collide on the same nonce on load-balanced RPCs.
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
      }
    } finally {
      cLog.verboseLog(`  🛑 Stopping ${serverName} (finished combo)`);
      await serverProxy.stop();
    }

    return results;
  }

  // ── Unified execution: concurrency=1 for sequential, N for parallel ──
  const effectiveConcurrency = parsedArgs.parallel ? parsedArgs.concurrency : 1;
  const evmLock = parsedArgs.parallel ? new FacilitatorLock() : null;
  const semaphore = new Semaphore(effectiveConcurrency);

  let globalTestNumber = 0;
  const nextTestNumber = () => ++globalTestNumber;

  const comboPromises = serverFacilitatorCombos.map(async (combo) => {
    const release = await semaphore.acquire();
    try {
      return await executeCombo(combo, evmLock, nextTestNumber);
    } finally {
      release();
    }
  });

  testResults = (await Promise.all(comboPromises)).flat();

  // Run discovery validation before cleanup (while facilitators are still running)
  const facilitatorsWithConfig = Array.from(uniqueFacilitators.values()).map((f: any) => ({
    proxy: facilitatorManagers.get(f.name)!.getProxy(),
    config: f.config,
  }));

  const serversArray = Array.from(uniqueServers.values());

  // Build a serverName→port map for discovery validation (first combo per server).
  const discoveryServerPorts = new Map<string, number>();
  for (const combo of serverFacilitatorCombos) {
    if (!discoveryServerPorts.has(combo.serverName)) {
      discoveryServerPorts.set(combo.serverName, combo.port);
    }
  }

  // Run discovery validation if bazaar extension is enabled
  let discoveryFailed = false;
  const showBazaarOutput = shouldShowExtensionOutput('bazaar', selectedExtensions);
  if (showBazaarOutput && shouldRunDiscoveryValidation(facilitatorsWithConfig, serversArray)) {
    log('\n🔍 Running Bazaar Discovery Validation...\n');
    const discoveryResult = await handleDiscoveryValidation(
      facilitatorsWithConfig,
      serversArray,
      discoveryServerPorts,
      facilitatorServerMap
    );
    discoveryFailed = !discoveryResult.success;
  }

  // Clean up facilitators (servers already stopped in test loop for both modes)
  log('\n🧹 Cleaning up...');

  // Stop all facilitators
  const facilitatorStopPromises: Promise<void>[] = [];
  for (const [facilitatorName, manager] of facilitatorManagers) {
    log(`  🛑 Stopping facilitator: ${facilitatorName}`);
    facilitatorStopPromises.push(manager.stop());
  }
  log('  🛑 Stopping mock facilitator');
  mockFacilitatorProcess.kill();
  await Promise.all(facilitatorStopPromises);

  // Calculate totals
  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;

  // Summary
  log('');
  log('📊 Test Summary');
  log('==============');
  log(`🌐 Network: ${networkMode} (${getNetworkModeDescription(networkMode)})`);
  log(`✅ Passed: ${passed}`);
  log(`❌ Failed: ${failed}`);
  log(`📈 Total: ${passed + failed}`);
  log('');

  // Detailed results table
  log('📋 Detailed Test Results');
  log('========================');
  log('');

  // Group by status
  const passedTests = testResults.filter(r => r.passed);
  const failedTests = testResults.filter(r => !r.passed);

  if (passedTests.length > 0) {
    log('✅ PASSED TESTS:');
    log('');
    passedTests.forEach(test => {
      log(`  #${test.testNumber.toString().padStart(2, ' ')}: ${test.client} → ${test.server} → ${test.endpoint}`);
      log(`      Facilitator: ${test.facilitator}`);
      if (test.network) {
        log(`      Network: ${test.network}`);
      }
      if (test.depositTransaction) {
        log(`      Deposit Tx: ${test.depositTransaction}`);
      }
      if (test.refundTransaction) {
        log(`      Refund Tx: ${test.refundTransaction}`);
      }
      if (test.transaction && !test.depositTransaction && !test.refundTransaction) {
        log(`      Tx: ${test.transaction}`);
      }
    });
    log('');
  }

  if (failedTests.length > 0) {
    log('❌ FAILED TESTS:');
    log('');
    failedTests.forEach(test => {
      log(`  #${test.testNumber.toString().padStart(2, ' ')}: ${test.client} → ${test.server} → ${test.endpoint}`);
      log(`      Facilitator: ${test.facilitator}`);
      if (test.network) {
        log(`      Network: ${test.network}`);
      }
      log(`      Error: ${test.error || 'Unknown error'}`);
    });
    log('');
  }

  // Breakdown by facilitator
  const facilitatorBreakdown = testResults.reduce((acc, test) => {
    const key = test.facilitator;
    if (!acc[key]) acc[key] = { passed: 0, failed: 0 };
    if (test.passed) acc[key].passed++;
    else acc[key].failed++;
    return acc;
  }, {} as Record<string, { passed: number; failed: number }>);

  log('📊 Breakdown by Facilitator:');
  Object.entries(facilitatorBreakdown).forEach(([facilitator, stats]) => {
    const total = stats.passed + stats.failed;
    const passRate = total > 0 ? Math.round((stats.passed / total) * 100) : 0;
    log(` ${facilitator.padEnd(15)} ✅ ${stats.passed} / ❌ ${stats.failed} (${passRate}%)`);
  });
  log('');

  // Breakdown by server
  const serverBreakdown = testResults.reduce((acc, test) => {
    const key = test.server;
    if (!acc[key]) acc[key] = { passed: 0, failed: 0 };
    if (test.passed) acc[key].passed++;
    else acc[key].failed++;
    return acc;
  }, {} as Record<string, { passed: number; failed: number }>);

  log('📊 Breakdown by Server:');
  Object.entries(serverBreakdown).forEach(([server, stats]) => {
    const total = stats.passed + stats.failed;
    const passRate = total > 0 ? Math.round((stats.passed / total) * 100) : 0;
    log(` ${server.padEnd(20)} ✅ ${stats.passed} / ❌ ${stats.failed} (${passRate}%)`);
  });
  log('');

  // Breakdown by client
  const clientBreakdown = testResults.reduce((acc, test) => {
    const key = test.client;
    if (!acc[key]) acc[key] = { passed: 0, failed: 0 };
    if (test.passed) acc[key].passed++;
    else acc[key].failed++;
    return acc;
  }, {} as Record<string, { passed: number; failed: number }>);

  log('📊 Breakdown by Client:');
  Object.entries(clientBreakdown).forEach(([client, stats]) => {
    const total = stats.passed + stats.failed;
    const passRate = total > 0 ? Math.round((stats.passed / total) * 100) : 0;
    log(`   ${client.padEnd(20)} ✅ ${stats.passed} / ❌ ${stats.failed} (${passRate}%)`);
  });
  log('');

  // Protocol family breakdown
  const protocolBreakdown = testResults.reduce((acc, test) => {
    const key = test.protocolFamily;
    if (!acc[key]) acc[key] = { passed: 0, failed: 0 };
    if (test.passed) acc[key].passed++;
    else acc[key].failed++;
    return acc;
  }, {} as Record<string, { passed: number; failed: number }>);

  if (Object.keys(protocolBreakdown).length > 1) {
    log('📊 Protocol Family Breakdown:');
    Object.entries(protocolBreakdown).forEach(([protocol, stats]) => {
      const total = stats.passed + stats.failed;
      log(` ${protocol.toUpperCase()}: ✅ ${stats.passed} / ❌ ${stats.failed} / 📈 ${total} total`);
    });
    log('');
  }

  // Write structured JSON output if requested
  if (parsedArgs.outputJson) {
    const breakdown = (results: DetailedTestResult[], key: keyof DetailedTestResult) =>
      results.reduce((acc, test) => {
        const k = String(test[key]);
        if (!acc[k]) acc[k] = { passed: 0, failed: 0 };
        if (test.passed) acc[k].passed++;
        else acc[k].failed++;
        return acc;
      }, {} as Record<string, { passed: number; failed: number }>);

    const jsonOutput = {
      summary: {
        total: passed + failed,
        passed,
        failed,
        networkMode,
      },
      results: testResults,
      breakdowns: {
        byFacilitator: breakdown(testResults, 'facilitator'),
        byServer: breakdown(testResults, 'server'),
        byClient: breakdown(testResults, 'client'),
        byProtocolFamily: breakdown(testResults, 'protocolFamily'),
      },
    };

    writeFileSync(parsedArgs.outputJson, JSON.stringify(jsonOutput, null, 2));
    log(`📄 JSON results written to ${parsedArgs.outputJson}`);
  }

  // Close logger
  closeLogger();

  if (failed > 0 || discoveryFailed) {
    process.exit(1);
  }
}

// Run the test
runTest().catch(error => errorLog(error));
