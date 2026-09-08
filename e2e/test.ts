import 'dotenv/config';
import { spawn, execSync, ChildProcess } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { createWalletClient, createPublicClient, http, parseEther, formatEther, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { TestDiscovery } from './src/discovery';
import { ClientConfig, ScenarioResult, ServerConfig, TestScenario, endpointAssetTransferMethod, endpointPaymentFlow, endpointPaymentScheme, endpointUsesBatchSettlement } from './src/types';
import { config as loggerConfig, log, verboseLog, errorLog, close as closeLogger, createComboLogger } from './src/logger';
import { handleDiscoveryValidation, shouldRunDiscoveryValidation, type TestedDiscoveryScenario } from './extensions/bazaar';
import { parseArgs, printHelp } from './src/cli/args';
import { runInteractiveMode } from './src/cli/interactive';
import { filterScenarios, TestFilters, shouldShowExtensionOutput } from './src/cli/filters';
import { minimizeScenarios } from './src/sampling';
import { getNetworkSet, NetworkMode, NetworkConfig, getNetworkModeDescription, resolveEvmPermit2Asset, PROTOCOL_FAMILIES, requiredEnvForFamily, requiredRpcEnvForFamily, protocolFamilyForCredentialKey } from './src/networks/networks';
import { injectNetworkEnv } from './src/env';
import { FACILITATOR_ENV_PREFLIGHT_ALLOWLIST } from './src/mechanisms';
import { GenericServerProxy } from './src/servers/generic-server';
import { Semaphore, ResourceLock } from './src/concurrency';
import { FacilitatorManager } from './src/facilitators/facilitator-manager';
import { waitForHealth } from './src/health';
import { probeMcpReady } from './src/mcpHealth';
import { createPortAllocator } from './src/ports';

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

// ── Transient on-chain failure resilience ───────────────────────────────────
// EVM Permit2 / gas-sponsoring / coldstart flows depend on testnet RPC state
// (Permit2 allowance + account nonce) being visible across load-balanced nodes.
// When that state hasn't propagated yet, the resource server's local pre-check
// rejects the payment with a transient 402 before it ever reaches the
// facilitator. These failures are non-deterministic (a different subset fails
// each run) and clear on a short retry once state settles. eip3009 and non-EVM
// flows don't exhibit this, so retries are scoped to EVM Permit2 scenarios.
const EVM_PAYMENT_MAX_ATTEMPTS = 3;
const EVM_PAYMENT_RETRY_DELAY_MS = 4000;

/**
 * Heuristic for whether a failed EVM payment is a transient on-chain/RPC issue
 * worth retrying (vs a deterministic structural failure that would just repeat).
 */
function isTransientPaymentFailure(error?: string): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return (
    e.includes('402') ||
    e.includes('payment required') ||
    e.includes('payment failed') ||
    e.includes('nonce') ||
    e.includes('replacement transaction') ||
    e.includes('underpriced') ||
    e.includes('insufficient allowance') ||
    e.includes('timeout') ||
    e.includes('timed out') ||
    e.includes('econnreset') ||
    e.includes('econnrefused') ||
    e.includes('fetch failed') ||
    e.includes('socket hang up')
  );
}

/**
 * Approve Permit2 so that the standard/direct settle path can be exercised.
 * Grants unlimited Permit2 allowance for the given token (permit2-approval script default if omitted).
 */
