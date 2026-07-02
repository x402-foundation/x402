// Fixture generator for the @x402/sui unit tests. Builds + signs REAL gasless
// Address-Balance payment transactions against Sui testnet ONCE, then prints the
// base64 `{ transaction, signature }` and the expected balanceChanges so they can
// be committed as constants in `fixtures.ts`. The unit tests replay these with a
// mock FacilitatorSuiSigner, so the default test run is fully network-free.
//
// Usage (one-time, with a funded testnet key in SUI_CLIENT_PRIVATE_KEY):
//   SUI_CLIENT_PRIVATE_KEY=suiprivkey1... npx tsx test/fixtures/gen.ts
//
// It mints a fresh throwaway recipient set, builds the gasless PTBs, signs them,
// dry-runs to capture the balanceChanges, and emits a TS module to stdout.

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { toBase64 } from "@mysten/sui/utils";
import { USDC_TESTNET } from "../../src/constants";

const GRPC = "https://fullnode.testnet.sui.io:443";

/**
 * Build, sign, and dry-run a gasless payment for the given outputs.
 *
 * @param signer - The funded payer keypair
 * @param grpc - The gRPC client (gasless build transport)
 * @param jsonRpc - The JSON-RPC client (dry-run for balanceChanges)
 * @param outputs - The declared `{ to, amount }` outputs
 * @returns The fixture payload (signature, transaction, sender, balanceChanges)
 */
async function buildFixture(
  signer: Ed25519Keypair,
  grpc: SuiGrpcClient,
  jsonRpc: SuiJsonRpcClient,
  outputs: { to: string; amount: string }[],
): Promise<unknown> {
  const tx = new Transaction();
  tx.setSender(signer.toSuiAddress());
  for (const o of outputs) {
    tx.moveCall({
      target: "0x2::balance::send_funds",
      typeArguments: [USDC_TESTNET],
      arguments: [
        tx.balance({ type: USDC_TESTNET, balance: BigInt(o.amount) }),
        tx.pure.address(o.to),
      ],
    });
  }
  tx.setGasBudget(0n);
  const built = await tx.build({ client: grpc });
  const transaction = toBase64(built);
  const { signature } = await signer.signTransaction(built);
  const sim = await jsonRpc.dryRunTransactionBlock({ transactionBlock: transaction });
  return {
    sender: signer.toSuiAddress(),
    transaction,
    signature,
    balanceChanges: sim.balanceChanges,
    status: sim.effects?.status,
  };
}

/**
 * Build a gas-PAYING object-write transaction (a coin split + transfer) and return
 * its base64 bytes. This single fixture violates every gasless-shape rule at once:
 * it carries a non-zero `gasPrice`, a non-empty `gasPayment`, and a non-allowlisted
 * command (object write) — so it fixtures the facilitator's step-3 rejection.
 *
 * @param signer - The payer keypair (sender)
 * @param grpc - The gRPC build client
 * @returns Base64-encoded transaction bytes
 */
async function buildGasPaying(signer: Ed25519Keypair, grpc: SuiGrpcClient): Promise<string> {
  const r = Ed25519Keypair.generate().toSuiAddress();
  const tx = new Transaction();
  tx.setSender(signer.toSuiAddress());
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(1n)]);
  tx.transferObjects([coin], tx.pure.address(r));
  const built = await tx.build({ client: grpc });
  return toBase64(built);
}

/**
 * Entry point: build the valid 1-output and 2-output fixtures and print them.
 *
 * @returns A promise that resolves once the fixtures are printed
 */
async function main(): Promise<void> {
  const priv = process.env.SUI_CLIENT_PRIVATE_KEY;
  if (!priv) {
    throw new Error("SUI_CLIENT_PRIVATE_KEY (funded testnet key) is required");
  }
  const { secretKey } = decodeSuiPrivateKey(priv);
  const signer = Ed25519Keypair.fromSecretKey(secretKey);
  const grpc = new SuiGrpcClient({ network: "testnet", baseUrl: GRPC });
  const jsonRpc = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl("testnet"),
    network: "testnet",
  });

  const r1 = Ed25519Keypair.generate().toSuiAddress();
  const r2 = Ed25519Keypair.generate().toSuiAddress();

  const single = await buildFixture(signer, grpc, jsonRpc, [{ to: r1, amount: "10000" }]);
  const split = await buildFixture(signer, grpc, jsonRpc, [
    { to: r1, amount: "9800" },
    { to: r2, amount: "200" },
  ]);
  const gasPaying = await buildGasPaying(signer, grpc);

  console.log(JSON.stringify({ single, split, gasPaying, recipients: { r1, r2 } }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
