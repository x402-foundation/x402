import { keccak256, toBytes } from "viem";
import {
  HEDERA_ACCOUNT_SERVICE_ADDRESS,
  createMirrorNodeContractReader,
  entityIdToLongZeroAddress,
  parseHederaPrivateKey,
  resolveAccountEvmAddress,
  signDigestWithPrivateKey,
} from "../src/batch-settlement";
import { mirrorNodeUrlForNetwork } from "../src/preflight";

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
 * Probes HAS with long-zero vs alias addresses for the authorizer account.
 */
async function main(): Promise<void> {
  const mirrorNodeUrl = mirrorNodeUrlForNetwork("hedera:testnet");
  const reader = createMirrorNodeContractReader({ mirrorNodeUrl });
  const digest = keccak256(toBytes("authorizer probe"));
  const id = process.env.AUTHORIZER_ACCOUNT_ID!;
  const key = parseHederaPrivateKey(process.env.AUTHORIZER_PRIVATE_KEY!, "ECDSA_SECP256K1");
  const sig = await signDigestWithPrivateKey(key, digest);
  for (const [label, account] of [
    ["long-zero", entityIdToLongZeroAddress(id)],
    ["mirror evm_address", await resolveAccountEvmAddress(mirrorNodeUrl, id)],
  ] as const) {
    try {
      const ok = await reader.readContract({
        address: HEDERA_ACCOUNT_SERVICE_ADDRESS,
        abi: hasAbi,
        functionName: "isAuthorizedRaw",
        args: [account, digest, sig],
      });
      console.log(`${label} ${account} -> ${String(ok)}`);
    } catch (e) {
      console.log(`${label} ${account} -> ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