async function approvePermit2Approval(evm: NetworkConfig, tokenAddress?: string): Promise<boolean> {
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
      env: { ...process.env, EVM_NETWORK: evm.caip2, EVM_RPC_URL: evm.rpcUrl },
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
async function revokePermit2Approval(evm: NetworkConfig, tokenAddress?: string): Promise<boolean> {
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
      env: { ...process.env, EVM_NETWORK: evm.caip2, EVM_RPC_URL: evm.rpcUrl },
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

/** True when a client declares Swig setup env (svm-smart-wallet overlay). */
function clientRequiresSwigSetup(client: { config: { environment?: { required?: string[] } } }): boolean {
  return (client.config.environment?.required ?? []).includes('SWIG_ACCOUNT_ADDRESS');
}

type SwigSetupResult = {
  ok?: boolean;
  swigAccountAddress?: string;
  created?: boolean;
  swigIdBase58?: string;
};

function applySwigSetupResult(result: SwigSetupResult, logCreation: boolean): boolean {
  if (!result.ok || !result.swigAccountAddress) {
    return false;
  }

  process.env.SWIG_ACCOUNT_ADDRESS = result.swigAccountAddress;
  if (result.swigIdBase58) {
    process.env.SWIG_ID_BASE58 = result.swigIdBase58;
  }

  if (logCreation && result.created) {
    log(`  ✅ New Swig smart wallet: SWIG_ACCOUNT_ADDRESS=${result.swigAccountAddress}`);
    if (result.swigIdBase58) {
      log(`     SWIG_ID_BASE58=${result.swigIdBase58}`);
    }
  } else {
    verboseLog(`  ✅ Swig setup complete: ${result.swigAccountAddress}`);
  }

  return true;
}

function parseSwigSetupOutput(stdout: string): SwigSetupResult | undefined {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as SwigSetupResult;
      if (parsed.ok && parsed.swigAccountAddress) {
        return parsed;
      }
    } catch {
      // not JSON — keep scanning
    }
  }
  return undefined;
}

/**
 * Prepare Swig smart-wallet state for svm-smart-wallet e2e client tests.
 * Creates/funds via scripts/swig-setup.ts when SWIG_ACCOUNT_ADDRESS is unset or
 * USDC balance is low; reuses SWIG_ACCOUNT_ADDRESS from env when already set.
 */
async function setupSwigWallet(svmRpcUrl: string, logCreation = false): Promise<boolean> {
  return new Promise((resolve) => {
    verboseLog('  🔧 Running Swig wallet setup...');

    const child = spawn('tsx', ['scripts/swig-setup.ts'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: {
        ...process.env,
        SVM_RPC_URL: svmRpcUrl,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (logCreation) {
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) {
            log(trimmed);
          }
        }
      } else {
        verboseLog(text.trim());
      }
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
      verboseLog(data.toString().trim());
    });

    child.on('close', (code) => {
      if (code !== 0) {
        errorLog(`  ❌ Swig setup failed (exit code ${code})`);
        if (stderr) {
          errorLog(`  Error: ${stderr}`);
        }
        resolve(false);
        return;
      }

      const parsed = parseSwigSetupOutput(stdout);
      if (parsed && applySwigSetupResult(parsed, logCreation)) {
        resolve(true);
        return;
      }

      if (process.env.SWIG_ACCOUNT_ADDRESS) {
        verboseLog(`  ✅ Swig setup complete (using SWIG_ACCOUNT_ADDRESS=${process.env.SWIG_ACCOUNT_ADDRESS})`);
        resolve(true);
        return;
      }

      errorLog('  ❌ Swig setup succeeded but no swigAccountAddress in output');
      resolve(false);
    });

    child.on('error', (error) => {
      errorLog(`  ❌ Failed to run Swig setup: ${error.message}`);
      resolve(false);
    });
  });
}

/**
 * Shared EVM clients for the ETH sandwich helpers.
 * Fed from the resolved NetworkSet (not the parent process env) so cold-start
 * approve/revoke honor `--mainnet`/`--testnet` instead of silently reading
 * whatever `EVM_RPC_URL` happens to be set to on the harness process.
 */
