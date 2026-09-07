import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  UptoEvmScheme as UptoEvmClientScheme,
  type UptoEvmSchemeOptions,
} from "@x402/evm/upto/client";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { toClientEvmSigner } from "@x402/evm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { ExactSvmSchemeV1 } from "@x402/svm/v1";
import { ExactAptosScheme } from "@x402/aptos/exact/client";
import { Account, Ed25519PrivateKey, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { createClientHederaSigner, PrivateKey as HederaPrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { ExactKeetaScheme } from "@x402/keeta/exact/client";
import { toClientKeetaSigner, type ClientKeetaSigner } from "@x402/keeta";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer, type Ed25519Signer } from "@x402/stellar";
import { ExactTvmScheme } from "@x402/tvm/exact/client";
import { toClientTvmSigner, TVM_PROVIDER_TONAPI, TVM_PROVIDER_TONCENTER } from "@x402/tvm";
import { createClientNearSigner, type ClientNearSignerConfig } from "@x402/near";
import { ExactNearScheme as ExactNearClientScheme } from "@x402/near/exact/client";
import { createXrplWalletSigner } from "@x402/xrpl";
import { ExactXrplScheme as ExactXrplClientScheme } from "@x402/xrpl/exact/client";
import { Wallet } from "xrpl";
import { ExactAvmScheme as ExactAvmClientScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { toClientCantonSigner } from "@x402/canton";
import { ExactCantonScheme as ExactCantonClientScheme } from "@x402/canton/exact/client";
import { AccountAddress, buildBasicAccountSigner } from "@concordium/web-sdk";
import * as KeetaNet from "@keetanetwork/keetanet-client";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { keyPairFromSeed, type KeyPair } from "@ton/crypto";
import { x402Client, type SchemeRegistration } from "@x402/core/client";
import type { SettleResponse } from "@x402/core/types";
import { networkCaip2Pattern, resolveNetworkCaip2 } from "./catalog-network.ts";

export type RequestResult = {
  success: boolean;
  data: unknown;
  status_code: number;
  payment_response?: unknown;
};

export type BatchSettlementPhase = "initial" | "recovery-refund" | "full";

/**
 * Parses the TVM private key accepted by e2e env fixtures.
 */
function parseTvmKeyPair(privateKey: string): KeyPair {
  const value = privateKey.trim().replace(/^0x/, "");
  let bytes: Buffer;
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    bytes = Buffer.from(value, "hex");
  } else {
    bytes = Buffer.from(value, "base64");
  }
  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error("CLIENT_TVM_PRIVATE_KEY must be a 32-byte seed or 64-byte secret key");
  }
  return keyPairFromSeed(bytes.subarray(0, 32));
}

export type E2EClientContext = {
  url: string;
  client: x402Client;
  /**
   * The same scheme registrations backing `client`, exposed separately so
   * transports that build their own `x402Client` internally (e.g. MCP's
   * `createx402MCPClient`, which must construct its MCP `Client` against its
   * own resolved `@modelcontextprotocol/sdk` version) can still share this
   * setup instead of duplicating it.
   */
  schemes: SchemeRegistration[];
  batchSettlementScheme: BatchSettlementEvmScheme | undefined;
  batchSettlementPhase: BatchSettlementPhase | undefined;
};

/**
 * Builds the shared x402 client with all e2e scheme registrations.
 */
