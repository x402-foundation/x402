// Live testnet integration suite (env-gated, exactly like @x402/aptos). Runs ONLY
// via `pnpm test:integration` with a funded `SUI_CLIENT_PRIVATE_KEY`; the default
// `pnpm test` excludes this file. Exercises the real client→server→facilitator
// flow on Sui testnet: build a gasless payment, verify the exact-fee match, settle
// (keyless broadcast), and assert idempotent re-settle + the cheat/expiry guards.

import { beforeAll, describe, expect, it } from "vitest";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { toBase64, fromBase64 } from "@mysten/sui/utils";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSuiScheme as ExactSuiClient } from "../../src/exact/client/scheme";
import { ExactSuiScheme as ExactSuiServer } from "../../src/exact/server/scheme";
import { ExactSuiScheme as ExactSuiFacilitator } from "../../src/exact/facilitator/scheme";
import { toClientSuiSigner, toFacilitatorSuiSigner } from "../../src/signer";
import { TESTNET_RPC_URL, USDC_TESTNET } from "../../src/constants";

const NETWORK: Network = "sui:testnet";
const CLIENT_KEY = process.env.SUI_CLIENT_PRIVATE_KEY;

if (!CLIENT_KEY) {
  throw new Error("SUI_CLIENT_PRIVATE_KEY (funded testnet key) is required for integration tests");
}

function reqs(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: USDC_TESTNET,
    amount: "10000",
    payTo: Ed25519Keypair.generate().toSuiAddress(),
    maxTimeoutSeconds: 60,
    extra: {},
    ...over,
  };
}

