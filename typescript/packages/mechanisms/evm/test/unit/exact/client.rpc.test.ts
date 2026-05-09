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

vi.mock("viem", () => ({
  createPublicClient: mockCreatePublicClient,
  http: mockHttp,
}));

import {
  resolveRpcUrl,
  resolveExtensionRpcCapabilities,
  type ExactEvmSchemeOptions,
} from "../../../src/exact/client/rpc";

describe("Exact EVM RPC resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves rpc url from single config", () => {
    const options: ExactEvmSchemeOptions = { rpcUrl: "https://base.example" };
    expect(resolveRpcUrl("eip155:8453", options)).toBe("https://base.example");
  });

  it("resolves rpc url from chain map", () => {
    const options: ExactEvmSchemeOptions = {
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
