import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClientEvmSigner } from "../../../src/signer";

const {
  mockReadContract,
  mockGetTransactionCount,
  mockEstimateFeesPerGas,
  mockCreatePublicClient,
  mockHttp,
} = vi.hoisted(() => {
  const readContract = vi.fn();
  const getTransactionCount = vi.fn();
  const estimateFeesPerGas = vi.fn();
  return {
    mockReadContract: readContract,
    mockGetTransactionCount: getTransactionCount,
    mockEstimateFeesPerGas: estimateFeesPerGas,
    mockCreatePublicClient: vi.fn(() => ({
      readContract,
      getTransactionCount,
      estimateFeesPerGas,
    })),
    mockHttp: vi.fn((url: string) => ({ url })),
  };
});

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: mockCreatePublicClient,
    http: mockHttp,
  };
});

import {
  resolveRpcUrl,
  resolveExtensionRpcCapabilities,
  type EvmSchemeOptions,
} from "../../../src/shared/rpc";
import { ExactEvmScheme } from "../../../src/exact/client/scheme";
import { UptoEvmScheme } from "../../../src/upto/client/scheme";
import { _resetSponsoringWarnings } from "../../../src/shared/extensions/gasSponsoring";
import { ERC20_APPROVAL_GAS_SPONSORING_KEY } from "../../../src/exact/extensions";
import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";

describe("Exact EVM RPC resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves rpc url from single config", () => {
    const options: EvmSchemeOptions = { rpcUrl: "https://base.example" };
    expect(resolveRpcUrl("eip155:8453", options)).toBe("https://base.example");
  });

  it("resolves rpc url from chain map", () => {
    const options: EvmSchemeOptions = {
      137: { rpcUrl: "https://polygon.example" },
      8453: { rpcUrl: "https://base.example" },
    };
    expect(resolveRpcUrl("eip155:8453", options)).toBe("https://base.example");
    expect(resolveRpcUrl("eip155:137", options)).toBe("https://polygon.example");
  });

  it("keeps signer capabilities as highest precedence", async () => {
    const signerRead = vi.fn().mockResolvedValue(1n);
    const signerGetTx = vi.fn().mockResolvedValue(7);
    const signerFees = vi.fn().mockResolvedValue({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    });

    const signer: ClientEvmSigner = {
      address: "0x1234567890123456789012345678901234567890",
      signTypedData: vi.fn().mockResolvedValue("0xabc"),
      readContract: signerRead,
      getTransactionCount: signerGetTx,
      estimateFeesPerGas: signerFees,
    };

    const capabilities = resolveExtensionRpcCapabilities("eip155:8453", signer, {
      rpcUrl: "https://base.example",
    });
    await capabilities.readContract?.({
      address: "0x1234567890123456789012345678901234567890",
      abi: [],
      functionName: "allowance",
      args: [],
    });

    expect(capabilities.readContract).toBe(signerRead);
    expect(capabilities.getTransactionCount).toBe(signerGetTx);
    expect(capabilities.estimateFeesPerGas).toBe(signerFees);
    expect(mockCreatePublicClient).not.toHaveBeenCalled();
  });

  it("backfills missing read and fee capabilities from rpc", async () => {
    mockReadContract.mockResolvedValue(0n);
    mockGetTransactionCount.mockResolvedValue(3);
    mockEstimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 111n,
      maxPriorityFeePerGas: 22n,
    });

    const signer: ClientEvmSigner = {
      address: "0x1234567890123456789012345678901234567890",
      signTypedData: vi.fn().mockResolvedValue("0xabc"),
    };

    const capabilities = resolveExtensionRpcCapabilities("eip155:8453", signer, {
      rpcUrl: "https://base.example",
    });

    const allowance = await capabilities.readContract?.({
      address: "0x1234567890123456789012345678901234567890",
      abi: [],
      functionName: "allowance",
      args: [],
    });
    const nonce = await capabilities.getTransactionCount?.({
      address: "0x1234567890123456789012345678901234567890",
    });
    const fees = await capabilities.estimateFeesPerGas?.();

    expect(mockCreatePublicClient).toHaveBeenCalledTimes(1);
    expect(mockHttp).toHaveBeenCalledWith("https://base.example");
    expect(allowance).toBe(0n);
    expect(nonce).toBe(3);
    expect(fees).toEqual({ maxFeePerGas: 111n, maxPriorityFeePerGas: 22n });
  });
});

