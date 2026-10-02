/**
 * Live probe: verifies that raw signatures produced by the SDK helpers are accepted by the Hedera
 * Account Service (`isAuthorizedRaw`) for ED25519 and ECDSA accounts, via Mirror Node simulation,
 * and that the deployed collector's `getDepositDigest` matches the TypeScript encoder.
 *
 * Env (from .env.testnet-accounts): CLIENT_ED25519_*, CLIENT_ECDSA_*, HEDERA_NETWORK
 */
import { encodeFunctionData, keccak256, toBytes } from "viem";
import {
  HEDERA_ACCOUNT_SERVICE_ADDRESS,
  getBatchSettlementDeployment,
  getHederaChainId,
  hederaAllowanceDepositCollectorABI,
  resolveAccountEvmAddress,
  computeHederaAllowanceDepositDigest,
  createMirrorNodeContractReader,
  parseHederaPrivateKey,
  signDigestWithPrivateKey,
  tokenIdToEvmAddress,
} from "../src/batch-settlement";
import { mirrorNodeUrlForNetwork } from "../src/preflight";

const network = (process.env.HEDERA_NETWORK ?? "hedera:testnet") as `${string}:${string}`;
const mirrorNodeUrl = mirrorNodeUrlForNetwork(network);
const hasAbi = [
  {
    type: "function",
    name: "isAuthorizedRaw",
    inputs: [
      { name: "account", type: "address" },
      { name: "messageHash", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "authorized", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Calls HAS `isAuthorizedRaw` through the Mirror Node.
 *
 * @param reader - Mirror Node reader.
 * @param account - Account EVM address.
 * @param digest - Signed digest.
 * @param signature - Raw signature.
 * @returns Result or error text.
 */
async function probe(
  reader: ReturnType<typeof createMirrorNodeContractReader>,
  account: `0x${string}`,
  digest: `0x${string}`,
  signature: `0x${string}`,
): Promise<string> {
  try {
    const ok = await reader.readContract({
      address: HEDERA_ACCOUNT_SERVICE_ADDRESS,
      abi: hasAbi,
      functionName: "isAuthorizedRaw",
      args: [account, digest, signature],
    });
    return `authorized=${String(ok)}`;
  } catch (error) {
    return `ERROR ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Runs the probe for both account types.
 */
async function main(): Promise<void> {
  const reader = createMirrorNodeContractReader({ mirrorNodeUrl });
  const digest = keccak256(toBytes("x402 hedera HAS probe"));
  void encodeFunctionData;

  for (const label of ["CLIENT_ED25519", "CLIENT_ECDSA"]) {
    const accountId = process.env[`${label}_ACCOUNT_ID`]!;
    const keyType = process.env[`${label}_KEY_TYPE`] === "ED25519" ? "ED25519" : "ECDSA_SECP256K1";
    const key = parseHederaPrivateKey(process.env[`${label}_PRIVATE_KEY`]!, keyType);
    const evm = await resolveAccountEvmAddress(mirrorNodeUrl, accountId);
    const sig = await signDigestWithPrivateKey(key, digest);
    console.log(`${label} ${accountId} evm=${evm} sigBytes=${(sig.length - 2) / 2}`);
    console.log(`  valid signature      -> ${await probe(reader, evm, digest, sig)}`);
    const tampered = (sig.slice(0, -2) + (sig.endsWith("00") ? "01" : "00")) as `0x${string}`;
    console.log(`  tampered signature   -> ${await probe(reader, evm, digest, tampered)}`);
    const otherDigest = keccak256(toBytes("other"));
    console.log(`  other digest         -> ${await probe(reader, evm, otherDigest, sig)}`);
  }

  const deployment = getBatchSettlementDeployment(network);
  const channelId = keccak256(toBytes("channel"));
  const token = tokenIdToEvmAddress(process.env.HEDERA_TOKEN_ID ?? "0.0.429274");
  const onchain = await reader.readContract({
    address: deployment.collector,
    abi: hederaAllowanceDepositCollectorABI,
    functionName: "getDepositDigest",
    args: [channelId, token, 5_000_000n, 42n, 1_800_000_000n],
  });
  const local = computeHederaAllowanceDepositDigest({
    channelId,
    token,
    amount: "5000000",
    nonce: "42",
    deadline: "1800000000",
    collector: deployment.collector,
    chainId: getHederaChainId(network),
  });
  console.log(
    `collector digest parity: onchain=${String(onchain)} local=${local} ${onchain === local ? "OK" : "MISMATCH"}`,
  );
  const settlementOfCollector = await reader.readContract({
    address: deployment.collector,
    abi: hederaAllowanceDepositCollectorABI,
    functionName: "x402BatchSettlement",
    args: [],
  });
  console.log(
    `collector.x402BatchSettlement=${String(settlementOfCollector)} expected=${deployment.settlement}`,
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