describe("Sui exact — live testnet integration", () => {
  let client: ExactSuiClient;
  let facilitator: ExactSuiFacilitator;
  let payer: string;
  let grpc: SuiGrpcClient;

  beforeAll(() => {
    const { secretKey } = decodeSuiPrivateKey(CLIENT_KEY);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);
    payer = keypair.toSuiAddress();
    grpc = new SuiGrpcClient({ network: "testnet", baseUrl: TESTNET_RPC_URL });
    client = new ExactSuiClient(toClientSuiSigner(keypair, grpc));
    facilitator = new ExactSuiFacilitator(toFacilitatorSuiSigner());
  });

  it("parsePrice produces atomic USDC requirements", async () => {
    const server = new ExactSuiServer();
    const price = await server.parsePrice("$0.01", NETWORK);
    expect(price.amount).toBe("10000");
    expect(price.asset).toBe(USDC_TESTNET);
  });

  it("builds a gasless single-output payment that verifies and settles", async () => {
    const requirements = reqs();
    const payload = (await client.createPaymentPayload(2, requirements)) as PaymentPayload;
    payload.accepted = requirements;

    const verify = await facilitator.verify(payload, requirements);
    expect(verify.isValid, verify.invalidMessage).toBe(true);
    expect(verify.payer).toBe(payer);

    const settle = await facilitator.settle(payload, requirements);
    expect(settle.success, settle.errorMessage).toBe(true);
    expect(settle.transaction).toMatch(/^[A-Za-z0-9]+$/);
    console.log("single-output settled digest:", settle.transaction);

    // Idempotent re-settle: same signed tx → same digest, no double charge.
    const resettle = await facilitator.settle(payload, requirements);
    expect(resettle.transaction).toBe(settle.transaction);
  });

  it("builds a gasless two-output split that verifies and settles", async () => {
    const r1 = Ed25519Keypair.generate().toSuiAddress();
    const r2 = Ed25519Keypair.generate().toSuiAddress();
    const requirements = reqs({
      payTo: r1,
      extra: {
        outputs: [
          { to: r1, amount: "9800" },
          { to: r2, amount: "200" },
        ],
      },
    });
    const payload = (await client.createPaymentPayload(2, requirements)) as PaymentPayload;
    payload.accepted = requirements;

    const verify = await facilitator.verify(payload, requirements);
    expect(verify.isValid, verify.invalidMessage).toBe(true);

    const settle = await facilitator.settle(payload, requirements);
    expect(settle.success, settle.errorMessage).toBe(true);
    console.log("two-output settled digest:", settle.transaction);
  });

  it("rejects a cheat: a payment whose recipient differs from the requirements", async () => {
    // Build for one payTo, then verify against DIFFERENT requirements.
    const built = reqs();
    const payload = (await client.createPaymentPayload(2, built)) as PaymentPayload;
    payload.accepted = built;

    const tampered = reqs({ payTo: Ed25519Keypair.generate().toSuiAddress() });
    const verify = await facilitator.verify(payload, tampered);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_exact_sui_payload_recipient_mismatch");
  });

  // ── coin-object payer (zero Address Balance) settles end-to-end ──────────────────
  // The COMMON case: a payer holding USDC as a classic Coin<T> object, not an Address
  // Balance. The client builds [SplitCoins, coin::into_balance, balance::send_funds,
  // coin::send_funds]; the facilitator must ACCEPT it — a too-strict allowlist that
  // rejected SplitCoins would refuse the payloads its own client produces.
  it("settles a COIN-OBJECT payer (zero Address Balance) end-to-end", async () => {
    const jsonRpc = new SuiJsonRpcClient({
      url: getJsonRpcFullnodeUrl("testnet"),
      network: "testnet",
    });
    const funder = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(CLIENT_KEY!).secretKey);

    // Mint a fresh payer funded with USDC as a COIN OBJECT (+ a little SUI for parity)
    // and ZERO Address Balance, by withdrawing from the funder's Address Balance into a
    // Coin and transferring it.
    const coinPayer = new Ed25519Keypair();
    const coinPayerAddr = coinPayer.toSuiAddress();
    const fundTx = new Transaction();
    fundTx.setSender(funder.toSuiAddress());
    const [gas] = fundTx.splitCoins(fundTx.gas, [fundTx.pure.u64(50_000_000n)]);
    fundTx.transferObjects([gas], fundTx.pure.address(coinPayerAddr));
    const bal = fundTx.balance({ type: USDC_TESTNET, balance: 20_000n });
    const coin = fundTx.moveCall({
      target: "0x2::coin::from_balance",
      typeArguments: [USDC_TESTNET],
      arguments: [bal],
    });
    fundTx.transferObjects([coin], fundTx.pure.address(coinPayerAddr));
    const fundBytes = await fundTx.build({ client: jsonRpc });
    const { signature: fundSig } = await funder.signTransaction(fundBytes);
    const fundRes = await jsonRpc.executeTransactionBlock({
      transactionBlock: toBase64(fundBytes),
      signature: fundSig,
      options: { showEffects: true },
    });
    expect(fundRes.effects?.status?.status).toBe("success");
    await jsonRpc.waitForTransaction({ digest: fundRes.digest, options: { showEffects: true } });

    // Confirm the payer is coin-object-only (zero Address Balance).
    const payerBal = await jsonRpc.getBalance({ owner: coinPayerAddr, coinType: USDC_TESTNET });
    expect((payerBal as unknown as { fundsInAddressBalance: string }).fundsInAddressBalance).toBe(
      "0",
    );

    const coinClient = new ExactSuiClient(toClientSuiSigner(coinPayer, grpc));
    const requirements = reqs({ payTo: Ed25519Keypair.generate().toSuiAddress() });
    const payload = (await coinClient.createPaymentPayload(2, requirements)) as PaymentPayload;
    payload.accepted = requirements;

    // The built PTB is the coin-source shape — proving the path under test.
    const cmds = Transaction.from(
      fromBase64((payload.payload as { transaction: string }).transaction),
    )
      .getData()
      .commands.map(c => c.$kind);
    expect(cmds[0]).toBe("SplitCoins");

    const verify = await facilitator.verify(payload, requirements);
    expect(verify.isValid, verify.invalidMessage).toBe(true);

    const settle = await facilitator.settle(payload, requirements);
    expect(settle.success, settle.errorMessage).toBe(true);
    console.log("coin-only payer settled digest:", settle.transaction);
  }, 60_000); // funds a coin-object payer + settles = two on-chain round trips

  // ── replay guard: an already-executed payment is rejected on re-verify; re-settle
  // is idempotent (simulation is NOT a replay guard for gasless Address Balances) ───
  it("rejects a replay on re-verify and re-settles idempotently", async () => {
    const jsonRpc = new SuiJsonRpcClient({
      url: getJsonRpcFullnodeUrl("testnet"),
      network: "testnet",
    });
    const requirements = reqs();
    const payload = (await client.createPaymentPayload(2, requirements)) as PaymentPayload;
    payload.accepted = requirements;

    const settle = await facilitator.settle(payload, requirements);
    expect(settle.success, settle.errorMessage).toBe(true);
    await jsonRpc.waitForTransaction({
      digest: settle.transaction,
      options: { showEffects: true },
    });

    // Re-verify the SAME payload — now rejected as already-executed (the replay hole).
    const replay = await facilitator.verify(payload, requirements);
    expect(replay.isValid).toBe(false);
    expect(replay.invalidReason).toBe("invalid_transaction_state");

    // Re-settle the SAME payload — idempotent success returning the original digest.
    const resettle = await facilitator.settle(payload, requirements);
    expect(resettle.success).toBe(true);
    expect(resettle.transaction).toBe(settle.transaction);
  }, 60_000); // settle + finality + re-verify + re-settle = several on-chain round trips

  // ── buildUrl pre-sign guard: dry-runs prebuilt bytes and refuses to sign bytes
  // that pay a hidden recipient (the whole threat model of a prebuilt path) ─────────
  it("refuses to sign buildUrl bytes that pay a hidden recipient", async () => {
    const declaredPayTo = Ed25519Keypair.generate().toSuiAddress();
    const attacker = Ed25519Keypair.generate().toSuiAddress();

    // A MALICIOUS facilitator returns gasless bytes paying the ATTACKER, not payTo.
    const evil = new Transaction();
    evil.setSender(payer);
    evil.moveCall({
      target: "0x2::balance::send_funds",
      typeArguments: [USDC_TESTNET],
      arguments: [
        evil.balance({ type: USDC_TESTNET, balance: 10_000n }),
        evil.pure.address(attacker),
      ],
    });
    evil.setGasBudget(0n);
    const evilBytes = toBase64(await evil.build({ client: grpc }));

    // Stub fetch ONLY for the buildUrl (the guard requires an https URL); every other
    // request — crucially the JSON-RPC dry-run the guard itself makes — passes through.
    const realFetch = globalThis.fetch;
    const evilUrl = "https://evil.example/build";
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === evilUrl) {
        return Promise.resolve(
          new Response(JSON.stringify({ transaction: evilBytes }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const requirements = reqs({ payTo: declaredPayTo, extra: { buildUrl: evilUrl } });
      await expect(client.createPaymentPayload(2, requirements)).rejects.toThrow(
        /do not pay the declared split|undeclared recipient|expected \+10000/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
