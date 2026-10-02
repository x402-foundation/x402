/**
 * Associates an already-deployed `x402BatchSettlementHedera` escrow with an HTS token
 * (permissionless `associateToken(token)`), paid by the operator.
 *
 * Env: HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY, HEDERA_NETWORK (default hedera:testnet),
 *      HEDERA_TOKEN_ID (default: network USDC), HEDERA_SETTLEMENT_ID (default: configured deployment)
 */
import { ContractExecuteTransaction, Hbar } from "@hiero-ledger/sdk";
import { encodeFunctionData, hexToBytes } from "viem";
import { createHederaClient } from "../src/signer";
import { parseHederaPrivateKey } from "../src/batch-settlement/signing";
import { getDefaultAsset } from "../src/defaultAssets";
import { batchSettlementABI } from "../src/batch-settlement/abi";
import { HEDERA_GAS, getBatchSettlementDeployment } from "../src/batch-settlement/constants";
import { tokenIdToEvmAddress } from "../src/batch-settlement/addresses";

const network = (process.env.HEDERA_NETWORK ?? "hedera:testnet") as `${string}:${string}`;
const operatorId = process.env.HEDERA_OPERATOR_ID;
const operatorKeyRaw = process.env.HEDERA_OPERATOR_KEY;
if (!operatorId || !operatorKeyRaw) {
  console.error("HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY are required");
  process.exit(1);
}
const tokenId = process.env.HEDERA_TOKEN_ID ?? getDefaultAsset(network).asset;
const settlementId =
  process.env.HEDERA_SETTLEMENT_ID ?? getBatchSettlementDeployment(network).settlementId;

/**
 * Runs the association.
 */
async function main(): Promise<void> {
  const client = createHederaClient(network).setOperator(
    operatorId!,
    parseHederaPrivateKey(operatorKeyRaw!),
  );
  client.setDefaultMaxTransactionFee(new Hbar(20));
  try {
    const data = encodeFunctionData({
      abi: batchSettlementABI,
      functionName: "associateToken",
      args: [tokenIdToEvmAddress(tokenId)],
    });
    const response = await new ContractExecuteTransaction()
      .setContractId(settlementId)
      .setGas(Number(HEDERA_GAS.associate))
      .setFunctionParameters(hexToBytes(data))
      .execute(client);
    const record = await response.getRecord(client);
    console.log(
      `associateToken(${tokenId}) on ${settlementId}: tx ${response.transactionId} status ${record.receipt.status.toString()}`,
    );
  } finally {
    client.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