function getEvmClients(evm: NetworkConfig) {
  const evmChain = evm.caip2 === 'eip155:8453' ? base : baseSepolia;
  const evmRpcUrl = evm.rpcUrl;

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

type EvmResourceKeyContext = {
  evmCaip2: string;
  evmPermit2Asset: string | undefined;
  clientEvmAddress: string | undefined;
  facilitatorEvmAddress: string | undefined;
};

/**
 * Derive shared-resource lock keys for a scenario. Scenarios without shared
 * mutable state return an empty list and stay fully parallel.
 */
function getScenarioResourceKeys(
  scenario: TestScenario,
  ctx: EvmResourceKeyContext,
): string[] {
  if (scenario.protocolFamily !== 'evm') {
    return [];
  }

  const facilitatorAddress = ctx.facilitatorEvmAddress;
  if (!facilitatorAddress) {
    return [];
  }

  const keys: string[] = [
    `evm:${ctx.evmCaip2}:facilitator:${facilitatorAddress.toLowerCase()}`,
  ];

  const touchesClientPermit2State =
    scenario.endpoint.schemeOptions?.permit2Direct === true ||
    scenario.endpoint.schemeOptions?.coldstart === true;

  if (touchesClientPermit2State && ctx.clientEvmAddress && ctx.evmPermit2Asset) {
    keys.push(
      `evm:${ctx.evmCaip2}:client:${ctx.clientEvmAddress.toLowerCase()}:permit2:${ctx.evmPermit2Asset.toLowerCase()}`,
    );
  }

  return keys;
}

const REVOKE_FUND_AMOUNT = parseEther('0.001');

/**
 * Send a small amount of ETH from the facilitator wallet to the client wallet
 * so the client can pay gas for Permit2 revocation transactions.
 */
async function fundClientForRevoke(evm: NetworkConfig): Promise<boolean> {
  const { publicClient, facilitatorWallet, facilitatorAccount, clientAccount } = getEvmClients(evm);

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
async function drainClientETH(evm: NetworkConfig): Promise<boolean> {
  try {
    const { publicClient, clientWallet, facilitatorAccount, clientAccount } = getEvmClients(evm);

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

// Parse command line arguments
const parsedArgs = parseArgs();

async function startServer(
  server: any,
  serverConfig: ServerConfig,
  options?: { transport?: string },
): Promise<boolean> {
  verboseLog(`  🚀 Starting server on port ${serverConfig.port}...`);
  await server.start(serverConfig);

  const healthy = await waitForHealth(
    () => server.health(),
    { initialDelayMs: 250, label: 'Server' },
  );

  if (!healthy) {
    return false;
  }

  if (options?.transport !== 'mcp') {
    if (typeof server.verifyPaidRoutes === 'function') {
      const { ok, problems } = await server.verifyPaidRoutes(serverConfig.enabledFamilies);
      if (!ok) {
        errorLog(
          `  ❌ Server does not mount every paid route it declares in the mechanisms catalog:\n     ${problems.join('\n     ')}`,
        );
        return false;
      }
    }
    return true;
  }

  // Probe the real protocol (SSE connect + initialize handshake) before handing off to the first real test
  // request, to avoid racing a freshly booted server's session warm-up.
  return waitForHealth(
    async () => ({ success: await probeMcpReady(server.getUrl()) }),
    { intervalMs: 500, maxAttempts: 10, label: 'MCP session' },
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

function maskSecret(value: string): string {
  if (value.length <= 10) return '[redacted]';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function maskPrivateKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(maskPrivateKeys) as T;
  }
  if (value && typeof value === 'object') {
    const masked: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      masked[key] =
        /(privateKey|seed)$/i.test(key) && typeof entry === 'string' && entry.length > 0
          ? maskSecret(entry)
          : maskPrivateKeys(entry);
    }
    return masked as T;
  }
  return value;
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
    bufferLog(`  📞 Running client: ${JSON.stringify(maskPrivateKeys(callConfig), null, 2)}`);
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

function waitForChildProcess(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    const onClose = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);

    child.once('close', onClose);
  });
}

async function stopMockFacilitator(child: ChildProcess, url: string): Promise<void> {
  try {
    const response = await fetch(`${url}/close`, {
      method: 'POST',
      signal: AbortSignal.timeout(2_000),
    });
    await response.text();
  } catch (error) {
    verboseLog(`Mock facilitator graceful shutdown failed: ${String(error)}`);
  }

  if (await waitForChildProcess(child, 3_000)) {
    return;
  }

  child.kill('SIGTERM');
  if (await waitForChildProcess(child, 3_000)) {
    return;
  }

  child.kill('SIGKILL');
  await waitForChildProcess(child, 2_000);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function runTest() {
  // Show help if requested
  if (parsedArgs.showHelp) {
    printHelp();
    return;
  }

  // Initialize logger
  loggerConfig({ logFile: parsedArgs.logFile, verbose: parsedArgs.verbose });

  const startTime = Date.now();

  log('🚀 Starting X402 E2E Test Suite');
  log('===============================');

  // Env keys used below (preflight + funding use catalog/process.env directly)
  const clientEvmPrivateKey = process.env.CLIENT_EVM_PRIVATE_KEY;
  const facilitatorEvmPrivateKey = process.env.FACILITATOR_EVM_PRIVATE_KEY;
  const facilitatorHederaAccountId = process.env.FACILITATOR_HEDERA_ACCOUNT_ID;
  const facilitatorHederaPrivateKey = process.env.FACILITATOR_HEDERA_PRIVATE_KEY;
  const batchSettlementRecovery = envFlagDefaultTrue(process.env.EVM_BATCH_SETTLEMENT_RECOVERY);

  // Discover all servers, clients, and facilitators (always include legacy)
  const discovery = new TestDiscovery('.');

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
  for (const family of PROTOCOL_FAMILIES) {
    const net = networks[family];
    log(`   ${family.toUpperCase()}: ${net.name} (${net.caip2})`);
    if (family === 'evm') {
      log(`   EVM Permit2 asset: ${evmPermit2Asset || '(missing)'} (${permit2AssetSource})`);
    }
  }

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

  const requiredEnvByFamily: Record<string, Array<[string, string | undefined]>> = {};
  for (const family of PROTOCOL_FAMILIES) {
    const keys = [...requiredEnvForFamily(family), ...requiredRpcEnvForFamily(family, networkMode)];
    requiredEnvByFamily[family] = keys.map(key => [key, process.env[key]]);
  }

  // Apply coverage-based minimization if --min flag is set
  if (parsedArgs.minimize) {
    filteredScenarios = minimizeScenarios(filteredScenarios, parsedArgs.seed);

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

  const hasSwigSmartWalletScenarios = filteredScenarios.some(s => clientRequiresSwigSetup(s.client));

  if (hasSwigSmartWalletScenarios) {
    log('🔧 Swig smart-wallet scenarios detected — swig-setup creates/funds when needed (see e2e/.env)');
    log('');
  }

  // Collect unique facilitators, servers, and clients
  const uniqueFacilitators = new Map<string, any>();
  const uniqueServers = new Map<string, any>();
  const uniqueClients = new Map<string, any>();

  filteredScenarios.forEach(scenario => {
    if (scenario.facilitator) {
      uniqueFacilitators.set(scenario.facilitator.name, scenario.facilitator);
    }
    uniqueServers.set(scenario.server.name, scenario.server);
    uniqueClients.set(scenario.client.name, scenario.client);
  });

  // Validate facilitator and client env against catalog-declared requirements.
  log('\n🔍 Validating facilitator and client environment variables...\n');
  const missingEnvVars: { componentName: string; missingVars: string[] }[] = [];

  const componentsToValidate: Map<string, any>[] = [uniqueFacilitators, uniqueClients];

  for (const components of componentsToValidate) {
    for (const [componentName, component] of components) {
      const requiredVars = component.config.environment?.required || [];
      const missing: string[] = [];

      for (const envVar of requiredVars) {
        // Skip env keys the harness assigns itself (e.g. PORT), never operator-supplied
        if (FACILITATOR_ENV_PREFLIGHT_ALLOWLIST.has(envVar)) {
          continue;
        }
        // Swig smart-wallet: swig-setup creates/persists these before each scenario.
        if (
          clientRequiresSwigSetup(component) &&
          (envVar === 'SWIG_ACCOUNT_ADDRESS' || envVar === 'SWIG_ID_BASE58')
        ) {
          continue;
        }
        // Skip credentials for families not in this run (catalog marks all wallet
        // keys required per family; only selected families need them present).
        const family = protocolFamilyForCredentialKey(envVar);
        if (family && !selectedProtocolFamilies.has(family)) {
          continue;
        }

        if (!process.env[envVar]) {
          missing.push(envVar);
        }
      }

      if (missing.length > 0) {
        missingEnvVars.push({ componentName, missingVars: missing });
      }
    }
  }

  if (missingEnvVars.length > 0) {
    errorLog('❌ Missing required environment variables for selected facilitators/clients:\n');
    for (const { componentName, missingVars } of missingEnvVars) {
      errorLog(`   ${componentName}:`);
      missingVars.forEach(varName => errorLog(` - ${varName}`));
    }
    errorLog('\n💡 Please set the required environment variables and try again.\n');
    process.exit(1);
  }

  log('  ✅ All required environment variables are present\n');

  if (hasSwigSmartWalletScenarios) {
    log('🔧 Bootstrapping Swig smart wallet (create if unset, fund if low)...\n');
    const swigReady = await setupSwigWallet(networks.svm.rpcUrl, true);
    if (!swigReady) {
      errorLog('❌ Swig wallet bootstrap failed — fund CLIENT_SVM_PRIVATE_KEY with devnet SOL and USDC');
      process.exit(1);
    }
    log('');
  }

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
    scheme: string;
    assetTransferMethod: string;
    paymentFlow: string;
    transport: string;
    version: string;
    passed: boolean;
    error?: string;
    transaction?: string;
    depositTransaction?: string;
    refundTransaction?: string;
    network?: string;
  }

  function scenarioDimensions(
    scenario: TestScenario,
  ): Pick<DetailedTestResult, 'scheme' | 'assetTransferMethod' | 'paymentFlow' | 'transport' | 'version'> {
    return {
      scheme: endpointPaymentScheme(scenario.endpoint),
      assetTransferMethod: endpointAssetTransferMethod(scenario.endpoint) ?? 'n/a',
      paymentFlow: endpointPaymentFlow(scenario.endpoint),
      transport: scenario.server.config.transport || 'http',
      version: String(scenario.server.config.x402Version ?? 1),
    };
  }

  function buildBreakdown(
    results: DetailedTestResult[],
    key: keyof DetailedTestResult,
  ): Record<string, { passed: number; failed: number }> {
    return results.reduce((acc, test) => {
      const k = String(test[key]);
      if (!acc[k]) acc[k] = { passed: 0, failed: 0 };
      if (test.passed) acc[k].passed++;
      else acc[k].failed++;
      return acc;
    }, {} as Record<string, { passed: number; failed: number }>);
  }

  function logBreakdown(
    title: string,
    breakdown: Record<string, { passed: number; failed: number }>,
    padEnd = 15,
    style: 'rate' | 'total' = 'rate',
  ): void {
    log(`📊 ${title}:`);
    Object.entries(breakdown).forEach(([name, stats]) => {
      const total = stats.passed + stats.failed;
      if (style === 'total') {
        log(` ${name.toUpperCase()}: ✅ ${stats.passed} / ❌ ${stats.failed} / 📈 ${total} total`);
        return;
      }
      const passRate = total > 0 ? Math.round((stats.passed / total) * 100) : 0;
      log(` ${name.padEnd(padEnd)} ✅ ${stats.passed} / ❌ ${stats.failed} (${passRate}%)`);
    });
    log('');
  }

  let testResults: DetailedTestResult[] = [];
  const allocatePort = createPortAllocator(4022);

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

  // Convert map to array of combos, assigning a unique port to each.
  // Within each combo, sort scenarios so permit2Direct tests run before
  // coldstart tests. The coldstart flow drains the shared client wallet's
  // ETH; if it ran first, a subsequent permit2Direct test would have no
  // gas for its Permit2 approve transaction.
  const schemeOptionsPriority = (scenario: TestScenario): number => {
    if (scenario.endpoint.schemeOptions?.permit2Direct === true) return 0;
    // No special schemeOptions (plain warmup, eip3009, etc.) — middle
    if (!scenario.endpoint.schemeOptions?.coldstart) return 1;
    // coldstart drains ETH — always last
    return 2;
  };

  let comboIndex = 0;
  for (const [, scenarios] of comboMap) {
    const sorted = [...scenarios].sort((a, b) => schemeOptionsPriority(a) - schemeOptionsPriority(b));
    const firstScenario = sorted[0];
    serverFacilitatorCombos.push({
      serverName: firstScenario.server.name,
      facilitatorName: firstScenario.facilitator?.name,
      scenarios: sorted,
      comboIndex,
      port: allocatePort(),
    });
    comboIndex++;
  }

  // Start all facilitators with unique ports
  for (const [facilitatorName, facilitator] of uniqueFacilitators) {
    const port = allocatePort();
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
  const mockFacilitatorPort = allocatePort();
  log(`\n🎭 Starting mock facilitator on port ${mockFacilitatorPort}...`);
  const mockFacilitatorProcess: ChildProcess = spawn(
    process.execPath, ['--import', 'tsx', 'index.ts'],
    {
      cwd: join(process.cwd(), 'mock-facilitator'),
      env: {
        ...process.env,
        PORT: mockFacilitatorPort.toString(),
        ...injectNetworkEnv(networks),
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
    await stopMockFacilitator(mockFacilitatorProcess, mockFacilitatorUrl);
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

  // Track which facilitators processed which servers (legacy discovery fallback)
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
    const voucherSignerPrivateKey = process.env.CLIENT_EVM_BATCH_SETTLEMENT_VOUCHER_SIGNER_PRIVATE_KEY;
    const baseClientConfig: ClientConfig = {
      serverUrl: `http://localhost:${port}`,
      endpointPath: scenario.endpoint.path,
      networks,
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
            ...scenarioDimensions(scenario),
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
            ...scenarioDimensions(scenario),
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
            ...scenarioDimensions(scenario),
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
          ...scenarioDimensions(scenario),
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
        ...scenarioDimensions(scenario),
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
        ...scenarioDimensions(scenario),
        passed: false,
        error: errorMsg,
      };
    }
  }

  // ── Execute a single server+facilitator combo ─────────────────────────
  async function executeCombo(
    combo: ServerFacilitatorCombo,
    resourceLock: ResourceLock | null,
    evmResourceKeyContext: EvmResourceKeyContext,
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

    const enabledFamilies: import('./src/types').ProtocolFamily[] = ['evm', 'svm'];
    for (const family of PROTOCOL_FAMILIES) {
      if (family === 'evm' || family === 'svm') continue;
      if (!(facilitatorConfig?.protocolFamilies?.includes(family) ?? false)) continue;
      if (family === 'hedera' && (!facilitatorHederaAccountId || !facilitatorHederaPrivateKey)) {
        continue;
      }
      enabledFamilies.push(family);
    }

    // Optional SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY (server role only) opts
    // into self-managed batch-settlement claim/refund signing; omit to delegate
    // to the facilitator's /supported receiverAuthorizer.
    const serverConfig: ServerConfig = {
      port,
      networks,
      enabledFamilies,
      facilitatorUrl,
      mockFacilitatorUrl,
    };

    const serverStartFailures = (error: string) => {
      cLog.log(`❌ Failed to start server ${serverName}${error ? `: ${error}` : ''}`);
      return scenarios.map(scenario => ({
        testNumber: nextTestNumber(),
        client: scenario.client.name,
        server: scenario.server.name,
        endpoint: scenario.endpoint.path,
        facilitator: scenario.facilitator?.name || 'none',
        protocolFamily: scenario.protocolFamily,
        ...scenarioDimensions(scenario),
        passed: false,
        error: 'Server failed to start',
      }));
    };

    let started = false;
    try {
      started = await startServer(serverProxy, serverConfig, { transport: server.config.transport });
    } catch (error) {
      return serverStartFailures(error instanceof Error ? error.message : String(error));
    }
    if (!started) {
      return serverStartFailures('');
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
        const isAvm = scenario.protocolFamily === 'avm';
        const resourceKeys = getScenarioResourceKeys(scenario, evmResourceKeyContext);

        const runScenario = async (): Promise<DetailedTestResult> => {
          const setupFailure = (error: string): DetailedTestResult => ({
            testNumber: tn,
            client: scenario.client.name,
            server: scenario.server.name,
            endpoint: scenario.endpoint.path,
            facilitator: scenario.facilitator?.name || 'none',
            protocolFamily: scenario.protocolFamily,
            ...scenarioDimensions(scenario),
            passed: false,
            error,
          });

          if (clientRequiresSwigSetup(scenario.client)) {
            const swigReady = await setupSwigWallet(networks.svm.rpcUrl);
            if (!swigReady) {
              return setupFailure('Swig wallet setup failed');
            }
          }

          if (scenario.endpoint.schemeOptions?.permit2Direct === true) {
            const approved = await approvePermit2Approval(networks.evm, evmPermit2Asset);
            if (!approved) {
              return setupFailure('Permit2 approval setup failed');
            }
          } else if (scenario.endpoint.schemeOptions?.coldstart === true) {
            // Key on (client, path) so each client independently runs its own
            // fund → revoke → drain cycle. Without the client name, the second
            // client in a combo silently skips the coldstart and inherits
            // whatever wallet state the first client left behind.
            const endpointKey = `${scenario.client.name}::${scenario.endpoint.path}`;
            if (!coldStartedEndpoints.has(endpointKey)) {
              const funded = await fundClientForRevoke(networks.evm);
              if (!funded) {
                return setupFailure('Client gas funding setup failed');
              }
              // Give fund tx 1s to propagate before submitting revoke (from client wallet)
              await new Promise(resolve => setTimeout(resolve, 1000));
              const revoked = await revokePermit2Approval(networks.evm, evmPermit2Asset);
              if (!revoked) {
                return setupFailure('Permit2 revoke setup failed');
              }
              // Give revoke tx 2s to propagate before drain reads pending nonce.
              // Load-balanced RPCs can return a stale pending nonce if queried
              // immediately after the revoke submission, causing the drain to
              // collide with the revoke's nonce ("replacement transaction underpriced").
              await new Promise(resolve => setTimeout(resolve, 2000));
              const drained = await drainClientETH(networks.evm);
              if (!drained) {
                return setupFailure('Client ETH drain setup failed');
              }
              coldStartedEndpoints.add(endpointKey);
              // Wait for RPC nonce propagation across load-balanced nodes before the
              // test client (which may use a separate RPC connection) queries the nonce.
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
          }

          // Bounded retry for EVM Permit2 flows: transient 402s here are
          // almost always stale on-chain state (allowance/nonce not yet
          // propagated across load-balanced RPC nodes). Retry with a delay so
          // state can settle; eip3009 and non-EVM flows run once (maxAttempts=1).
          const isPermit2 = endpointAssetTransferMethod(scenario.endpoint) === 'permit2';
          const maxAttempts = isEvm && isPermit2 ? EVM_PAYMENT_MAX_ATTEMPTS : 1;
          let result = await runSingleTest(scenario, port, tn, cLog);
          for (
            let attempt = 1;
            attempt < maxAttempts && !result.passed && isTransientPaymentFailure(result.error);
            attempt++
          ) {
            cLog.log(
              `  🔁 Test #${tn} transient failure (attempt ${attempt}/${maxAttempts}): ${result.error}. ` +
              `Retrying in ${EVM_PAYMENT_RETRY_DELAY_MS}ms to let on-chain state settle...`
            );
            await new Promise(resolve => setTimeout(resolve, EVM_PAYMENT_RETRY_DELAY_MS));
            result = await runSingleTest(scenario, port, tn, cLog);
          }

          if (isEvm && resourceLock) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          } else if (isAvm) {
            // Pause between AVM tests to avoid 403 rate limiting on free public Algorand nodes
            await new Promise(resolve => setTimeout(resolve, 8000));
          } else if (isEvm) {
            // Brief pause between sequential EVM tests so the facilitator wallet's
            // settlement tx has time to propagate before the next cold-start setup
            // sends from the same account (fundClientForRevoke). Without this,
            // the two can collide on the same nonce on load-balanced RPCs.
            await new Promise(resolve => setTimeout(resolve, 1500));
          }

          return result;
        };

        if (resourceKeys.length > 0 && resourceLock) {
          const releaseLock = await resourceLock.acquireAll(resourceKeys);
          try {
            results.push(await runScenario());
          } finally {
            releaseLock();
          }
        } else {
          results.push(await runScenario());
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
  const resourceLock = parsedArgs.parallel ? new ResourceLock() : null;
  const clientEvmAddress = clientEvmPrivateKey
    ? privateKeyToAccount(clientEvmPrivateKey as `0x${string}`).address
    : undefined;
  const facilitatorEvmAddress = facilitatorEvmPrivateKey
    ? privateKeyToAccount(facilitatorEvmPrivateKey as `0x${string}`).address
    : undefined;
  const evmResourceKeyContext: EvmResourceKeyContext = {
    evmCaip2: networks.evm.caip2,
    evmPermit2Asset,
    clientEvmAddress,
    facilitatorEvmAddress,
  };
  const semaphore = new Semaphore(effectiveConcurrency);

  let globalTestNumber = 0;
  const nextTestNumber = () => ++globalTestNumber;

  const comboPromises = serverFacilitatorCombos.map(async (combo) => {
    const release = await semaphore.acquire();
    try {
      return await executeCombo(combo, resourceLock, evmResourceKeyContext, nextTestNumber);
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

  // Build a serverName→port map for legacy discovery validation fallback.
  const discoveryServerPorts = new Map<string, number>();
  for (const combo of serverFacilitatorCombos) {
    if (!discoveryServerPorts.has(combo.serverName)) {
      discoveryServerPorts.set(combo.serverName, combo.port);
    }
  }

  // Expected discovery entries must use the port from each facilitator+server combo.
  const testedDiscoveryScenarios: TestedDiscoveryScenario[] = [];
  for (const combo of serverFacilitatorCombos) {
    if (!combo.facilitatorName) {
      continue;
    }
    const server = uniqueServers.get(combo.serverName);
    if (!server) {
      continue;
    }
    for (const scenario of combo.scenarios) {
      testedDiscoveryScenarios.push({
        facilitatorName: combo.facilitatorName,
        server,
        serverPort: combo.port,
        endpoint: scenario.endpoint,
      });
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
      facilitatorServerMap,
      testedDiscoveryScenarios,
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
  await Promise.all([
    stopMockFacilitator(mockFacilitatorProcess, mockFacilitatorUrl),
    ...facilitatorStopPromises,
  ]);

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
  log(`⏱️  Duration: ${((Date.now() - startTime) / 60_000).toFixed(2)} min`);
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

  logBreakdown('Breakdown by Facilitator', buildBreakdown(testResults, 'facilitator'));
  logBreakdown('Breakdown by Server', buildBreakdown(testResults, 'server'), 20);
  logBreakdown('Breakdown by Client', buildBreakdown(testResults, 'client'), 20);
  logBreakdown('Breakdown by Scheme', buildBreakdown(testResults, 'scheme'));
  logBreakdown('Breakdown by Asset Transfer Method', buildBreakdown(testResults, 'assetTransferMethod'), 20);
  logBreakdown('Breakdown by Transport', buildBreakdown(testResults, 'transport'));
  logBreakdown('Breakdown by Version', buildBreakdown(testResults, 'version'));

  const paymentFlowBreakdown = buildBreakdown(testResults, 'paymentFlow');
  if (Object.keys(paymentFlowBreakdown).length > 1) {
    logBreakdown('Breakdown by Payment Flow', paymentFlowBreakdown);
  }

  const protocolBreakdown = buildBreakdown(testResults, 'protocolFamily');
  if (Object.keys(protocolBreakdown).length > 1) {
    logBreakdown('Protocol Family Breakdown', protocolBreakdown, 15, 'total');
  }

  // Write structured JSON output if requested
  if (parsedArgs.outputJson) {
    const jsonOutput = {
      summary: {
        total: passed + failed,
        passed,
        failed,
        networkMode,
        durationMinutes: Number(((Date.now() - startTime) / 60_000).toFixed(2)),
      },
      results: testResults,
      breakdowns: {
        byFacilitator: buildBreakdown(testResults, 'facilitator'),
        byServer: buildBreakdown(testResults, 'server'),
        byClient: buildBreakdown(testResults, 'client'),
        byScheme: buildBreakdown(testResults, 'scheme'),
        byAssetTransferMethod: buildBreakdown(testResults, 'assetTransferMethod'),
        byTransport: buildBreakdown(testResults, 'transport'),
        byVersion: buildBreakdown(testResults, 'version'),
        byPaymentFlow: buildBreakdown(testResults, 'paymentFlow'),
        byProtocolFamily: buildBreakdown(testResults, 'protocolFamily'),
      },
    };

    writeFileSync(parsedArgs.outputJson, JSON.stringify(jsonOutput, null, 2));
    log(`📄 JSON results written to ${parsedArgs.outputJson}`);
  }

  // Close logger
  await closeLogger();
  process.exit(failed > 0 || discoveryFailed ? 1 : 0);
}

// Run the test
runTest().catch(async error => {
  errorLog(String(error));
  await closeLogger();
  process.exit(1);
});
