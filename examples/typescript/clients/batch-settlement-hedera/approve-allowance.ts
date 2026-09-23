/**
 * One-time setup: grants the network's deposit collector an HTS allowance for USDC so the
 * facilitator can pull deposits into the escrow on the payer's behalf.
 */
import { getDefaultAsset } from "@x402/hedera";
import { ensureHtsAllowance, readHtsAllowance } from "@x402/hedera/batch-settlement/client";
import { parseHederaPrivateKey } from "@x402/hedera/batch-settlement";
import { config } from "dotenv";

config();

const network = (process.env.HEDERA_NETWORK || "hedera:testnet") as `${string}:${string}`;
const accountId = process.env.HEDERA_ACCOUNT_ID;
const privateKey = process.env.HEDERA_PRIVATE_KEY;
if (!accountId || !privateKey) {
  console.error("HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are required");
  process.exit(1);
}
const tokenId = process.env.HEDERA_TOKEN_ID ?? getDefaultAsset(network).asset;
const amount = (process.env.ALLOWANCE_AMOUNT || "max") as "max" | string;

/**
 * Grants the allowance when it is below the requested amount and prints the result.
 */
async function main(): Promise<void> {
  const before = await readHtsAllowance({
    network,
    ownerAccountId: accountId!,
    tokenId,
  });
  console.log(`Current allowance to collector: ${before}`);
  const tx = await ensureHtsAllowance({
    network,
    ownerAccountId: accountId!,
    ownerPrivateKey: parseHederaPrivateKey(privateKey!),
    tokenId,
    required: amount === "max" ? 2n ** 63n - 1n : BigInt(amount),
    amount,
  });
  console.log(tx ? `Approved (tx ${tx})` : "Allowance already sufficient");
  const after = await readHtsAllowance({
    network,
    ownerAccountId: accountId!,
    tokenId,
  });
  console.log(`Allowance now: ${after}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
