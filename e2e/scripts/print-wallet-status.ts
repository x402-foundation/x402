/**
 * Print facilitator / client / server addresses and key balances for every
 * protocol family whose catalog-required env keys are set.
 *
 * Usage:
 *   pnpm wallet:status
 *   pnpm wallet:status --mainnet
 *
 * Loads e2e/.env (does not override existing exports). Never prints keys.
 */

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { Account, Ed25519PrivateKey, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { AccountAddress, CcdAmount } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import * as KeetaNet from "@keetanetwork/keetanet-client";
import { base58 } from "@scure/base";
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  type Address as SvmAddress,
} from "@solana/kit";
import { getDefaultAsset as getAptosDefaultAsset } from "@x402/aptos";
import { getDefaultAsset as getAvmDefaultAsset, toClientAvmSigner } from "@x402/avm";
import {
  getConcordiumGrpcUrl,
  parseGrpcUrl,
  CCD_DECIMALS,
} from "@x402/concordium";
import { getDefaultAsset as getEvmDefaultAsset } from "@x402/evm";
import {
  HBAR_ASSET_ID,
  HEDERA_MAINNET_MIRROR_NODE_URL,
  HEDERA_TESTNET_MIRROR_NODE_URL,
} from "@x402/hedera";
import { getDefaultAsset as getKeetaDefaultAsset, networkToKeetaNetwork } from "@x402/keeta";
import { getDefaultAsset as getNearDefaultAsset } from "@x402/near";
import {
  createEd25519Signer,
  DEFAULT_PUBNET_HORIZON_URL,
  DEFAULT_TESTNET_HORIZON_URL,
} from "@x402/stellar";
import { getDefaultAsset as getSvmDefaultAsset } from "@x402/svm";
import {
  createTvmProviderClient,
  getDefaultAsset as getTvmDefaultAsset,
  HighloadV3Config,
  toClientTvmSigner,
  toFacilitatorTvmSigner,
  TVM_PROVIDER_TONAPI,
  TVM_PROVIDER_TONCENTER,
} from "@x402/tvm";
import { config } from "dotenv";
import { createPublicClient, formatEther, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { Client, Wallet } from "xrpl";
import {
  PROTOCOL_FAMILIES,
  getNetworkForProtocol,
  requiredEnvForFamily,
  serverAddressKey,
  type NetworkMode,
  type ProtocolFamily,
} from "../src/networks/networks";

const e2eDir = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(e2eDir, ".env") });

const FETCH_TIMEOUT_MS = 15_000;
const ERC20_BALANCE_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

type Balance = {
  symbol: string;
  formatted: string;
};

type RoleRow = {
  role: "facilitator" | "client" | "server";
  address: string;
  balance?: Balance;
};

type FamilyReport = {
  family: string;
  networkName: string;
  caip2: string;
  error?: string;
  rows: RoleRow[];
};

function env(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function requireEnv(key: string): string {
  const value = env(key);
  if (!value) {
    throw new Error(`${key} is not set`);
  }
  return value;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message.split("\n")[0]?.trim() || err.message;
  }
  return String(err);
}

function formatAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  if (frac === 0n) {
    return `${negative ? "-" : ""}${whole}`;
  }
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${fracStr}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} (${url})`);
  }
  return response.json();
}

async function rpcJson(url: string, method: string, params: unknown[]): Promise<unknown> {
  const body = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!body || typeof body !== "object") {
    throw new Error(`${method} returned a non-object`);
  }
  const payload = body as { error?: { message?: string }; result?: unknown };
  if (payload.error) {
    throw new Error(payload.error.message ?? `${method} RPC error`);
  }
  return payload.result;
}

/** NEAR JSON-RPC expects `params` as a single object, not an array. */
async function nearRpcJson(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const body = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!body || typeof body !== "object") {
    throw new Error(`${method} returned a non-object`);
  }
  const payload = body as { error?: { message?: string }; result?: unknown };
  if (payload.error) {
    throw new Error(payload.error.message ?? `${method} RPC error`);
  }
  return payload.result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTvmKeyPair(privateKey: string): { publicKey: Buffer; secretKey: Buffer } {
  const value = privateKey.trim().replace(/^0x/, "");
  let bytes: Buffer;
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    bytes = Buffer.from(value, "hex");
  } else {
    bytes = Buffer.from(value, "base64");
  }
  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error("TVM private key must be a 32-byte seed or 64-byte secret key");
  }
  const seed = bytes.subarray(0, 32);
  if (bytes.length === 64) {
    return { publicKey: bytes.subarray(32), secretKey: bytes };
  }
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const keyObject = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(keyObject).export({ type: "spki", format: "der" }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32);
  return { publicKey, secretKey: Buffer.concat([seed, publicKey]) };
}

async function withBalance(
  symbol: string,
  query: () => Promise<string>,
): Promise<Balance> {
  try {
    return { symbol, formatted: await query() };
  } catch (err) {
    return { symbol, formatted: `error: ${errorMessage(err)}` };
  }
}

function aptosAccountAddress(privateKey: string): string {
  const formattedKey = PrivateKey.formatPrivateKey(privateKey, PrivateKeyVariants.Ed25519);
  const account = Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(formattedKey),
  });
  return account.accountAddress.toStringLong();
}

async function aptosBalance(rpcUrl: string, address: string, asset: string): Promise<string> {
  const result = await fetchJson(
    `${rpcUrl.replace(/\/$/, "")}/accounts/${address}/balance/${encodeURIComponent(asset)}`,
  );
  if (typeof result === "string" || typeof result === "number") {
    return String(result);
  }
  if (isRecord(result) && result.data !== undefined) {
    return String(result.data);
  }
  throw new Error("unexpected Aptos balance response");
}

async function reportEvm(mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, "evm");
  const chain = net.caip2 === "eip155:8453" ? base : baseSepolia;
  const facilitator = privateKeyToAccount(requireEnv("FACILITATOR_EVM_PRIVATE_KEY") as `0x${string}`);
  const client = privateKeyToAccount(requireEnv("CLIENT_EVM_PRIVATE_KEY") as `0x${string}`);
  const server = requireEnv(serverAddressKey("evm"));
  const publicClient = createPublicClient({
    chain,
    transport: http(net.rpcUrl || undefined),
  });
  const usdc = getEvmDefaultAsset(net.caip2);
  const native = await withBalance("ETH", async () =>
    formatEther(await publicClient.getBalance({ address: facilitator.address })),
  );
  const payment = await withBalance(usdc.symbol, async () => {
    const raw = await publicClient.readContract({
      address: usdc.asset as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [client.address],
    });
    return formatUnits(raw, usdc.decimals);
  });
  return {
    family: "evm",
    networkName: net.name,
    caip2: net.caip2,
    rows: [
      { role: "facilitator", address: facilitator.address, balance: native },
      { role: "client", address: client.address, balance: payment },
      { role: "server", address: server },
    ],
  };
}

async function reportSvm(mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, "svm");
  const facilitator = await createKeyPairSignerFromBytes(
    base58.decode(requireEnv("FACILITATOR_SVM_PRIVATE_KEY")),
  );
  const client = await createKeyPairSignerFromBytes(
    base58.decode(requireEnv("CLIENT_SVM_PRIVATE_KEY")),
  );
  const server = requireEnv(serverAddressKey("svm"));
  const rpc = createSolanaRpc(net.rpcUrl);
  const usdc = getSvmDefaultAsset(net.caip2);
  const native = await withBalance("SOL", async () => {
    const { value } = await rpc.getBalance(facilitator.address as SvmAddress).send();
    return formatAmount(value, 9);
  });
  const payment = await withBalance(usdc.symbol, async () => {
    const result = await rpcJson(net.rpcUrl, "getTokenAccountsByOwner", [
      client.address,
      { mint: usdc.asset },
      { encoding: "jsonParsed" },
    ]);
    if (!isRecord(result) || !Array.isArray(result.value) || result.value.length === 0) {
      return "0";
    }
    const first = result.value[0];
    if (!isRecord(first) || !isRecord(first.account) || !isRecord(first.account.data)) {
      throw new Error("unexpected token-account encoding");
    }
    const parsed = first.account.data.parsed;
    if (!isRecord(parsed) || !isRecord(parsed.info) || !isRecord(parsed.info.tokenAmount)) {
      throw new Error("unexpected token-account parsed info");
    }
    const tokenAmount = parsed.info.tokenAmount;
    if (typeof tokenAmount.uiAmountString === "string") {
      return tokenAmount.uiAmountString;
    }
    if (typeof tokenAmount.amount === "string") {
      return formatAmount(BigInt(tokenAmount.amount), Number(tokenAmount.decimals ?? usdc.decimals));
    }
    throw new Error("missing token amount");
  });
  return {
    family: "svm",
    networkName: net.name,
    caip2: net.caip2,
    rows: [
      { role: "facilitator", address: facilitator.address, balance: native },
      { role: "client", address: client.address, balance: payment },
      { role: "server", address: server },
    ],
  };
}

async function reportAvm(mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, "avm");
  const facilitator = toClientAvmSigner(requireEnv("FACILITATOR_AVM_PRIVATE_KEY"));
  const client = toClientAvmSigner(requireEnv("CLIENT_AVM_PRIVATE_KEY"));
  const server = requireEnv(serverAddressKey("avm"));
  const usdc = getAvmDefaultAsset(net.caip2);
  const accountUrl = `${net.rpcUrl.replace(/\/$/, "")}/v2/accounts`;
  const native = await withBalance("ALGO", async () => {
    const body = await fetchJson(`${accountUrl}/${facilitator.address}`);
    if (!isRecord(body) || typeof body.amount !== "number") {
      throw new Error("unexpected Algorand account response");
    }
    return formatAmount(BigInt(body.amount), 6);
  });
  const payment = await withBalance(usdc.symbol, async () => {
    const body = await fetchJson(`${accountUrl}/${client.address}`);
    if (!isRecord(body)) {
      throw new Error("unexpected Algorand account response");
    }
    const assets = Array.isArray(body.assets) ? body.assets : [];
    const asaId = Number(usdc.asset);
    for (const asset of assets) {
      if (!isRecord(asset)) continue;
      if (Number(asset["asset-id"]) === asaId) {
        return formatAmount(BigInt(Number(asset.amount)), usdc.decimals);
      }
    }
    return "0";
  });
  return {
    family: "avm",
    networkName: net.name,
    caip2: net.caip2,
    rows: [
      { role: "facilitator", address: facilitator.address, balance: native },
      { role: "client", address: client.address, balance: payment },
      { role: "server", address: server },
    ],
  };
}

async function reportAptos(mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, "aptos");
  const facilitator = aptosAccountAddress(requireEnv("FACILITATOR_APTOS_PRIVATE_KEY"));
  const client = aptosAccountAddress(requireEnv("CLIENT_APTOS_PRIVATE_KEY"));
  const server = requireEnv(serverAddressKey("aptos"));
  const usdc = getAptosDefaultAsset(net.caip2);
  const native = await withBalance("APT", async () => {
    const raw = await aptosBalance(net.rpcUrl, facilitator, "0x1::aptos_coin::AptosCoin");
    return formatAmount(BigInt(raw), 8);
  });
  const payment = await withBalance(usdc.symbol, async () => {
    const raw = await aptosBalance(net.rpcUrl, client, usdc.asset);
    return formatAmount(BigInt(raw), usdc.decimals);
  });
  return {
    family: "aptos",
    networkName: net.name,
    caip2: net.caip2,
    rows: [
      { role: "facilitator", address: facilitator, balance: native },
      { role: "client", address: client, balance: payment },
      { role: "server", address: server },
    ],
  };
}

async function reportCcd(mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, "ccd");
  const facilitator = requireEnv("FACILITATOR_CCD_ADDRESS");
  const client = requireEnv("CLIENT_CCD_ADDRESS");
  const server = requireEnv(serverAddressKey("ccd"));
  const grpcUrl = net.rpcUrl || getConcordiumGrpcUrl(net.caip2);
  const [host, port] = parseGrpcUrl(grpcUrl);
  const grpc = new ConcordiumGRPCNodeClient(host, port, credentials.createSsl());
  const ccdBalance = async (address: string): Promise<string> => {
    const info = await grpc.getAccountInfo(AccountAddress.fromBase58(address));
    const micro = CcdAmount.toMicroCcd(info.accountAmount);
    return formatAmount(BigInt(String(micro)), CCD_DECIMALS);
  };
  const native = await withBalance("CCD", () => ccdBalance(facilitator));
  const payment = await withBalance("CCD", () => ccdBalance(client));
  return {
    family: "ccd",
    networkName: net.name,
    caip2: net.caip2,
    rows: [
      { role: "facilitator", address: facilitator, balance: native },
      { role: "client", address: client, balance: payment },
      { role: "server", address: server },
    ],
  };
}

async function reportHedera(mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, "hedera");
  const facilitator = requireEnv("FACILITATOR_HEDERA_ACCOUNT_ID");
  const client = requireEnv("CLIENT_HEDERA_ACCOUNT_ID");
  const server = requireEnv(serverAddressKey("hedera"));
  const mirror =
    mode === "mainnet" ? HEDERA_MAINNET_MIRROR_NODE_URL : HEDERA_TESTNET_MIRROR_NODE_URL;
  const paymentAsset = env("HEDERA_ASSET") ?? HBAR_ASSET_ID;
  const accountBalance = async (accountId: string): Promise<Record<string, unknown>> => {
    const body = await fetchJson(`${mirror}/api/v1/accounts/${accountId}`);
    if (!isRecord(body) || !isRecord(body.balance)) {
      throw new Error("unexpected Hedera mirror account response");
    }
    return body.balance;
  };
  const native = await withBalance("HBAR", async () => {
    const balance = await accountBalance(facilitator);
    return formatAmount(BigInt(String(balance.balance ?? 0)), 8);
  });
  const paymentSymbol = paymentAsset === HBAR_ASSET_ID ? "HBAR" : paymentAsset;
  const payment = await withBalance(paymentSymbol, async () => {
    const balance = await accountBalance(client);
    if (paymentAsset === HBAR_ASSET_ID) {
      return formatAmount(BigInt(String(balance.balance ?? 0)), 8);
    }
    const tokens = Array.isArray(balance.tokens) ? balance.tokens : [];
    for (const token of tokens) {
      if (isRecord(token) && token.token_id === paymentAsset) {
        return String(token.balance ?? 0);
      }
    }
    return "0";
  });
  return {
    family: "hedera",
    networkName: net.name,
    caip2: net.caip2,
    rows: [
      { role: "facilitator", address: facilitator, balance: native },
      { role: "client", address: client, balance: payment },
      { role: "server", address: server },
    ],
  };
}

async function keetaAccountFromMnemonic(mnemonic: string): Promise<string> {
  const seed = await KeetaNet.lib.Account.seedFromPassphrase(mnemonic);
  const account = KeetaNet.lib.Account.fromSeed(seed, 0);
  return account.publicKeyString.toString();
}

async function reportKeeta(mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, "keeta");
  const facilitator = await keetaAccountFromMnemonic(requireEnv("FACILITATOR_KEETA_MNEMONIC"));
  const client = await keetaAccountFromMnemonic(requireEnv("CLIENT_KEETA_MNEMONIC"));
  const server = requireEnv(serverAddressKey("keeta"));
  const keetaNetwork = networkToKeetaNetwork(net.caip2);
  const usdc = getKeetaDefaultAsset(net.caip2);
  const userClient = KeetaNet.UserClient.fromNetwork(keetaNetwork, null);
  try {
    const native = await withBalance("KTA", async () => {
      const raw = await userClient.client.getBalance(facilitator, userClient.baseToken);
      return formatAmount(BigInt(String(raw)), 9);
    });
    const payment = await withBalance(usdc.symbol, async () => {
      const token = KeetaNet.lib.Account.fromPublicKeyString(usdc.asset);
      const raw = await userClient.client.getBalance(client, token);
      return formatAmount(BigInt(String(raw)), usdc.decimals);
    });
    return {
      family: "keeta",
      networkName: net.name,
      caip2: net.caip2,
      rows: [
        { role: "facilitator", address: facilitator, balance: native },
        { role: "client", address: client, balance: payment },
        { role: "server", address: server },
      ],
    };
  } finally {
    await userClient.destroy();
  }
}

function stellarHorizonUrl(mode: NetworkMode): string {
  return mode === "mainnet" ? DEFAULT_PUBNET_HORIZON_URL : DEFAULT_TESTNET_HORIZON_URL;
}

async function reportStellar(mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, "stellar");
  const facilitator = createEd25519Signer(requireEnv("FACILITATOR_STELLAR_PRIVATE_KEY"), net.caip2);
  const client = createEd25519Signer(requireEnv("CLIENT_STELLAR_PRIVATE_KEY"), net.caip2);
  const server = requireEnv(serverAddressKey("stellar"));
  const horizon = stellarHorizonUrl(mode);
  const accountBalances = async (address: string): Promise<unknown[]> => {
    const body = await fetchJson(`${horizon}/accounts/${address}`);
    if (!isRecord(body) || !Array.isArray(body.balances)) {
      throw new Error("unexpected Horizon account response");
    }
    return body.balances;
  };
  const native = await withBalance("XLM", async () => {
    const balances = await accountBalances(facilitator.address);
    for (const entry of balances) {
      if (isRecord(entry) && entry.asset_type === "native") {
        return String(entry.balance ?? "0");
      }
    }
    return "0";
  });
  const payment = await withBalance("USDC", async () => {
    const balances = await accountBalances(client.address);
    for (const entry of balances) {
      if (isRecord(entry) && entry.asset_code === "USDC") {
        return String(entry.balance ?? "0");
      }
    }
    return "0";
  });
  return {
    family: "stellar",
    networkName: net.name,
    caip2: net.caip2,
    rows: [
      { role: "facilitator", address: facilitator.address, balance: native },
      { role: "client", address: client.address, balance: payment },
      { role: "server", address: server },
    ],
  };
}

async function reportTvm(mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, "tvm");
  const provider = (env("TVM_PROVIDER") || TVM_PROVIDER_TONCENTER).toLowerCase();
  const apiKey =
    provider === TVM_PROVIDER_TONAPI ? env("TVM_TONAPI_API_KEY") : env("TVM_TONCENTER_API_KEY");
  const providerOpts = {
    provider,
    apiKey,
    providerBaseUrl: net.rpcUrl || undefined,
  };
  const facilitatorConfig = HighloadV3Config.fromPrivateKey(
    requireEnv("FACILITATOR_TVM_PRIVATE_KEY"),
    providerOpts,
  );
  const facilitatorSigner = toFacilitatorTvmSigner({ [net.caip2]: facilitatorConfig });
  const facilitator = facilitatorSigner.getAddressesForNetwork(net.caip2)[0];
  const clientSigner = toClientTvmSigner(
    parseTvmKeyPair(requireEnv("CLIENT_TVM_PRIVATE_KEY")) as Parameters<
      typeof toClientTvmSigner
    >[0],
    {
      network: net.caip2,
      ...providerOpts,
    },
  );
  const client = clientSigner.address;
  const server = requireEnv(serverAddressKey("tvm"));
  const usdt = getTvmDefaultAsset(net.caip2);
  const tvmClient = createTvmProviderClient(net.caip2, {
    provider,
    apiKey,
    baseUrl: net.rpcUrl || undefined,
  });
  try {
    const native = await withBalance("TON", async () => {
      const state = await tvmClient.getAccountState(facilitator);
      return formatAmount(state.balance, 9);
    });
    const payment = await withBalance(usdt.symbol, async () => {
      const wallet = await tvmClient.getJettonWallet(usdt.asset, client);
      const data = await tvmClient.getJettonWalletData(wallet);
      return formatAmount(data.balance, usdt.decimals);
    });
    return {
      family: "tvm",
      networkName: net.name,
      caip2: net.caip2,
      rows: [
        { role: "facilitator", address: facilitator, balance: native },
        { role: "client", address: client, balance: payment },
        { role: "server", address: server },
      ],
    };
  } finally {
    tvmClient.close();
    facilitatorSigner.close();
  }
}

async function reportNear(mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, "near");
  const facilitator = requireEnv("FACILITATOR_NEAR_ACCOUNT_ID");
  const client = requireEnv("CLIENT_NEAR_ACCOUNT_ID");
  const server = requireEnv(serverAddressKey("near"));
  const paymentAsset = env("SERVER_NEAR_ASSET") ?? "wrap.testnet";
  const native = await withBalance("NEAR", async () => {
    const result = await nearRpcJson(net.rpcUrl, "query", {
      request_type: "view_account",
      finality: "final",
      account_id: facilitator,
    });
    if (!isRecord(result) || typeof result.amount !== "string") {
      throw new Error("unexpected NEAR view_account response");
    }
    return formatAmount(BigInt(result.amount), 24);
  });
  const paymentIsWnear = paymentAsset === "wrap.testnet" || paymentAsset === "wrap.near";
  const paymentMeta = paymentIsWnear
    ? { symbol: "wNEAR", decimals: 24 }
    : getNearDefaultAsset(net.caip2);
  const payment = await withBalance(paymentIsWnear ? "wNEAR" : paymentMeta.symbol, async () => {
    const result = await nearRpcJson(net.rpcUrl, "query", {
      request_type: "call_function",
      finality: "final",
      account_id: paymentAsset,
      method_name: "ft_balance_of",
      args_base64: Buffer.from(JSON.stringify({ account_id: client })).toString("base64"),
    });
    if (!isRecord(result) || !Array.isArray(result.result)) {
      throw new Error("unexpected NEAR ft_balance_of response");
    }
    const decoded = Buffer.from(result.result as number[]).toString("utf8");
    const raw = JSON.parse(decoded) as string;
    const decimals = paymentIsWnear ? 24 : paymentMeta.decimals;
    return formatAmount(BigInt(raw), decimals);
  });
  return {
    family: "near",
    networkName: net.name,
    caip2: net.caip2,
    rows: [
      { role: "facilitator", address: facilitator, balance: native },
      { role: "client", address: client, balance: payment },
      { role: "server", address: server },
    ],
  };
}

async function reportXrpl(mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, "xrpl");
  const wallet = Wallet.fromSeed(requireEnv("CLIENT_XRPL_SEED"));
  const client = wallet.classicAddress;
  const server = requireEnv(serverAddressKey("xrpl"));
  const asset = env("SERVER_XRPL_ASSET") ?? "XRP";
  const issuer = env("SERVER_XRPL_ISSUER");
  const xrpl = new Client(net.rpcUrl);
  await xrpl.connect();
  try {
    const payment = await withBalance(asset, async () => {
      if (asset === "XRP") {
        return await xrpl.getXrpBalance(client);
      }
      const lines = await xrpl.request({
        command: "account_lines",
        account: client,
      });
      for (const line of lines.result.lines) {
        const issuerMatch = !issuer || line.account === issuer;
        if (line.currency === asset && issuerMatch) {
          return line.balance;
        }
      }
      return "0";
    });
    return {
      family: "xrpl",
      networkName: net.name,
      caip2: net.caip2,
      rows: [
        { role: "facilitator", address: "(keyless)" },
        { role: "client", address: client, balance: payment },
        { role: "server", address: server },
      ],
    };
  } finally {
    await xrpl.disconnect();
  }
}

const HANDLERS: Record<string, (mode: NetworkMode) => Promise<FamilyReport>> = {
  evm: reportEvm,
  svm: reportSvm,
  avm: reportAvm,
  aptos: reportAptos,
  ccd: reportCcd,
  hedera: reportHedera,
  keeta: reportKeeta,
  stellar: reportStellar,
  tvm: reportTvm,
  near: reportNear,
  xrpl: reportXrpl,
};

async function reportFamily(family: ProtocolFamily, mode: NetworkMode): Promise<FamilyReport> {
  const net = getNetworkForProtocol(mode, family);
  const handler = HANDLERS[family];
  if (!handler) {
    return {
      family,
      networkName: net.name,
      caip2: net.caip2,
      error: "no wallet-status handler for this family",
      rows: [],
    };
  }
  try {
    return await handler(mode);
  } catch (err) {
    return {
      family,
      networkName: net.name,
      caip2: net.caip2,
      error: errorMessage(err),
      rows: [],
    };
  }
}

function formatText(mode: NetworkMode, reports: FamilyReport[]): string {
  const lines = [`e2e wallet status (${mode})`, ""];
  for (const report of reports) {
    lines.push(`${report.family}  ${report.networkName}  ${report.caip2}`);
    if (report.error) {
      lines.push(`  error  ${report.error}`);
      lines.push("");
      continue;
    }
    for (const row of report.rows) {
      const role = row.role.padEnd(12);
      if (row.balance) {
        lines.push(
          `  ${role}  ${row.address}   ${row.balance.symbol}  ${row.balance.formatted}`,
        );
      } else {
        lines.push(`  ${role}  ${row.address}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function formatMarkdown(mode: NetworkMode, reports: FamilyReport[]): string {
  const lines = [`## e2e wallet status (${mode})`, ""];
  for (const report of reports) {
    lines.push(`### ${report.family} — ${report.networkName} (\`${report.caip2}\`)`);
    if (report.error) {
      lines.push("", `error: ${report.error}`, "");
      continue;
    }
    lines.push("", "| Role | Address | Balance |", "| --- | --- | --- |");
    for (const row of report.rows) {
      const balance = row.balance ? `${row.balance.symbol} ${row.balance.formatted}` : "";
      lines.push(`| ${row.role} | \`${row.address}\` | ${balance} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function configuredFamilies(): ProtocolFamily[] {
  return PROTOCOL_FAMILIES.filter(family => {
    const keys = requiredEnvForFamily(family);
    if (keys.length === 0) {
      return false;
    }
    return keys.every(key => Boolean(env(key)));
  });
}

async function main(): Promise<void> {
  const mode: NetworkMode = process.argv.includes("--mainnet") ? "mainnet" : "testnet";
  const families = configuredFamilies();
  if (families.length === 0) {
    console.error("No protocol families have all required wallet secrets configured.");
    console.error("Set variables in e2e/.env or export them in your shell.");
    process.exit(1);
  }

  const reports = await Promise.all(families.map(family => reportFamily(family, mode)));
  console.log(formatText(mode, reports));

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${formatMarkdown(mode, reports)}\n`);
  }
}

main().catch(err => {
  console.error(errorMessage(err));
  process.exit(1);
});

