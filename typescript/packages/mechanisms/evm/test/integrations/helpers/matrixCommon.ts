/**
 * Shared helpers for EVM wallet-matrix and exact smart-account integration tests.
 */

import { expect } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  keccak256,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  SupportedResponse,
  Network,
} from "@x402/core/types";
import {
  ExactEvmScheme as ExactEvmClient,
  UptoEvmScheme as UptoEvmClient,
  toFacilitatorEvmSigner,
} from "../../../src";
import { ExactEvmScheme as ExactEvmServer } from "../../../src/exact/server/scheme";
import { UptoEvmScheme as UptoEvmServer } from "../../../src/upto/server/scheme";
import { ExactEvmScheme as ExactEvmFacilitator } from "../../../src/exact/facilitator/scheme";
import type { ClientEvmSigner } from "../../../src/signer";
import { COINBASE_SMART_WALLET_FACTORY } from "./smartAccounts";

export type MatrixEnv = {
  FACILITATOR_PRIVATE_KEY?: `0x${string}`;
  CLIENT_PRIVATE_KEY?: `0x${string}`;
  CLIENT_4337_ADDRESS?: `0x${string}`;
  CLIENT_4337_OWNER_PRIVATE_KEY?: `0x${string}`;
  CLIENT_7579_ADDRESS?: `0x${string}`;
  CLIENT_7579_OWNER_PRIVATE_KEY?: `0x${string}`;
  CLIENT_7579_VALIDATOR?: `0x${string}`;
  CLIENT_6492_OWNER_PRIVATE_KEY?: `0x${string}`;
  CLIENT_6492_FACTORY?: `0x${string}`;
  CLIENT_6492_SALT?: `0x${string}`;
  CLIENT_7702_PRIVATE_KEY?: `0x${string}`;
  CLIENT_7702_ADDRESS?: `0x${string}`;
  SIMPLE_WALLET_FACTORY?: `0x${string}`;
  WALLET_B_SALT?: `0x${string}`;
};

export const matrixEnv: MatrixEnv = {
  FACILITATOR_PRIVATE_KEY: process.env.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined,
  CLIENT_PRIVATE_KEY: process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined,
  CLIENT_4337_ADDRESS: process.env.CLIENT_4337_ADDRESS as `0x${string}` | undefined,
  CLIENT_4337_OWNER_PRIVATE_KEY: process.env.CLIENT_4337_OWNER_PRIVATE_KEY as
    | `0x${string}`
    | undefined,
  CLIENT_7579_ADDRESS: process.env.CLIENT_7579_ADDRESS as `0x${string}` | undefined,
  CLIENT_7579_OWNER_PRIVATE_KEY: process.env.CLIENT_7579_OWNER_PRIVATE_KEY as
    | `0x${string}`
    | undefined,
  CLIENT_7579_VALIDATOR: process.env.CLIENT_7579_VALIDATOR as `0x${string}` | undefined,
  CLIENT_6492_OWNER_PRIVATE_KEY: process.env.CLIENT_6492_OWNER_PRIVATE_KEY as
    | `0x${string}`
    | undefined,
  CLIENT_6492_FACTORY: process.env.CLIENT_6492_FACTORY as `0x${string}` | undefined,
  CLIENT_6492_SALT: process.env.CLIENT_6492_SALT as `0x${string}` | undefined,
  CLIENT_7702_PRIVATE_KEY: process.env.CLIENT_7702_PRIVATE_KEY as `0x${string}` | undefined,
  CLIENT_7702_ADDRESS: process.env.CLIENT_7702_ADDRESS as `0x${string}` | undefined,
  SIMPLE_WALLET_FACTORY:
    (process.env.SIMPLE_WALLET_FACTORY as `0x${string}` | undefined) ??
    COINBASE_SMART_WALLET_FACTORY,
  WALLET_B_SALT: process.env.WALLET_B_SALT as `0x${string}` | undefined,
};

export const NETWORK: Network = "eip155:84532";
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const PAYMENT_AMOUNT = "100";
export const ERC6492_MAGIC = "0x6492649264926492649264926492649264926492649264926492649264926492";

