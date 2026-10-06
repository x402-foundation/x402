/**
 * Deploys `x402BatchSettlementHedera` + `HederaAllowanceDepositCollector` to a Hedera network
 * with the Hiero SDK (HAPI `ContractCreateFlow`), enables unlimited auto token associations on
 * the escrow, and associates it with the payment token.
 *
 * Prerequisites: `cd contracts/evm && forge build` (artifacts under `contracts/evm/out`).
 *
 * Env:
 *   HEDERA_OPERATOR_ID        operator account id (pays fees, becomes admin key holder)
 *   HEDERA_OPERATOR_KEY       operator private key (ED25519 or ECDSA, DER/hex)
 *   HEDERA_NETWORK            hedera:testnet (default) | hedera:mainnet
 *   HEDERA_TOKEN_ID           HTS token to associate (default: network USDC)
 *   CONTRACTS_OUT_DIR         forge `out` dir (default: ../../../../contracts/evm/out)
 *
 * Usage: pnpm deploy:batch-settlement
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ContractCreateFlow,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  Hbar,
} from "@hiero-ledger/sdk";
import { encodeFunctionData, getAddress, hexToBytes } from "viem";
import { createHederaClient } from "../src/signer";
import { parseHederaPrivateKey } from "../src/batch-settlement/signing";
import { getDefaultAsset } from "../src/defaultAssets";
import { batchSettlementABI } from "../src/batch-settlement/abi";
import { HEDERA_GAS } from "../src/batch-settlement/constants";
import { tokenIdToEvmAddress } from "../src/batch-settlement/addresses";

const network = (process.env.HEDERA_NETWORK ?? "hedera:testnet") as `${string}:${string}`;
const operatorId = process.env.HEDERA_OPERATOR_ID;
const operatorKeyRaw = process.env.HEDERA_OPERATOR_KEY;
if (!operatorId || !operatorKeyRaw) {
  console.error("HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY are required");
  process.exit(1);
}
const tokenId = process.env.HEDERA_TOKEN_ID ?? getDefaultAsset(network).asset;
const outDir = resolve(
  process.env.CONTRACTS_OUT_DIR ?? resolve(__dirname, "../../../../../contracts/evm/out"),
);

/**
 * Reads creation bytecode from a forge artifact.
 *
 * @param name - Contract name.
 * @returns Hex bytecode without the 0x prefix.
 */
function bytecodeOf(name: string): string {
  const artifact = JSON.parse(readFileSync(resolve(outDir, `${name}.sol/${name}.json`), "utf8"));
  const object: string = artifact.bytecode.object;
  return object.replace(/^0x/, "");
}

/**
 * Deploys one contract via `ContractCreateFlow`.
 *
 * @param params - Deployment parameters.
 * @param params.name - Contract name (artifact lookup + logging).
 * @param params.bytecode - Creation bytecode hex.
 * @param params.constructorParams - Optional ABI-encoded constructor params.
 * @param params.client - Hiero client.
 * @param params.adminKey - Admin key for the contract.
 * @returns Contract id string and EVM address.
 */
async function deploy(params: {
  name: string;
  bytecode: string;
  constructorParams?: ContractFunctionParameters;
  client: ReturnType<typeof createHederaClient>;
  adminKey: PrivateKey;
}): Promise<{ id: string; evm: `0x${string}` }> {
  const flow = new ContractCreateFlow()
    .setBytecode(params.bytecode)
    .setGas(4_000_000)
    .setAdminKey(params.adminKey)
    .setMaxAutomaticTokenAssociations(-1)
    .setContractMemo(`x402 ${params.name}`);
  if (params.constructorParams) {
    flow.setConstructorParameters(params.constructorParams);
  }
  const response = await flow.execute(params.client);
  const receipt = await response.getReceipt(params.client);
  const contractId = receipt.contractId;
  if (!contractId) {
    throw new Error(`${params.name}: no contract id in receipt`);
  }
  const evm = getAddress(`0x${contractId.toEvmAddress().replace(/^0x/, "")}`);
  console.log(`${params.name}: ${contractId.toString()} (${evm}) tx ${response.transactionId}`);
  return { id: contractId.toString(), evm };
}

/**
 * Runs the deployment.
 */
async function main(): Promise<void> {
  const operatorKey = parseHederaPrivateKey(operatorKeyRaw!);
  const client = createHederaClient(network).setOperator(operatorId!, operatorKey);
  client.setDefaultMaxTransactionFee(new Hbar(100));
  try {
    console.log(`Deploying to ${network} as ${operatorId} (token ${tokenId})`);

    const settlement = await deploy({
      name: "x402BatchSettlementHedera",
      bytecode: bytecodeOf("x402BatchSettlementHedera"),
      client,
      adminKey: operatorKey,
    });

    const collector = await deploy({
      name: "HederaAllowanceDepositCollector",
      bytecode: bytecodeOf("HederaAllowanceDepositCollector"),
      constructorParams: new ContractFunctionParameters().addAddress(settlement.evm),
      client,
      adminKey: operatorKey,
    });

    const tokenAddress = tokenIdToEvmAddress(tokenId);
    const data = encodeFunctionData({
      abi: batchSettlementABI,
      functionName: "associateToken",
      args: [tokenAddress],
    });
    const assoc = await new ContractExecuteTransaction()
      .setContractId(settlement.id)
      .setGas(Number(HEDERA_GAS.associate))
      .setFunctionParameters(hexToBytes(data))
      .execute(client);
    const record = await assoc.getRecord(client);
    console.log(
      `associateToken(${tokenId}): tx ${assoc.transactionId} status ${record.receipt.status.toString()}`,
    );

    console.log("\nAdd to BATCH_SETTLEMENT_DEPLOYMENTS (src/batch-settlement/constants.ts):");
    console.log(
      JSON.stringify(
        {
          [network]: {
            settlement: settlement.evm,
            settlementId: settlement.id,
            collector: collector.evm,
            collectorId: collector.id,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    client.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
