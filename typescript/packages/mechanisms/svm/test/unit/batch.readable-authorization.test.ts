import metamaskCapture from "../fixtures/metamask-binary-capture.json";
import { verifyEd25519Signature } from "../../src/payment-channels/voucher";
import { selectRefundAccept } from "../../src/batch-settlement/client/refund";
import { createHash } from "node:crypto";
import vector from "../fixtures/batch-authorization-text-v1.json";
import {
  address,
  getBase58Encoder,
  createSignableMessage,
  generateKeyPairSigner,
  isMessageModifyingSigner,
  isMessagePartialSigner,
  getBase58Decoder,
  getUtf8Codec,
} from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  encodeBatchAuthorizationMessage,
  signBatchAuthorization,
  verifyBatchAuthorization,
} from "../../src/batch-settlement/authorization";
import { assertBatchAuthorizationFormat } from "../../src/batch-settlement/authorizationPolicy";
import { toBatchClientSigner } from "../../src/batch-settlement/client/signer";
import {
  BatchChannelTracker,
  buildDepositPayload,
} from "../../src/batch-settlement/client/channel";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import { BatchSvmScheme as Server } from "../../src/batch-settlement/server/scheme";
import { BatchSvmScheme as Facilitator } from "../../src/batch-settlement/facilitator/scheme";
import {
  assertServerModeProof,
  assertServerModeRefundProof,
} from "../../src/batch-settlement/facilitator/voucherMode";
import { isBatchPayload, type BatchAuthorizationFormat } from "../../src/batch-settlement/types";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let operator: typeof payer;
let feePayer: typeof payer;
let receiver: typeof payer;
let built: Awaited<ReturnType<typeof buildDepositPayload>>;
const expiry = Math.floor(Date.now() / 1000) + 600;
beforeAll(async () => {
  [payer, operator, feePayer, receiver] = await Promise.all(
    Array.from({ length: 4 }, () => generateKeyPairSigner()),
  );
  built = await buildDepositPayload({
    payer,
    operator: operator.address,
    feePayer: feePayer.address,
    receiver: USDC_MAINNET_ADDRESS,
    receiverAuthorizer: receiver.address,
    mint: USDC_DEVNET_ADDRESS,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
    openSlot: 1n,
    depositAmount: 10_000n,
    firstCharge: 1000n,
    withdrawDelay: 900,
    voucherSigner: "server",
    authorizationExpiresAt: expiry,
    authorizationFormat: "text-v1",
  });
});
function fields() {
  return {
    payer: payer.address,
    operator: operator.address,
    channelId: built.channelId,
    authorizedAmount: 1000n,
    expiresAt: expiry,
    requestId: "readable-test",
    format: "text-v1" as const,
  };
}
function requirements(format?: BatchAuthorizationFormat): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: SOLANA_DEVNET_CAIP2,
    asset: USDC_DEVNET_ADDRESS,
    payTo: USDC_MAINNET_ADDRESS,
    amount: "1000",
    maxTimeoutSeconds: 300,
    extra: {
      feePayer: feePayer.address,
      operator: operator.address,
      receiverAuthorizer: receiver.address,
      voucherSigner: "server",
      withdrawDelay: 900,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      ...(format ? { authorizationFormat: format } : {}),
    },
  };
}
function textProof() {
  return built.payload.authorization!;
}
function snapConvert(bytes: Uint8Array) {
  return createSignableMessage(getUtf8Codec().decode(bytes)).content;
}

