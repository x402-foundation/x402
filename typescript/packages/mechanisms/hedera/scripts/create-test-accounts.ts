/**
 * Creates funded testnet accounts for exercising batch-settlement end-to-end:
 * an ED25519 client, an ECDSA client, a server receiver, and a receiver authorizer.
 * Each account is funded with HBAR by the operator and associated with the payment token.
 *
 * Env: HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY, HEDERA_NETWORK, HEDERA_TOKEN_ID,
 *      HBAR_PER_ACCOUNT (default 20), OUTPUT (default .env.testnet-accounts)
 */
import { writeFileSync } from "node:fs";
import {
  AccountCreateTransaction,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
} from "@hiero-ledger/sdk";
import { createHederaClient } from "../src/signer";
import { getDefaultAsset } from "../src/defaultAssets";
import { parseHederaPrivateKey } from "../src/batch-settlement/signing";

const network = (process.env.HEDERA_NETWORK ?? "hedera:testnet") as `${string}:${string}`;
const operatorId = process.env.HEDERA_OPERATOR_ID;
const operatorKeyRaw = process.env.HEDERA_OPERATOR_KEY;
if (!operatorId || !operatorKeyRaw) {
  console.error("HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY are required");
  process.exit(1);
}
const tokenId = process.env.HEDERA_TOKEN_ID ?? getDefaultAsset(network).asset;
const hbarPerAccount = Number(process.env.HBAR_PER_ACCOUNT ?? "20");
const output = process.env.OUTPUT ?? ".env.testnet-accounts";

/**
 * Creates one account, funds it and associates it with the token.
 *
 * @param client - Hiero client with the operator set.
 * @param label - Env prefix for the output file.
 * @param type - Key algorithm.
 * @param associate - Whether to associate the token.
 * @returns Env lines.
 */
async function create(
  client: ReturnType<typeof createHederaClient>,
  label: string,
  type: "ED25519" | "ECDSA",
  associate: boolean,
): Promise<string[]> {
  const key = type === "ED25519" ? PrivateKey.generateED25519() : PrivateKey.generateECDSA();
  const tx = new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(new Hbar(hbarPerAccount))
    .setMaxAutomaticTokenAssociations(-1);
  if (type === "ECDSA") {
    tx.setAlias(key.publicKey.toEvmAddress());
  }
  const response = await tx.execute(client);
  const receipt = await response.getReceipt(client);
  const accountId = receipt.accountId!.toString();
  if (associate) {
    const assoc = await new TokenAssociateTransaction()
      .setAccountId(accountId)
      .setTokenIds([TokenId.fromString(tokenId)])
      .freezeWith(client)
      .sign(key);
    await (await assoc.execute(client)).getReceipt(client);
  }
  console.log(`${label}: ${accountId} (${type}${associate ? ", associated with " + tokenId : ""})`);
  return [
    `${label}_ACCOUNT_ID=${accountId}`,
    `${label}_PRIVATE_KEY=${key.toStringDer()}`,
    `${label}_KEY_TYPE=${type}`,
  ];
}

/**
 * Creates all test accounts and writes their credentials to `output`.
 */
async function main(): Promise<void> {
  const client = createHederaClient(network).setOperator(
    operatorId!,
    parseHederaPrivateKey(operatorKeyRaw!),
  );
  try {
    const lines: string[] = [`HEDERA_NETWORK=${network}`, `HEDERA_TOKEN_ID=${tokenId}`];
    lines.push(...(await create(client, "CLIENT_ED25519", "ED25519", true)));
    lines.push(...(await create(client, "CLIENT_ECDSA", "ECDSA", true)));
    lines.push(...(await create(client, "SERVER", "ED25519", true)));
    lines.push(...(await create(client, "AUTHORIZER", "ECDSA", false)));
    writeFileSync(output, lines.join("\n") + "\n", { mode: 0o600 });
    console.log(`\nWrote ${output}`);
  } finally {
    client.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