export async function createE2EClient(): Promise<E2EClientContext> {
  const baseURL = process.env.RESOURCE_SERVER_URL as string;
  const endpointPath = process.env.ENDPOINT_PATH as string;
  const url = `${baseURL}${endpointPath}`;

  const schemes: SchemeRegistration[] = [];
  let batchSettlementScheme: BatchSettlementEvmScheme | undefined;

  if (process.env.CLIENT_EVM_PRIVATE_KEY) {
    const evmAccount = privateKeyToAccount(process.env.CLIENT_EVM_PRIVATE_KEY as `0x${string}`);

    const evmNetwork = resolveNetworkCaip2("evm");
    const evmRpcUrl = process.env.EVM_RPC_URL;
    const evmChain = evmNetwork === "eip155:8453" ? base : baseSepolia;

    const publicClient = createPublicClient({
      chain: evmChain,
      transport: http(evmRpcUrl),
    });

    const evmSigner = toClientEvmSigner(evmAccount, publicClient);

    const evmSchemeOptions = evmRpcUrl ? { rpcUrl: evmRpcUrl } : undefined;

    const uptoSchemeOptions: UptoEvmSchemeOptions | undefined = evmRpcUrl
      ? { rpcUrl: evmRpcUrl }
      : undefined;

    // Batch-settlement scheme uses a per-scenario salt (EVM_BATCH_SETTLEMENT_CHANNEL) so
    // concurrent e2e runs don't collide on the same on-chain channel id. An optional
    // voucher signer (CLIENT_EVM_BATCH_SETTLEMENT_VOUCHER_SIGNER_PRIVATE_KEY) exercises
    // the alt-EOA voucher branch while deposits keep using the main client signer.
    const channelSalt = process.env.EVM_BATCH_SETTLEMENT_CHANNEL as `0x${string}` | undefined;
    const voucherSignerKey = process.env.CLIENT_EVM_BATCH_SETTLEMENT_VOUCHER_SIGNER_PRIVATE_KEY as
      | `0x${string}`
      | undefined;
    const voucherSigner = voucherSignerKey
      ? toClientEvmSigner(privateKeyToAccount(voucherSignerKey), publicClient)
      : undefined;
    const batchSettlementOptions =
      channelSalt || voucherSigner
        ? { ...(channelSalt ? { salt: channelSalt } : {}), ...(voucherSigner ? { voucherSigner } : {}) }
        : undefined;
    batchSettlementScheme = new BatchSettlementEvmScheme(evmSigner, batchSettlementOptions);

    schemes.push(
      { network: networkCaip2Pattern("evm"), client: new ExactEvmScheme(evmSigner, evmSchemeOptions) },
      {
        network: networkCaip2Pattern("evm"),
        client: new UptoEvmClientScheme(evmSigner, uptoSchemeOptions),
      },
      { network: networkCaip2Pattern("evm"), client: batchSettlementScheme },
      { network: "base-sepolia", client: new ExactEvmSchemeV1(evmSigner), x402Version: 1 },
      { network: "base", client: new ExactEvmSchemeV1(evmSigner), x402Version: 1 },
    );
  }

  if (process.env.CLIENT_SVM_PRIVATE_KEY) {
    const svmSigner = await createKeyPairSignerFromBytes(
      base58.decode(process.env.CLIENT_SVM_PRIVATE_KEY),
    );
    const svmSchemeOptions = process.env.SVM_RPC_URL ? { rpcUrl: process.env.SVM_RPC_URL } : undefined;

    schemes.push(
      {
        network: networkCaip2Pattern("svm"),
        client: new ExactSvmScheme(svmSigner, svmSchemeOptions),
      },
      {
        network: networkCaip2Pattern("svm"),
        client: new UptoSvmScheme(svmSigner, svmSchemeOptions),
      },
      {
        network: "solana-devnet",
        client: new ExactSvmSchemeV1(svmSigner, svmSchemeOptions),
        x402Version: 1,
      },
      { network: "solana", client: new ExactSvmSchemeV1(svmSigner, svmSchemeOptions), x402Version: 1 },
    );
  }

  const ccdPrivateKey = process.env.CLIENT_CCD_PRIVATE_KEY;
  const ccdAddress = process.env.CLIENT_CCD_ADDRESS;

  let aptosAccount: Account | undefined;
  if (process.env.CLIENT_APTOS_PRIVATE_KEY) {
    const formattedKey = PrivateKey.formatPrivateKey(
      process.env.CLIENT_APTOS_PRIVATE_KEY,
      PrivateKeyVariants.Ed25519,
    );
    const aptosPrivateKey = new Ed25519PrivateKey(formattedKey);
    aptosAccount = Account.fromPrivateKey({ privateKey: aptosPrivateKey });
  }

  let hederaClientSigner: ReturnType<typeof createClientHederaSigner> | undefined;
  if (process.env.CLIENT_HEDERA_ACCOUNT_ID && process.env.CLIENT_HEDERA_PRIVATE_KEY) {
    hederaClientSigner = createClientHederaSigner(
      process.env.CLIENT_HEDERA_ACCOUNT_ID,
      HederaPrivateKey.fromStringECDSA(process.env.CLIENT_HEDERA_PRIVATE_KEY),
      {
        network: resolveNetworkCaip2("hedera"),
        nodeUrl: process.env.HEDERA_RPC_URL || undefined,
      },
    );
  }

  let keetaSigner: ClientKeetaSigner | undefined;
  if (process.env.CLIENT_KEETA_MNEMONIC) {
    const keetaAccount = KeetaNet.lib.Account.fromSeed(
      await KeetaNet.lib.Account.seedFromPassphrase(process.env.CLIENT_KEETA_MNEMONIC),
      0,
    );
    keetaSigner = toClientKeetaSigner(keetaAccount);
  }

  let stellarSigner: Ed25519Signer | undefined;
  if (process.env.CLIENT_STELLAR_PRIVATE_KEY) {
    stellarSigner = createEd25519Signer(process.env.CLIENT_STELLAR_PRIVATE_KEY);
  }

  let avmSigner: ReturnType<typeof toClientAvmSigner> | undefined;
  if (process.env.CLIENT_AVM_PRIVATE_KEY) {
    avmSigner = toClientAvmSigner(process.env.CLIENT_AVM_PRIVATE_KEY);
  }

  const tvmNetwork = resolveNetworkCaip2("tvm");
  const tvmPrivateKey = process.env.CLIENT_TVM_PRIVATE_KEY;
  const tvmProvider = (process.env.TVM_PROVIDER || TVM_PROVIDER_TONCENTER).toLowerCase();
  const tvmScheme = tvmPrivateKey
    ? new ExactTvmScheme(
        toClientTvmSigner(parseTvmKeyPair(tvmPrivateKey), {
          network: tvmNetwork,
          provider: tvmProvider,
          apiKey:
            tvmProvider === TVM_PROVIDER_TONAPI
              ? process.env.TVM_TONAPI_API_KEY
              : process.env.TVM_TONCENTER_API_KEY,
          providerBaseUrl: process.env.TVM_RPC_URL,
        }),
      )
    : undefined;

  if (ccdPrivateKey && ccdAddress) {
    schemes.push({
      network: networkCaip2Pattern("ccd"),
      client: new ExactConcordiumScheme(
        {
          accountAddress: AccountAddress.fromBase58(ccdAddress),
          signer: buildBasicAccountSigner(ccdPrivateKey),
        },
        process.env.CCD_RPC_URL ? { grpcUrl: process.env.CCD_RPC_URL } : undefined,
      ),
    });
  }
  if (aptosAccount) {
    schemes.push({
      network: networkCaip2Pattern("aptos"),
      client: new ExactAptosScheme(aptosAccount),
    });
  }
  if (hederaClientSigner) {
    schemes.push({
      network: networkCaip2Pattern("hedera"),
      client: new ExactHederaScheme(hederaClientSigner),
    });
  }
  if (keetaSigner) {
    schemes.push({
      network: networkCaip2Pattern("keeta"),
      client: new ExactKeetaScheme(keetaSigner),
    });
  }
  if (stellarSigner) {
    schemes.push({
      network: networkCaip2Pattern("stellar"),
      client: new ExactStellarScheme(stellarSigner),
    });
  }
  if (avmSigner) {
    schemes.push({
      network: networkCaip2Pattern("avm"),
      client: new ExactAvmClientScheme(avmSigner),
    });
  }
  if (tvmScheme) {
    schemes.push({ network: networkCaip2Pattern("tvm"), client: tvmScheme });
  }
  if (process.env.CLIENT_NEAR_ACCOUNT_ID && process.env.CLIENT_NEAR_PRIVATE_KEY) {
    const nearNetwork = resolveNetworkCaip2("near") as `${string}:${string}`;
    const nearSigner = createClientNearSigner({
      accountId: process.env.CLIENT_NEAR_ACCOUNT_ID,
      secretKey: process.env.CLIENT_NEAR_PRIVATE_KEY as ClientNearSignerConfig["secretKey"],
      rpcUrls: process.env.NEAR_RPC_URL ? { [nearNetwork]: process.env.NEAR_RPC_URL } : undefined,
    });
    schemes.push({
      network: networkCaip2Pattern("near"),
      client: new ExactNearClientScheme(nearSigner),
    });
  }
  if (
    process.env.CLIENT_CANTON_PARTY &&
    process.env.CLIENT_CANTON_PRIVATE_KEY &&
    process.env.CANTON_PARTICIPANT_URL &&
    process.env.CANTON_TOKEN &&
    process.env.CANTON_USER_ID &&
    process.env.CANTON_SYNCHRONIZER_ID &&
    process.env.CANTON_SCAN_URL
  ) {
    const cantonSigner = toClientCantonSigner({
      participantUrl: process.env.CANTON_PARTICIPANT_URL,
      token: process.env.CANTON_TOKEN,
      userId: process.env.CANTON_USER_ID,
      synchronizerId: process.env.CANTON_SYNCHRONIZER_ID,
      scanUrl: process.env.CANTON_SCAN_URL,
      party: process.env.CLIENT_CANTON_PARTY,
      privateKeyPem: process.env.CLIENT_CANTON_PRIVATE_KEY,
      ...(process.env.CANTON_TOKEN_REGISTRIES
        ? { tokenRegistries: JSON.parse(process.env.CANTON_TOKEN_REGISTRIES) }
        : {}),
    });
    schemes.push({
      network: networkCaip2Pattern("canton"),
      client: new ExactCantonClientScheme(cantonSigner, {
        ...(process.env.CANTON_REGISTRY_TRUSTED_PARTIES
          ? { registryTrustedParties: JSON.parse(process.env.CANTON_REGISTRY_TRUSTED_PARTIES) }
          : {}),
      }),
    });
  }
  if (process.env.CLIENT_XRPL_SEED) {
    const xrplNetwork = resolveNetworkCaip2("xrpl") as `xrpl:${number}`;
    const xrplSigner = createXrplWalletSigner(Wallet.fromSeed(process.env.CLIENT_XRPL_SEED));
    schemes.push({
      network: networkCaip2Pattern("xrpl"),
      client: new ExactXrplClientScheme(
        xrplSigner,
        process.env.XRPL_RPC_URL
          ? { wsUrlByNetwork: { [xrplNetwork]: process.env.XRPL_RPC_URL } }
          : {},
      ),
    });
  }

  // E2e exercises custom assets and amounts above the default $1 USD cap.
  const client = x402Client.fromConfig({
    schemes,
    spendControls: false,
  });

  const batchSettlementPhase = process.env.EVM_BATCH_SETTLEMENT_PHASE as BatchSettlementPhase | undefined;

  return { url, client, schemes, batchSettlementScheme, batchSettlementPhase };
}

