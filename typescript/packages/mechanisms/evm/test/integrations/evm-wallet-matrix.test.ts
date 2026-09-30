/**
 * Wallet compatibility matrix integration tests — TypeScript SDK.
 *
 * Wallet types tested:
 *   A - Plain EOA
 *   B - Deployed Coinbase Smart Wallet (ERC-4337)
 *   7579 - Deployed Biconomy Nexus (ERC-7579)
 *   C - ERC-6492 counterfactual — fresh wallet generated per run
 *   D - ERC-7702 EOA delegated to PermissiveECDSADelegate
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createPublicClient, createWalletClient, http, encodeFunctionData, maxUint256 } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme as ExactEvmClient } from "../../src";
import {
  matrixEnv as env,
  buildExactServer,
  buildExactEip3009Accepts,
  buildExactPermit2Accepts,
  buildUptoPermit2Accepts,
  runExactFlow,
  runUptoFlow,
  makeErc6492Sig,
  factoryGetAddress,
  FACTORY_ABI,
  USDC,
  USDC_ABI,
} from "./helpers/matrixCommon";
import {
  createCoinbaseSmartWalletClientSigner,
  createNexusClientSigner,
  NEXUS_K1_VALIDATOR,
} from "./helpers/smartAccounts";

const skip = !env.FACILITATOR_PRIVATE_KEY;

describe.skipIf(skip)("EVM Wallet Compatibility Matrix — Base Sepolia", () => {
  let server: x402ResourceServer;
  let facilAcct: ReturnType<typeof privateKeyToAccount>;

  beforeAll(() => {
    const fixtures = buildExactServer(env.FACILITATOR_PRIVATE_KEY!);
    server = fixtures.server;
    facilAcct = fixtures.facilAcct;
  });

  describe("Wallet A — Plain EOA", () => {
    it.skipIf(!env.CLIENT_PRIVATE_KEY)("exact / EIP-3009", { timeout: 60000 }, async () => {
      const acct = privateKeyToAccount(env.CLIENT_PRIVATE_KEY!);
      await runExactFlow(acct, buildExactEip3009Accepts(facilAcct.address), server, "A/EIP-3009");
    });

    it.skipIf(!env.CLIENT_PRIVATE_KEY)("exact / Permit2", { timeout: 60000 }, async () => {
      const acct = privateKeyToAccount(env.CLIENT_PRIVATE_KEY!);
      const { server: s, facilAcct: fa } = buildExactServer(env.FACILITATOR_PRIVATE_KEY!);
      await runExactFlow(acct, buildExactPermit2Accepts(fa.address), s, "A/Permit2");
    });

    it.skipIf(!env.CLIENT_PRIVATE_KEY)("upto / Permit2", { timeout: 60000 }, async () => {
      const acct = privateKeyToAccount(env.CLIENT_PRIVATE_KEY!);
      const accepts = buildUptoPermit2Accepts(facilAcct.address, facilAcct.address);
      await runUptoFlow(acct, accepts, env.FACILITATOR_PRIVATE_KEY!, "A/upto-Permit2");
    });
  });

  describe("Wallet B — Coinbase Smart Wallet (ERC-4337)", () => {
    it.skipIf(!env.CLIENT_4337_ADDRESS || !env.CLIENT_4337_OWNER_PRIVATE_KEY)(
      "exact / EIP-3009 — replay-safe SignatureWrapper",
      { timeout: 60000 },
      async () => {
        const ownerAcct = privateKeyToAccount(env.CLIENT_4337_OWNER_PRIVATE_KEY!);
        const signer = createCoinbaseSmartWalletClientSigner(ownerAcct, env.CLIENT_4337_ADDRESS!);
        const settle = await runExactFlow(
          signer,
          buildExactEip3009Accepts(facilAcct.address),
          server,
          "B/EIP-3009",
        );
        expect(settle.payer.toLowerCase()).toBe(env.CLIENT_4337_ADDRESS!.toLowerCase());
      },
    );

    it.skipIf(!env.CLIENT_4337_ADDRESS)(
      "exact / Permit2 ❌ SKIPPED — requires smart-account execute() for Permit2 allowance",
      () => {
        console.log(
          "B/Permit2: intentionally skipped — Coinbase Smart Wallet needs execute() for approve",
        );
      },
    );
  });

  describe("Wallet 7579 — Biconomy Nexus (ERC-7579)", () => {
    it.skipIf(!env.CLIENT_7579_ADDRESS || !env.CLIENT_7579_OWNER_PRIVATE_KEY)(
      "exact / EIP-3009 — ERC-7739 nested hash + validator prefix",
      { timeout: 60000 },
      async () => {
        const ownerAcct = privateKeyToAccount(env.CLIENT_7579_OWNER_PRIVATE_KEY!);
        const validator = env.CLIENT_7579_VALIDATOR ?? NEXUS_K1_VALIDATOR;
        const signer = createNexusClientSigner(ownerAcct, env.CLIENT_7579_ADDRESS!, validator);
        const settle = await runExactFlow(
          signer,
          buildExactEip3009Accepts(facilAcct.address),
          server,
          "7579/EIP-3009",
        );
        expect(settle.payer.toLowerCase()).toBe(env.CLIENT_7579_ADDRESS!.toLowerCase());
      },
    );
  });

  describe("Wallet C — ERC-6492 counterfactual (fresh wallet per run)", () => {
    it.skipIf(!env.CLIENT_6492_FACTORY || !env.CLIENT_PRIVATE_KEY)(
      "exact / EIP-3009 — factory deploys wallet during settle",
      { timeout: 90000 },
      async () => {
        const pc = createPublicClient({ chain: baseSepolia, transport: http() });
        const funderAcct = privateKeyToAccount(env.CLIENT_PRIVATE_KEY!);
        const funderWc = createWalletClient({
          account: funderAcct,
          chain: baseSepolia,
          transport: http(),
        });

        const freshOwnerKey = generatePrivateKey();
        const freshOwner = privateKeyToAccount(freshOwnerKey);
        const saltBytes = crypto.getRandomValues(new Uint8Array(32));
        const runSalt = ("0x" +
          Array.from(saltBytes)
            .map(b => b.toString(16).padStart(2, "0"))
            .join("")) as `0x${string}`;

        const factory = env.CLIENT_6492_FACTORY!;
        const predictedAddr = await factoryGetAddress(pc, factory, freshOwner.address, runSalt);

        const code = await pc.getCode({ address: predictedAddr });
        expect(!code || code === "0x", "Fresh wallet must not be deployed").toBe(true);

        const fundHash = await funderWc.writeContract({
          address: USDC,
          abi: USDC_ABI,
          functionName: "transfer",
          args: [predictedAddr, BigInt("100")],
        });
        await pc.waitForTransactionReceipt({ hash: fundHash });

        const factoryCalldata = encodeFunctionData({
          abi: FACTORY_ABI,
          functionName: "createWallet",
          args: [freshOwner.address, runSalt],
        });

        const fakeCounterfactualAcct = { ...freshOwner, address: predictedAddr };
        const { server: s6492 } = buildExactServer(env.FACILITATOR_PRIVATE_KEY!, [factory]);
        await s6492.initialize();

        const accepts6492 = buildExactEip3009Accepts(facilAcct.address);
        const evmClient = new ExactEvmClient(fakeCounterfactualAcct);
        const client = new x402Client().register("eip155:84532", evmClient);
        const paymentRequired = await s6492.createPaymentRequiredResponse(accepts6492, {
          url: "https://test.x402.org",
          description: "C/ERC-6492-fresh",
          mimeType: "application/json",
        });
        const innerPayload = await client.createPaymentPayload(paymentRequired);
        const innerSig = (innerPayload.payload as Record<string, unknown>)
          .signature as `0x${string}`;
        const erc6492Sig = makeErc6492Sig(innerSig, factory, factoryCalldata);
        const erc6492Payload = {
          ...innerPayload,
          payload: { ...(innerPayload.payload as Record<string, unknown>), signature: erc6492Sig },
        };

        const accepted = s6492.findMatchingRequirements(accepts6492, erc6492Payload as never);
        expect(accepted).toBeDefined();
        const settleResp = await s6492.settlePayment(erc6492Payload as never, accepted!);
        expect(settleResp.success, `C/ERC-6492 settle failed: ${settleResp.errorReason}`).toBe(
          true,
        );
      },
    );

    it("exact / Permit2 ❌ NOT SUPPORTED", () => {
      console.log("C/Permit2: not supported");
    });
  });

  describe("Wallet D — ERC-7702 + permissive delegate", () => {
    it.skipIf(!env.CLIENT_7702_PRIVATE_KEY)("exact / EIP-3009", { timeout: 60000 }, async () => {
      const pc = createPublicClient({ chain: baseSepolia, transport: http() });
      const acct = privateKeyToAccount(env.CLIENT_7702_PRIVATE_KEY!);
      const code = await pc.getCode({ address: acct.address });
      if (!code?.startsWith("0xef0100")) {
        throw new Error(`Wallet D (${acct.address}) is not ERC-7702 delegated`);
      }
      await runExactFlow(acct, buildExactEip3009Accepts(facilAcct.address), server, "D/EIP-3009");
    });

    it.skipIf(!env.CLIENT_7702_PRIVATE_KEY)("exact / Permit2", { timeout: 60000 }, async () => {
      const pc = createPublicClient({ chain: baseSepolia, transport: http() });
      const acct = privateKeyToAccount(env.CLIENT_7702_PRIVATE_KEY!);
      const code = await pc.getCode({ address: acct.address });
      if (!code?.startsWith("0xef0100")) throw new Error("Wallet D not delegated");

      const acctWc = createWalletClient({ account: acct, chain: baseSepolia, transport: http() });
      const allowance = await pc.readContract({
        address: USDC,
        abi: USDC_ABI,
        functionName: "allowance",
        args: [acct.address, "0x000000000022D473030F116dDEE9F6B43aC78BA3"],
      });
      if (allowance < BigInt("100")) {
        const approveHash = await acctWc.writeContract({
          address: USDC,
          abi: USDC_ABI,
          functionName: "approve",
          args: ["0x000000000022D473030F116dDEE9F6B43aC78BA3", maxUint256],
        });
        await pc.waitForTransactionReceipt({ hash: approveHash });
      }

      const { server: sp2, facilAcct: fa } = buildExactServer(env.FACILITATOR_PRIVATE_KEY!);
      await runExactFlow(acct, buildExactPermit2Accepts(fa.address), sp2, "D/Permit2");
    });

    it.skipIf(!env.CLIENT_7702_PRIVATE_KEY)("upto / Permit2", { timeout: 60000 }, async () => {
      const pc = createPublicClient({ chain: baseSepolia, transport: http() });
      const acct = privateKeyToAccount(env.CLIENT_7702_PRIVATE_KEY!);
      const code = await pc.getCode({ address: acct.address });
      if (!code?.startsWith("0xef0100")) throw new Error("Wallet D not delegated");

      const accepts = buildUptoPermit2Accepts(facilAcct.address, facilAcct.address);
      await runUptoFlow(acct, accepts, env.FACILITATOR_PRIVATE_KEY!, "D/upto-Permit2");
    });
  });
});