describe("readable payer authorizations", () => {
  it("keeps refunds on the advertised format and rejects noncanonical amount text", async () => {
    expect(
      selectRefundAccept(
        [requirements(), requirements("text-v1")],
        built.payload.channelConfig,
        requirements(),
        "text-v1",
      ),
    ).toEqual(requirements("text-v1"));
    expect(() =>
      selectRefundAccept([requirements()], built.payload.channelConfig, requirements(), "text-v1"),
    ).toThrow(/no server-signed/);
    expect(
      await verifyBatchAuthorization(
        { ...textProof(), authorizedAmount: "01000" },
        operator.address,
      ),
    ).toBe(false);
  });

  it("matches fixed binary and text interoperability vectors", () => {
    const args = { ...vector.fields, authorizedAmount: BigInt(vector.fields.authorizedAmount) };
    const text = encodeBatchAuthorizationMessage({ ...args, format: "text-v1" });
    expect(Buffer.from(text).toString("hex")).toBe(vector.utf8Hex);
    expect(new TextDecoder().decode(text)).toBe(vector.text);
    expect(createHash("sha256").update(text).digest("hex")).toBe(vector.textSha256);
    expect(createHash("sha256").update(encodeBatchAuthorizationMessage(args)).digest("hex")).toBe(
      vector.binarySha256,
    );
  });

  it("produces a text deposit proof and verifies the existing binary default", async () => {
    expect(textProof().format).toBe("text-v1");
    expect(await verifyBatchAuthorization(textProof(), operator.address)).toBe(true);
    const binary = await signBatchAuthorization(
      payer,
      built.channelId,
      operator.address,
      "binary",
      1000n,
      expiry,
    );
    expect(binary.format).toBeUndefined();
    expect(await verifyBatchAuthorization(binary, operator.address)).toBe(true);
    expect(await verifyBatchAuthorization({ ...binary, format: "text-v1" }, operator.address)).toBe(
      false,
    );
    expect(
      await verifyBatchAuthorization({ ...textProof(), format: undefined }, operator.address),
    ).toBe(false);
  });
  it("matches the complete canonical text and preserves escaped request identifiers", () => {
    const message = encodeBatchAuthorizationMessage(fields());
    expect(new TextDecoder().decode(message)).toBe(
      [
        "x402-batch-authorization-text-v1",
        "Authorize a charge up to the amount below.",
        `Payer: ${payer.address}`,
        `Channel: ${built.channelId}`,
        `Operator: ${operator.address}`,
        "Maximum amount (atomic units): 1000",
        'Request ID (JSON string): "readable-test"',
        `Expires at (Unix seconds): ${expiry}`,
      ].join("\n"),
    );
    for (const requestId of ["a\u0000b\nOperator: forged", "🌍\u202e", 'quote"\\']) {
      const escaped = encodeBatchAuthorizationMessage({ ...fields(), requestId });
      expect([...escaped].every(byte => (byte >= 32 && byte <= 126) || byte === 10)).toBe(true);
      expect(snapConvert(escaped)).toEqual(escaped);
      expect(
        JSON.parse(
          new TextDecoder().decode(escaped).split("Request ID (JSON string): ")[1].split("\n")[0],
        ),
      ).toBe(requestId);
    }
  });
  it.each(["payer", "channelId", "requestId", "authorizedAmount", "expiresAt"] as const)(
    "rejects changed %s",
    async field => {
      const patch = {
        payer: receiver.address,
        channelId: receiver.address,
        requestId: "changed",
        authorizedAmount: "1001",
        expiresAt: expiry + 1,
      };
      expect(
        await verifyBatchAuthorization({ ...textProof(), [field]: patch[field] }, operator.address),
      ).toBe(false);
    },
  );
  it("rejects a changed operator, expiry, unknown format, or appended newline", async () => {
    expect(await verifyBatchAuthorization(textProof(), receiver.address)).toBe(false);
    expect(await verifyBatchAuthorization(textProof(), operator.address, expiry)).toBe(false);
    expect(
      await verifyBatchAuthorization(
        { ...textProof(), format: "text-v9" as never },
        operator.address,
      ),
    ).toBe(false);
    expect(
      isBatchPayload({ ...built.payload, authorization: { ...textProof(), format: "text-v9" } }),
    ).toBe(false);
    const bytes = encodeBatchAuthorizationMessage(fields());
    const [signed] = await payer.signMessages([
      createSignableMessage(new Uint8Array([...bytes, 10])),
    ]);
    const proof = {
      ...textProof(),
      requestId: fields().requestId,
      signature: getBase58Decoder().decode(signed[payer.address]),
    };
    expect(await verifyBatchAuthorization(proof, operator.address)).toBe(false);
  });
  it("supports the tracker and zero-amount refund without changing operator vouchers", async () => {
    const tracker = new BatchChannelTracker(built.channelId, built.payload.channelConfig, payer);
    const authorization = await tracker.authorization("refund", 0n, expiry, "text-v1");
    expect(await verifyBatchAuthorization(authorization, operator.address)).toBe(true);
    await expect(
      assertServerModeRefundProof(
        { type: "refund", channelConfig: built.payload.channelConfig, authorization },
        built.channelId,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertServerModeProof(built.payload, built.channelId, requirements("text-v1")),
    ).resolves.toBeUndefined();
  });
  it("requires matching requirements and explicit local format support", () => {
    expect(() => assertBatchAuthorizationFormat(built.payload, requirements("text-v1"))).toThrow(
      /not enabled/,
    );
    expect(() =>
      assertBatchAuthorizationFormat(built.payload, requirements(), ["binary", "text-v1"]),
    ).toThrow(/does not match/);
    expect(() =>
      assertBatchAuthorizationFormat(built.payload, requirements("text-v1"), ["binary", "text-v1"]),
    ).not.toThrow();
    expect(() =>
      assertBatchAuthorizationFormat(
        { ...built.payload, authorization: { ...textProof(), format: undefined } },
        requirements("text-v1"),
        ["text-v1"],
      ),
    ).toThrow(/does not match/);
    expect(() =>
      assertBatchAuthorizationFormat(built.payload, requirements("bad" as never), ["text-v1"]),
    ).toThrow(/unsupported/);
  });
  it("requires facilitator capability before the merchant advertises readable proofs", async () => {
    const server = new Server({
      operator,
      receiverAuthorizer: receiver,
      authorizationFormat: "text-v1",
    });
    const supported = {
      scheme: "batch-settlement",
      network: SOLANA_DEVNET_CAIP2,
      x402Version: 2,
      extra: { feePayer: feePayer.address },
    };
    expect(() => server.enhancePaymentRequirements(requirements(), supported, [])).toThrow(
      /does not advertise/,
    );
    const enriched = await server.enhancePaymentRequirements(
      requirements(),
      { ...supported, extra: { ...supported.extra, authorizationFormats: ["binary", "text-v1"] } },
      [],
    );
    expect(enriched.extra?.authorizationFormat).toBe("text-v1");
    expect(() =>
      server.enhancePaymentRequirements(
        { ...requirements(), extra: { ...requirements().extra, authorizationFormat: null } },
        {
          ...supported,
          extra: { ...supported.extra, authorizationFormats: ["binary", "text-v1"] },
        },
        [],
      ),
    ).toThrow(/unsupported/);
    const binaryServer = new Server({ operator, receiverAuthorizer: receiver });
    expect(() =>
      binaryServer.enhancePaymentRequirements(
        requirements(),
        { ...supported, extra: { ...supported.extra, authorizationFormats: ["text-v1"] } },
        [],
      ),
    ).toThrow(/does not advertise/);
  });
  it("enforces format policy at the real facilitator verify and settle entry points", async () => {
    const signer = {
      getAddresses: () => [feePayer.address],
      getSigner: () => feePayer,
      getAccountInfo: vi.fn().mockResolvedValue(null),
      getLatestBlockhash: vi.fn(),
      getSlot: vi.fn(),
      sendTransaction: vi.fn(),
      signTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
    };
    const payment = { x402Version: 2, accepted: requirements("text-v1"), payload: built.payload };
    const legacy = new Facilitator(signer);
    expect((await legacy.verify(payment, payment.accepted)).invalidMessage).toMatch(/not enabled/);
    expect((await legacy.settle(payment, payment.accepted)).errorMessage).toMatch(/not enabled/);
    expect(signer.sendTransaction).not.toHaveBeenCalled();
    const enabled = new Facilitator(signer, { authorizationFormats: ["binary", "text-v1"] });
    expect(enabled.getExtra(SOLANA_DEVNET_CAIP2).authorizationFormats).toEqual([
      "binary",
      "text-v1",
    ]);
    const mismatched = {
      ...payment,
      payload: { ...built.payload, authorization: { ...textProof(), format: undefined } },
    };
    expect((await enabled.verify(mismatched, payment.accepted)).invalidMessage).toMatch(
      /does not match/,
    );
    expect((await enabled.settle(mismatched, payment.accepted)).errorMessage).toMatch(
      /does not match/,
    );
    const unknown = requirements("future-format" as never);
    expect(await enabled.verify(payment, unknown)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_batch_settlement_svm_voucher_signature",
    });
    expect(await enabled.settle(payment, unknown)).toMatchObject({
      success: false,
      errorReason: "invalid_batch_settlement_svm_voucher_signature",
    });
    expect(signer.getAccountInfo).not.toHaveBeenCalled();
    expect(signer.sendTransaction).not.toHaveBeenCalled();
  });
  it("runs a readable deposit and metered authorization through merchant hooks", async () => {
    const store = new MemoryChannelStore();
    const server = new Server({
      operator,
      receiverAuthorizer: receiver,
      store,
      authorizationFormat: "text-v1",
    });
    const req = requirements("text-v1");
    const payment = { x402Version: 2, accepted: req, payload: built.payload };
    const ctx = { declaredExtensions: {}, paymentPayload: payment, requirements: req };
    const disabled = new Server({ operator, receiverAuthorizer: receiver });
    await expect(disabled.schemeHooks.onBeforeVerify!(ctx)).resolves.toMatchObject({ abort: true });
    await expect(server.schemeHooks.onBeforeVerify!(ctx)).resolves.toBeUndefined();
    await server.schemeHooks.onAfterVerify!({
      ...ctx,
      result: { isValid: true, payer: payer.address },
    });
    await server.schemeHooks.onAfterSettle!({
      ...ctx,
      phase: "after-handler",
      result: {
        success: true,
        network: SOLANA_DEVNET_CAIP2,
        transaction: "offline-open",
        extra: { channelState: { balance: "10000", totalClaimed: "0", withdrawRequestedAt: 0 } },
      },
    });
    expect(await store.get(built.channelId)).toMatchObject({ chargedCumulativeAmount: 1000n });
    const authorization = await built.tracker.authorization(
      "steady-readable",
      1000n,
      expiry,
      "text-v1",
    );
    const steady = {
      ...ctx,
      paymentPayload: {
        ...payment,
        payload: {
          type: "authorization",
          channelConfig: built.payload.channelConfig,
          authorization,
        },
      },
    };
    const verified = await server.schemeHooks.onBeforeVerify!(steady);
    expect(verified).toMatchObject({ skip: true, result: { isValid: true } });
    await server.schemeHooks.onAfterVerify!({
      ...steady,
      result: { isValid: true, payer: payer.address },
    });
    await expect(
      server.schemeHooks.onBeforeSettle!({
        ...steady,
        requirements: { ...req, amount: "400" },
        phase: "after-handler",
      }),
    ).resolves.toMatchObject({
      skip: true,
      result: { success: true, extra: { chargedAmount: "400" } },
    });
    expect(await store.get(built.channelId)).toMatchObject({ chargedCumulativeAmount: 1400n });
  });
});