function aggregateBatchResult(
  phase: BatchSettlementPhase,
  results: RequestResult[],
  details: Record<string, RequestResult>,
) {
  const last = results[results.length - 1]!;
  return {
    success: results.every(result => result.success),
    data: {
      batchSettlement: {
        phase,
        requests: results,
        ...details,
      },
    },
    status_code: last.status_code,
    payment_response: last.payment_response,
  };
}

export type ClientScenarioDeps = {
  url: string;
  batchSettlementPhase: BatchSettlementPhase | undefined;
  batchSettlementScheme: BatchSettlementEvmScheme | undefined;
  issueRequest: () => Promise<RequestResult>;
  /**
   * Overrides how the cooperative refund request is sent. Defaults to
   * `batchSettlementScheme.refund(url)` (a real HTTP request). Transports that
   * don't speak plain HTTP (e.g. MCP) provide a `fetch` shim here instead.
   */
  refund?: () => Promise<SettleResponse>;
};

/**
 * Runs the standard single-request or batch-settlement client scenario and prints JSON.
 */
export async function runClientScenario(deps: ClientScenarioDeps): Promise<void> {
  const { url, batchSettlementPhase, batchSettlementScheme, issueRequest } = deps;
  if (batchSettlementPhase && !batchSettlementScheme) {
    throw new Error(
      "EVM_BATCH_SETTLEMENT_PHASE is set but no CLIENT_EVM_PRIVATE_KEY was provided to build a " +
        "batch-settlement scheme from.",
    );
  }
  const sendRefund = deps.refund ?? (() => batchSettlementScheme!.refund(url));

  if (!batchSettlementPhase) {
    const result = await issueRequest();
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (batchSettlementPhase === "initial") {
    const deposit = await issueRequest();
    const voucher = await issueRequest();
    console.log(
      JSON.stringify(aggregateBatchResult("initial", [deposit, voucher], { deposit, voucher })),
    );
    process.exit(0);
  }

  if (batchSettlementPhase === "recovery-refund") {
    const recoveryVoucher = await issueRequest();
    const refundSettle = await sendRefund();
    const refund = {
      success: refundSettle.success,
      data: { refund: true },
      status_code: 200,
      payment_response: refundSettle,
    };
    console.log(
      JSON.stringify(
        aggregateBatchResult("recovery-refund", [recoveryVoucher, refund], {
          recoveryVoucher,
          refund,
        }),
      ),
    );
    process.exit(0);
  }

  if (batchSettlementPhase === "full") {
    const deposit = await issueRequest();
    const voucher = await issueRequest();
    const refundSettle = await sendRefund();
    const refund = {
      success: refundSettle.success,
      data: { refund: true },
      status_code: 200,
      payment_response: refundSettle,
    };
    console.log(
      JSON.stringify(
        aggregateBatchResult("full", [deposit, voucher, refund], { deposit, voucher, refund }),
      ),
    );
    process.exit(0);
  }

  throw new Error(`Unknown EVM_BATCH_SETTLEMENT_PHASE: ${batchSettlementPhase}`);
}