export const FACTORY_ABI = [
  {
    name: "createWallet",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_salt", type: "bytes32" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

export const USDC_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

class LocalFacilitatorClient implements FacilitatorClient {
  constructor(private readonly facilitator: x402Facilitator) {}
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(p, r);
  }
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(p, r);
  }
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

export function buildFacilitator(facilitatorKey: `0x${string}`, factoryAllowlist?: string[]) {
  const pc = createPublicClient({ chain: baseSepolia, transport: http() });
  const facilAcct = privateKeyToAccount(facilitatorKey);
  const facilWc = createWalletClient({ account: facilAcct, chain: baseSepolia, transport: http() });

  const facilitatorSigner = toFacilitatorEvmSigner({
    address: facilAcct.address,
    readContract: async args => {
      const r = await pc.simulateContract({
        account: facilAcct,
        address: args.address,
        abi: args.abi as never,
        functionName: args.functionName,
        args: (args.args || []) as never,
      });
      return r.result;
    },
    verifyTypedData: args => pc.verifyTypedData(args as never),
    writeContract: args => facilWc.writeContract({ ...args, args: args.args || [] } as never),
    sendTransaction: args => facilWc.sendTransaction(args),
    waitForTransactionReceipt: args => pc.waitForTransactionReceipt(args),
    getCode: args => pc.getCode(args),
  });

  const evmFacilitator = new ExactEvmFacilitator(facilitatorSigner, {
    eip6492AllowedFactories:
      factoryAllowlist ??
      (matrixEnv.SIMPLE_WALLET_FACTORY ? [matrixEnv.SIMPLE_WALLET_FACTORY] : []),
  });
  const facilitator = new x402Facilitator().register(NETWORK, evmFacilitator);
  return { facilitator, facilAcct, facilWc, pc, facilitatorSigner };
}

export function buildExactServer(facilitatorKey: `0x${string}`, factoryAllowlist?: string[]) {
  const { facilitator, facilAcct } = buildFacilitator(facilitatorKey, factoryAllowlist);
  const server = new x402ResourceServer(new LocalFacilitatorClient(facilitator));
  server.register(NETWORK, new ExactEvmServer());
  return { server, facilAcct };
}

export function makeErc6492Sig(
  innerSig: `0x${string}`,
  factory: `0x${string}`,
  factoryCalldata: `0x${string}`,
): `0x${string}` {
  const encoded = encodeAbiParameters(parseAbiParameters("address, bytes, bytes"), [
    factory,
    factoryCalldata,
    innerSig,
  ]);
  return concat([encoded, ERC6492_MAGIC]) as `0x${string}`;
}

export async function factoryGetAddress(
  pc: ReturnType<typeof createPublicClient>,
  factory: `0x${string}`,
  owner: `0x${string}`,
  salt: `0x${string}`,
): Promise<`0x${string}`> {
  const sel = keccak256(toBytes("getAddress(address,bytes32)")).slice(0, 10);
  const args = encodeAbiParameters(parseAbiParameters("address, bytes32"), [owner, salt]);
  const { data } = await pc.call({ to: factory, data: (sel + args.slice(2)) as `0x${string}` });
  return ("0x" + data!.slice(-40)) as `0x${string}`;
}

export function buildExactEip3009Accepts(payTo: string): PaymentRequirements[] {
  return [
    {
      scheme: "exact" as const,
      network: NETWORK,
      asset: USDC,
      amount: PAYMENT_AMOUNT,
      payTo,
      maxTimeoutSeconds: 3600,
      extra: { name: "USDC", version: "2" },
    },
  ];
}

export function buildExactPermit2Accepts(payTo: string): PaymentRequirements[] {
  return [
    {
      scheme: "exact" as const,
      network: NETWORK,
      asset: USDC,
      amount: PAYMENT_AMOUNT,
      payTo,
      maxTimeoutSeconds: 3600,
      extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
    },
  ];
}

export function buildUptoPermit2Accepts(
  payTo: string,
  facilitatorAddr: string,
): PaymentRequirements[] {
  return [
    {
      scheme: "upto" as const,
      network: NETWORK,
      asset: USDC,
      amount: PAYMENT_AMOUNT,
      payTo,
      maxTimeoutSeconds: 3600,
      extra: {
        name: "USDC",
        version: "2",
        assetTransferMethod: "permit2",
        facilitatorAddress: facilitatorAddr,
      },
    },
  ];
}

type FlowSigner = ClientEvmSigner | ReturnType<typeof privateKeyToAccount>;

export async function runExactFlow(
  clientSigner: FlowSigner,
  accepts: PaymentRequirements[],
  server: x402ResourceServer,
  label: string,
  sigOverride?: `0x${string}`,
): Promise<SettleResponse> {
  const evmClient = new ExactEvmClient(clientSigner);
  const client = new x402Client().register(NETWORK, evmClient);
  await server.initialize();

  const paymentRequired = await server.createPaymentRequiredResponse(accepts, {
    url: "https://test.x402.org",
    description: label,
    mimeType: "application/json",
  });
  const payload = await client.createPaymentPayload(paymentRequired);
  if (sigOverride && payload.payload && typeof payload.payload === "object") {
    (payload.payload as Record<string, unknown>).signature = sigOverride;
  }

  const accepted = server.findMatchingRequirements(accepts, payload);
  expect(accepted).toBeDefined();

  const verifyResp = await server.verifyPayment(payload, accepted!);
  expect(verifyResp.isValid, `${label}: verify failed: ${verifyResp.invalidReason}`).toBe(true);

  const settleResp = await server.settlePayment(payload, accepted!);
  expect(settleResp.success, `${label}: settle failed: ${settleResp.errorReason}`).toBe(true);
  console.log(`${label} ✅ tx=${settleResp.transaction}`);
  return settleResp;
}

export async function runUptoFlow(
  clientAcct: ReturnType<typeof privateKeyToAccount>,
  accepts: PaymentRequirements[],
  facilitatorKey: `0x${string}`,
  label: string,
): Promise<SettleResponse> {
  const pc = createPublicClient({ chain: baseSepolia, transport: http() });
  const facilAcct = privateKeyToAccount(facilitatorKey);
  const facilWc = createWalletClient({ account: facilAcct, chain: baseSepolia, transport: http() });

  const facilitatorSigner = toFacilitatorEvmSigner({
    address: facilAcct.address,
    readContract: async args => {
      const r = await pc.simulateContract({
        account: facilAcct,
        address: args.address,
        abi: args.abi as never,
        functionName: args.functionName,
        args: (args.args || []) as never,
      });
      return r.result;
    },
    verifyTypedData: args => pc.verifyTypedData(args as never),
    writeContract: args => facilWc.writeContract({ ...args, args: args.args || [] } as never),
    sendTransaction: args => facilWc.sendTransaction(args),
    waitForTransactionReceipt: args => pc.waitForTransactionReceipt(args),
    getCode: args => pc.getCode(args),
  });

  const { UptoEvmScheme: UptoEvmFacilitator } = await import(
    "../../../src/upto/facilitator/scheme"
  );
  const uptoFacilitator = new UptoEvmFacilitator(facilitatorSigner);
  const facilitator = new x402Facilitator().register(NETWORK, uptoFacilitator);
  const uptoServer = new x402ResourceServer(new LocalFacilitatorClient(facilitator));
  uptoServer.register(NETWORK, new UptoEvmServer());
  await uptoServer.initialize();

  const evmClient = new UptoEvmClient(clientAcct);
  const client = new x402Client().register(NETWORK, evmClient);

  const paymentRequired = await uptoServer.createPaymentRequiredResponse(accepts, {
    url: "https://test.x402.org",
    description: label,
    mimeType: "application/json",
  });
  const payload = await client.createPaymentPayload(paymentRequired);
  const accepted = uptoServer.findMatchingRequirements(accepts, payload);
  expect(accepted).toBeDefined();

  const verifyResp = await uptoServer.verifyPayment(payload, accepted!);
  expect(verifyResp.isValid, `${label}: verify failed: ${verifyResp.invalidReason}`).toBe(true);

  const settleResp = await uptoServer.settlePayment(payload, accepted!);
  expect(settleResp.success, `${label}: settle failed: ${settleResp.errorReason}`).toBe(true);
  console.log(`${label} ✅ tx=${settleResp.transaction}`);
  return settleResp;
}
