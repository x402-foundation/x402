import { encodeFunctionData, decodeFunctionResult } from "viem";

/**
 * Multicall3 contract address.
 * Same address on all EVM chains via CREATE2 deployment.
 *
 * @see https://github.com/mds1/multicall
 */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** Multicall3 getEthBalance ABI for querying native token balance. */
export const multicall3GetEthBalanceAbi = [
  {
    name: "getEthBalance",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** Multicall3 tryAggregate ABI for batching calls. */
const multicall3ABI = [
  {
    inputs: [
      { name: "requireSuccess", type: "bool" },
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    name: "tryAggregate",
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export type ContractCall = {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

export type RawContractCall = {
  address: `0x${string}`;
  callData: `0x${string}`;
};

export type MulticallSuccess = { status: "success"; result: unknown };
export type MulticallFailure = { status: "failure"; error: Error };
export type MulticallResult = MulticallSuccess | MulticallFailure;

/**
 * Batches contract calls via Multicall3 `tryAggregate(false, ...)`.
 *
 * Accepts a mix of typed ContractCall (ABI-encoded + decoded) and
 * RawContractCall (pre-encoded calldata, no decoding) entries.
 * Raw calls are useful for the EIP-6492 factory deployment case
 * where calldata is pre-encoded with no ABI available.
 */
type ReadContractFn = (args: {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}) => Promise<unknown>;

/**
 * Executes multiple contract read calls in a single RPC round-trip using Multicall3.
 *
 * @param readContract - Function that performs a single contract read (e.g. viem readContract)
 * @param calls - Array of contract calls to batch (ContractCall or RawContractCall)
 * @returns A promise that resolves to an array of decoded results, one per call
 */
export async function multicall(
  readContract: ReadContractFn,
  calls: ReadonlyArray<ContractCall | RawContractCall>,
): Promise<MulticallResult[]> {
  const aggregateCalls = calls.map(call => {
    if ("callData" in call) {
      return { target: call.address, callData: call.callData };
    }
    const callData = encodeFunctionData({
      abi: call.abi,
      functionName: call.functionName,
      args: call.args as unknown[],
    });
    return { target: call.address, callData };
  });

  const rawResults = (await readContract({
    address: MULTICALL3_ADDRESS,
    abi: multicall3ABI,
    functionName: "tryAggregate",
    args: [false, aggregateCalls],
  })) as { success: boolean; returnData: `0x${string}` }[];

  return rawResults.map((raw, i) => {
    if (!raw.success) {
      return {
        status: "failure" as const,
        error: new Error(`multicall: call reverted (returnData: ${raw.returnData})`),
      };
    }

    const call = calls[i];
    if ("callData" in call) {
      return { status: "success" as const, result: undefined };
    }

    try {
      const decoded = decodeFunctionResult({
        abi: call.abi,
        functionName: call.functionName,
        data: raw.returnData,
      });
      return { status: "success" as const, result: decoded };
    } catch (err) {
      return {
        status: "failure" as const,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  });
}
