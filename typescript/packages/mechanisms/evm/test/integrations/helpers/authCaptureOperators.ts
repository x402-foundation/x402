/**
 * CREATE2 skip-if-deployed helpers for auth-capture test operators.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  concat,
  encodeDeployData,
  getAddress,
  getContractAddress,
  keccak256,
  pad,
  stringToHex,
  type Abi,
  type Hex,
} from "viem";

/** Arachnid's deterministic CREATE2 deployer (same address on Base Sepolia). */
export const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as const;

/** Inner CREATE2 needs more gas than a plain call; public RPCs often underestimate. */
const CREATE2_DEPLOY_GAS = 3_000_000n;

export type OperatorArtifact = {
  abi: Abi;
  bytecode: Hex;
};

type CodeReader = {
  getCode: (args: { address: `0x${string}` }) => Promise<Hex | undefined>;
  waitForTransactionReceipt: (args: { hash: Hex }) => Promise<{
    status: string;
    to?: `0x${string}` | null;
    contractAddress?: `0x${string}` | null;
  }>;
};

type TxSender = {
  sendTransaction: (args: { to: `0x${string}`; data: Hex; gas?: bigint }) => Promise<Hex>;
};

/**
 * Loads a committed ABI+bytecode artifact for a test operator.
 *
 * @param name - Contract file stem (`ForwardingOperator`, `NoopOperator`, `GasWastingOperator`).
 * @returns Artifact consumed by CREATE2 deploy.
 */
export function loadOperatorArtifact(name: string): OperatorArtifact {
  const path = join(process.cwd(), "test/contracts/auth-capture/artifacts", `${name}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    abi: Abi;
    bytecode: string;
  };
  return {
    abi: parsed.abi,
    bytecode: parsed.bytecode as Hex,
  };
}

/**
 * CREATE2 salt bound to the operator contract name. Bytecode changes still
 * produce a new address via the init-code hash, so a new deploy happens only then.
 *
 * @param name - Contract file stem.
 * @returns 32-byte salt.
 */
export function operatorCreate2Salt(name: string): Hex {
  return keccak256(stringToHex(`x402.auth-capture.test.${name}.v1`));
}

/**
 * Reads contract code at `latest`, retrying so a lagging public RPC does not
 * report an empty account right after CREATE2. Historical `blockNumber` is
 * avoided: public Base Sepolia RPCs often prune and return "block not found".
 *
 * @param publicClient - Code reader.
 * @param address - Predicted CREATE2 address.
 * @returns Bytecode, or undefined when still empty.
 */
async function readDeployedCode(
  publicClient: CodeReader,
  address: `0x${string}`,
): Promise<Hex | undefined> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const code = await publicClient.getCode({ address });
      if (code && code !== "0x") {
        return code;
      }
    } catch {
      // Public RPCs can throw on a lagging head; retry at latest.
    }
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
  return undefined;
}

/**
 * Predicts the CREATE2 address, deploys via Arachnid's deployer if empty, and
 * returns the address. Subsequent runs reuse the live contract.
 *
 * @param publicClient - Reads code at the predicted address.
 * @param walletClient - Pays for the one-time deploy.
 * @param artifact - Committed ABI and creation bytecode.
 * @param salt - CREATE2 salt.
 * @param constructorArgs - Encoded after bytecode; empty when the contract has no constructor.
 * @returns The operator address.
 */
export async function ensureCreate2Operator(
  publicClient: CodeReader,
  walletClient: TxSender,
  artifact: OperatorArtifact,
  salt: Hex,
  constructorArgs: readonly unknown[] = [],
): Promise<`0x${string}`> {
  const initCode = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [...constructorArgs],
  });
  const saltBytes32 = pad(salt, { size: 32 });
  const address = getAddress(
    getContractAddress({
      opcode: "CREATE2",
      from: CREATE2_DEPLOYER,
      salt: saltBytes32,
      bytecode: initCode,
    }),
  );
  const deployData = concat([saltBytes32, initCode]);

  const deployerCode = await publicClient.getCode({ address: CREATE2_DEPLOYER });
  if (!deployerCode || deployerCode === "0x") {
    throw new Error(`CREATE2 deployer ${CREATE2_DEPLOYER} is not deployed on this chain`);
  }

  const existing = await publicClient.getCode({ address });
  if (existing && existing !== "0x") {
    return address;
  }

  const hash = await walletClient.sendTransaction({
    to: CREATE2_DEPLOYER,
    data: deployData,
    gas: CREATE2_DEPLOY_GAS,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`CREATE2 deploy of operator at ${address} reverted (tx ${hash})`);
  }

  const deployed = await readDeployedCode(publicClient, address);
  if (deployed) {
    return address;
  }

  const fallback = receipt.contractAddress ? getAddress(receipt.contractAddress) : undefined;
  if (fallback) {
    const fallbackCode = await readDeployedCode(publicClient, fallback);
    if (fallbackCode) {
      throw new Error(
        `CREATE2 predicted ${address} but the tx created ${fallback} instead (tx ${hash}). ` +
          `The factory call likely lost its to= field; check sendTransaction args.`,
      );
    }
  }

  throw new Error(
    `No bytecode at predicted CREATE2 address ${address} (tx ${hash}, to=${receipt.to ?? "null"})`,
  );
}