describe("connected browser signer", () => {
  it("binds prototype transaction and message methods to the connected wallet", async () => {
    class Wallet {
      readonly address = payer.address;
      readonly #signer = payer;
      signTransactions(...args: Parameters<typeof payer.signTransactions>) {
        return this.#signer.signTransactions(...args);
      }
      async modifyAndSignMessages(messages: readonly ReturnType<typeof createSignableMessage>[]) {
        const signatures = await this.#signer.signMessages(messages);
        return messages.map((message, i) => ({ ...message, signatures: signatures[i] }));
      }
    }
    const adapted = toBatchClientSigner(new Wallet());
    expect("modifyAndSignMessages" in adapted).toBe(false);
    expect("signTransactions" in adapted).toBe(true);
    if ("signTransactions" in adapted) {
      await expect(adapted.signTransactions([])).resolves.toEqual([]);
    }
    await expect(
      adapted.signMessages([createSignableMessage(encodeBatchAuthorizationMessage(fields()))]),
    ).resolves.toHaveLength(1);
  });

  it("exposes only the independently verified message path to Kit dispatch", async () => {
    const bytes = encodeBatchAuthorizationMessage({ ...fields(), format: "binary" });
    const wallet = {
      address: payer.address,
      signTransactions: payer.signTransactions,
      modifyAndSignMessages: async (
        messages: readonly ReturnType<typeof createSignableMessage>[],
      ) => {
        const signatures = await payer.signMessages(
          messages.map(message =>
            createSignableMessage(snapConvert(new Uint8Array(message.content))),
          ),
        );
        return messages.map((message, i) => ({ ...message, signatures: signatures[i] }));
      },
    };
    const adapted = toBatchClientSigner(wallet);
    expect("modifyAndSignMessages" in adapted).toBe(false);
    expect(isMessageModifyingSigner(adapted)).toBe(false);
    expect(isMessagePartialSigner(adapted)).toBe(true);
    await expect(adapted.signMessages([createSignableMessage(bytes)])).rejects.toThrow(
      /original batch/,
    );
  });

  it("rejects the actual captured MetaMask signature despite an unchanged returned message", async () => {
    const fixture = metamaskCapture;
    const original = Buffer.from(fixture.originalHex, "hex");
    const returned = Buffer.from(fixture.returnedHex, "hex");
    const candidate = Buffer.from(fixture.utf8CandidateHex, "hex");
    const signature = new Uint8Array(getBase58Encoder().encode(fixture.signatureBase58));
    const publicKey = new Uint8Array(getBase58Encoder().encode(fixture.fields.payer));
    expect(
      encodeBatchAuthorizationMessage({
        ...fixture.fields,
        authorizedAmount: BigInt(fixture.fields.authorizedAmount),
      }),
    ).toEqual(new Uint8Array(original));
    expect(returned).toEqual(original);
    expect(snapConvert(original)).toEqual(new Uint8Array(candidate));
    expect(await verifyEd25519Signature({ signature, publicKey, message: original })).toBe(false);
    expect(await verifyEd25519Signature({ signature, publicKey, message: returned })).toBe(false);
    expect(await verifyEd25519Signature({ signature, publicKey, message: candidate })).toBe(true);
    const wallet = {
      address: address(fixture.fields.payer),
      signTransactions: async () => [],
      modifyAndSignMessages: async () => [
        {
          content: new Uint8Array(returned),
          signatures: { [fixture.fields.payer]: signature as never },
        },
      ],
    };
    await expect(
      toBatchClientSigner(wallet).signMessages([createSignableMessage(original)]),
    ).rejects.toThrow(/original batch/);
  });

  it("rejects modified content and incomplete signature responses", async () => {
    const bytes = encodeBatchAuthorizationMessage(fields());
    const wallet = {
      address: payer.address,
      signTransactions: payer.signTransactions,
      modifyAndSignMessages: async (
        messages: readonly ReturnType<typeof createSignableMessage>[],
      ) => {
        (messages[0].content as Uint8Array)[0] ^= 1;
        const signatures = await payer.signMessages(messages);
        return messages.map((message, i) => ({ ...message, signatures: signatures[i] }));
      },
    };
    await expect(
      toBatchClientSigner(wallet).signMessages([createSignableMessage(bytes)]),
    ).rejects.toThrow(/modified/);
    await expect(
      toBatchClientSigner({ ...payer, signMessages: async () => [] }).signMessages([
        createSignableMessage(bytes),
      ]),
    ).rejects.toThrow(/incomplete/);
    await expect(
      toBatchClientSigner({ ...payer, signMessages: async () => [{}] }).signMessages([
        createSignableMessage(bytes),
      ]),
    ).rejects.toThrow(/original batch/);
  });

  it("accepts both Kit partial and modifying signers", async () => {
    const bytes = encodeBatchAuthorizationMessage(fields());
    const partial = toBatchClientSigner(payer);
    const wallet = {
      address: payer.address,
      signTransactions: payer.signTransactions,
      modifyAndSignMessages: async (
        messages: readonly ReturnType<typeof createSignableMessage>[],
      ) => {
        const signatures = await payer.signMessages(messages);
        return messages.map((message, i) => ({ ...message, signatures: signatures[i] }));
      },
    };
    await expect(partial.signMessages([createSignableMessage(bytes)])).resolves.toHaveLength(1);
    await expect(
      toBatchClientSigner(wallet).signMessages([createSignableMessage(bytes)]),
    ).resolves.toHaveLength(1);
  });
  it("rejects signatures over converted bytes even when the wallet echoes originals", async () => {
    const binary = encodeBatchAuthorizationMessage({ ...fields(), format: "binary" });
    const lyingWallet = {
      ...payer,
      signMessages: async (messages: readonly ReturnType<typeof createSignableMessage>[]) =>
        payer.signMessages(
          messages.map(message =>
            createSignableMessage(snapConvert(new Uint8Array(message.content))),
          ),
        ),
    };
    await expect(
      toBatchClientSigner(lyingWallet).signMessages([createSignableMessage(binary)]),
    ).rejects.toThrow(/original batch/);
    await expect(
      toBatchClientSigner(lyingWallet).signMessages([
        createSignableMessage(encodeBatchAuthorizationMessage(fields())),
      ]),
    ).resolves.toHaveLength(1);
  });
  it("keeps an independent original when a partial signer mutates its input", async () => {
    const bytes = encodeBatchAuthorizationMessage(fields());
    const original = new Uint8Array(bytes);
    const mutating = {
      ...payer,
      signMessages: async (messages: readonly ReturnType<typeof createSignableMessage>[]) => {
        (messages[0].content as Uint8Array)[0] ^= 1;
        return payer.signMessages(messages);
      },
    };
    await expect(
      toBatchClientSigner(mutating).signMessages([createSignableMessage(bytes)]),
    ).rejects.toThrow(/original batch/);
    expect(bytes).toEqual(original);
  });
});