describe("allowance short-circuit", () => {
  const signerAddress = "0x1234567890123456789012345678901234567890" as const;
  const payTo = "0x3333333333333333333333333333333333333333" as const;
  const asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
  const facilitator = "0x4444444444444444444444444444444444444444" as const;

  const exactRequirements: PaymentRequirements = {
    scheme: "exact",
    network: "eip155:8453",
    asset,
    amount: "100",
    payTo,
    maxTimeoutSeconds: 600,
    extra: {
      assetTransferMethod: "permit2",
      name: "USDC",
      version: "2",
    },
  };

  const uptoRequirements: PaymentRequirements = {
    scheme: "upto",
    network: "eip155:8453",
    asset,
    amount: "100",
    payTo,
    maxTimeoutSeconds: 600,
    extra: {
      facilitatorAddress: facilitator,
      name: "USDC",
      version: "2",
    },
  };

  const schemes: {
    name: string;
    requirements: PaymentRequirements;
    create: (signer: ClientEvmSigner, options?: EvmSchemeOptions) => SchemeNetworkClient;
  }[] = [
    {
      name: "exact",
      requirements: exactRequirements,
      create: (signer, options) => new ExactEvmScheme(signer, options),
    },
    {
      name: "upto",
      requirements: uptoRequirements,
      create: (signer, options) => new UptoEvmScheme(signer, options),
    },
  ];

  const cases: {
    name: string;
    hasRpc?: boolean;
    rpc?: (url: string) => EvmSchemeOptions;
    wantReads: number;
    wantRpcCall: number;
    wantWarning: boolean;
  }[] = [
    { name: "reads allowance without probe", wantReads: 1, wantRpcCall: 0, wantWarning: false },
    {
      name: "reads allowance when HasRPCClient is true",
      hasRpc: true,
      wantReads: 1,
      wantRpcCall: 0,
      wantWarning: false,
    },
    {
      name: "skips allowance read when HasRPCClient is false",
      hasRpc: false,
      wantReads: 0,
      wantRpcCall: 0,
      wantWarning: true,
    },
    {
      name: "reads allowance via RPCURL when HasRPCClient is false",
      hasRpc: false,
      rpc: url => ({ rpcUrl: url }),
      wantReads: 0,
      wantRpcCall: 1,
      wantWarning: false,
    },
    {
      name: "reads allowance via RPCByChainID when HasRPCClient is false",
      hasRpc: false,
      rpc: url => ({ 8453: { rpcUrl: url } }),
      wantReads: 0,
      wantRpcCall: 1,
      wantWarning: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    _resetSponsoringWarnings();
    mockReadContract.mockResolvedValue(1_000_000n);
  });

  for (const schemeCase of schemes) {
    describe(schemeCase.name, () => {
      for (const rpcCase of cases) {
        it(rpcCase.name, async () => {
          const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
          const readContract = vi.fn().mockResolvedValue(1_000_000n);
          const signer: ClientEvmSigner = {
            address: signerAddress,
            signTypedData: vi.fn().mockResolvedValue("0x01"),
            readContract,
            signTransaction: vi.fn().mockResolvedValue("0x02ab"),
            getTransactionCount: vi.fn().mockResolvedValue(0),
            estimateFeesPerGas: vi
              .fn()
              .mockResolvedValue({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
            ...(rpcCase.hasRpc === undefined
              ? {}
              : { hasRpcClient: () => rpcCase.hasRpc === true }),
          };
          const options = rpcCase.rpc?.("https://allowance.example");
          const scheme = schemeCase.create(signer, options);

          try {
            const payload = await scheme.createPaymentPayload(2, schemeCase.requirements, {
              extensions: {
                [ERC20_APPROVAL_GAS_SPONSORING_KEY]: {},
              },
            });

            expect(payload.extensions).toBeUndefined();
            expect(readContract).toHaveBeenCalledTimes(rpcCase.wantReads);
            expect(mockReadContract).toHaveBeenCalledTimes(rpcCase.wantRpcCall);
            expect(warn).toHaveBeenCalledTimes(rpcCase.wantWarning ? 1 : 0);
          } finally {
            warn.mockRestore();
          }
        });
      }
    });
  }
});
