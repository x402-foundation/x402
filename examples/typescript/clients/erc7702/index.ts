import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

config();

const privateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

/**
 * ERC-7702 client example.
 *
 * An ERC-7702 delegated EOA has smart contract bytecode at its address
 * (the 0xef0100 delegation designation), but the owner still signs with
 * the original ECDSA private key.
 *
 * Client setup is IDENTICAL to a regular EOA — no special configuration needed.
 *
 * On the facilitator side, x402 routes by code.length (matching on-chain
 * SignatureChecker semantics used by Permit2 and USDC v2.2): because the
 * 7702 address has bytecode, the facilitator calls the delegate's
 * `isValidSignature(hash, sig)` rather than ecrecover. Whether a given
 * signature is accepted depends on the delegate's validator logic.
 *
 * For common delegates that accept raw owner ECDSA (e.g. Biconomy Nexus with
 * a K1 default validator, Coinbase eip-7702-proxy), the raw owner signature
 * produced by this example works end-to-end. Delegates that require wrapped
 * or prefixed signatures (e.g. 7579 session-key validators) need the client
 * to produce the format the delegate expects.
 */
async function main(): Promise<void> {
  const account = privateKeyToAccount(privateKey);
  console.log(`Using account: ${account.address}`);

  // Check delegation status (informational only — not required for x402)
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });
  const code = await publicClient.getCode({ address: account.address });
  if (code && code.startsWith("0xef0100")) {
    const delegate = `0x${code.slice(8)}`;
    console.log(`ERC-7702 delegation active → ${delegate}`);
  } else {
    console.log("No ERC-7702 delegation detected (works as a regular EOA)");
  }

  // Standard x402 client setup — identical for 7702 and regular EOAs
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(account));

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`\nRequesting: ${url}`);
  const response = await fetchWithPayment(url, { method: "GET" });
  const body = await response.text();
  console.log("Response:", body);
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
