import { describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenId,
  TopicCreateTransaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { ExactHederaScheme } from "../../src/exact/facilitator/scheme";
import { HEDERA_MAINNET_USDC, HEDERA_TESTNET_USDC } from "../../src/constants";

const baseRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.6001",
  amount: "1000",
  payTo: "0.0.7001",
  maxTimeoutSeconds: 180,
  extra: { feePayer: "0.0.5001" },
};

const basePayload: PaymentPayload = {
  x402Version: 2,
  resource: {
    url: "https://example.com",
    description: "resource",
    mimeType: "application/json",
  },
  accepted: baseRequirements,
  payload: {
    transaction: "",
  },
};

function createSigner() {
  return {
    getAddresses: () => ["0.0.5001"],
    signAndSubmitTransaction: vi.fn(async () => ({
      transactionId: "0.0.5001@1700000001.000000000",
    })),
    resolveAccount: vi.fn(async () => ({ exists: true, isAlias: false })),
  };
}

async function createTransferTransactionBase64(args: {
  feePayer: string;
  payer: string;
  payTo: string;
  asset: string;
  amount: string;
}): Promise<string> {
  const tx = new TransferTransaction();
  const amount = BigInt(args.amount);

  if (args.asset === "0.0.0") {
    tx.addHbarTransfer(AccountId.fromString(args.payer), Hbar.fromTinybars((-amount).toString()));
    tx.addHbarTransfer(AccountId.fromString(args.payTo), Hbar.fromTinybars(amount.toString()));
  } else {
    const tokenId = TokenId.fromString(args.asset);
    tx.addTokenTransfer(tokenId, AccountId.fromString(args.payer), (-amount).toString());
    tx.addTokenTransfer(tokenId, AccountId.fromString(args.payTo), amount.toString());
  }

  tx.setTransactionId(TransactionId.generate(AccountId.fromString(args.feePayer)));
  await tx.freezeWith(Client.forTestnet());
  return Buffer.from(tx.toBytes()).toString("base64");
}

async function createTopicTransactionBase64(args: { feePayer: string }): Promise<string> {
  const tx = new TopicCreateTransaction();
  tx.setTransactionId(TransactionId.generate(AccountId.fromString(args.feePayer)));
  tx.setTopicMemo("x402-non-transfer");
  const key = PrivateKey.generateED25519();
  tx.setSubmitKey(key.publicKey);
  await tx.freezeWith(Client.forTestnet());
  return Buffer.from(tx.toBytes()).toString("base64");
}

describe("ExactHedera facilitator scheme", () => {
  it("verifies a valid payload", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload: PaymentPayload = {
      ...basePayload,
      payload: {
        transaction: await createTransferTransactionBase64({
          feePayer: "0.0.5001",
          payer: "0.0.9001",
          payTo: "0.0.7001",
          asset: "0.0.6001",
          amount: "1000",
        }),
      },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("0.0.9001");
  });

  it("rejects unsupported token transfers", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload: PaymentPayload = {
      ...basePayload,
      payload: {
        transaction: await createTransferTransactionBase64({
          feePayer: "0.0.5001",
          payer: "0.0.9001",
          payTo: "0.0.7001",
          asset: "0.0.1234",
          amount: "1000",
        }),
      },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_asset_mismatch");
  });

  it("enforces alias rejection by default", async () => {
    const signer = createSigner();
    signer.resolveAccount = vi.fn(async () => ({ exists: false, isAlias: true }));
    const scheme = new ExactHederaScheme(signer);
    const payload: PaymentPayload = {
      ...basePayload,
      payload: {
        transaction: await createTransferTransactionBase64({
          feePayer: "0.0.5001",
          payer: "0.0.9001",
          payTo: "0.0.7001",
          asset: "0.0.6001",
          amount: "1000",
        }),
      },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_pay_to_alias_not_allowed");
  });

  it("can allow aliases when configured", async () => {
    const signer = createSigner();
    signer.resolveAccount = vi.fn(async () => ({ exists: false, isAlias: true }));
    const aliasPayTo = "0x000000000000000000000000000000000000abcd";
    const aliasRequirements = {
      ...baseRequirements,
      payTo: aliasPayTo,
    };
    const aliasPayload = {
      ...basePayload,
      accepted: aliasRequirements,
      payload: {
        transaction: await createTransferTransactionBase64({
          feePayer: "0.0.5001",
          payer: "0.0.9001",
          payTo: aliasPayTo,
          asset: "0.0.6001",
          amount: "1000",
        }),
      },
    };
    const scheme = new ExactHederaScheme(signer, { aliasPolicy: "allow" });

    const result = await scheme.verify(aliasPayload, aliasRequirements);
    expect(result.isValid).toBe(true);
  });

  it("rejects undecodable transaction payload", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload: PaymentPayload = {
      ...basePayload,
      payload: {
        transaction: "not-a-valid-hedera-transaction",
      },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_hedera_payload_transaction_could_not_be_decoded",
    );
  });

  it("settles when verify passes", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload: PaymentPayload = {
      ...basePayload,
      payload: {
        transaction: await createTransferTransactionBase64({
          feePayer: "0.0.5001",
          payer: "0.0.9001",
          payTo: "0.0.7001",
          asset: "0.0.6001",
          amount: "1000",
        }),
      },
    };

    const settled = await scheme.settle(payload, baseRequirements);
    expect(settled.success).toBe(true);
    expect(settled.transaction).toContain("0.0.5001@");
  });

  it("rejects unsupported scheme", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload: PaymentPayload = {
      ...basePayload,
      accepted: { ...baseRequirements, scheme: "something-else" },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("unsupported_scheme");
  });

  it("rejects accepted requirements mismatch", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload: PaymentPayload = {
      ...basePayload,
      accepted: { ...baseRequirements, amount: "999" },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("accepted_payment_requirements_mismatch");
  });

  it("rejects network mismatch", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload: PaymentPayload = {
      ...basePayload,
      accepted: { ...baseRequirements, network: "hedera:mainnet" },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("network_mismatch");
  });

  it("returns invalid response for unsupported network value", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const invalidNetworkRequirements = {
      ...baseRequirements,
      network: "eip155:1",
    } as unknown as PaymentRequirements;
    const payload: PaymentPayload = {
      ...basePayload,
      accepted: invalidNetworkRequirements,
    };

    const result = await scheme.verify(payload, invalidNetworkRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("network_mismatch");
  });

  it("rejects invalid asset in requirements", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const invalidRequirements = { ...baseRequirements, asset: "invalid-asset" };
    const payload = { ...basePayload, accepted: invalidRequirements };

    const result = await scheme.verify(payload, invalidRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_asset");
  });

  it("rejects invalid amount in requirements", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const invalidRequirements = { ...baseRequirements, amount: "1.23" };
    const payload = { ...basePayload, accepted: invalidRequirements };

    const result = await scheme.verify(payload, invalidRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_amount");
  });

  it("rejects missing feePayer in requirements", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const invalidRequirements = { ...baseRequirements, extra: {} };
    const payload = { ...basePayload, accepted: invalidRequirements };

    const result = await scheme.verify(payload, invalidRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_missing_fee_payer");
  });

  it("rejects feePayer not managed by facilitator", async () => {
    const signer = createSigner();
    signer.getAddresses = () => ["0.0.9999"];
    const scheme = new ExactHederaScheme(signer);

    const result = await scheme.verify(basePayload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("fee_payer_not_managed_by_facilitator");
  });

  it("rejects transaction fee payer mismatch", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload: PaymentPayload = {
      ...basePayload,
      payload: {
        transaction: await createTransferTransactionBase64({
          feePayer: "0.0.5002",
          payer: "0.0.9001",
          payTo: "0.0.7001",
          asset: "0.0.6001",
          amount: "1000",
        }),
      },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_fee_payer_mismatch");
  });

  it("rejects non-transfer transaction types", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const payload: PaymentPayload = {
      ...basePayload,
      payload: { transaction: await createTopicTransactionBase64({ feePayer: "0.0.5001" }) },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_contains_non_transfer_ops");
  });

  it("rejects non-zero hbar transfer sum", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const tx = new TransferTransaction();
    tx.addHbarTransfer(AccountId.fromString("0.0.9001"), Hbar.fromTinybars("-1000"));
    tx.addHbarTransfer(AccountId.fromString("0.0.7001"), Hbar.fromTinybars("900"));
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.9001"), "-1000");
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.7001"), "1000");
    tx.setTransactionId(TransactionId.generate(AccountId.fromString("0.0.5001")));
    await tx.freezeWith(Client.forTestnet());
    const payload: PaymentPayload = {
      ...basePayload,
      payload: { transaction: Buffer.from(tx.toBytes()).toString("base64") },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_hbar_sum_non_zero");
  });

  it("rejects token payment payloads that include hbar transfers", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const tx = new TransferTransaction();
    tx.addHbarTransfer(AccountId.fromString("0.0.9001"), Hbar.fromTinybars("-10"));
    tx.addHbarTransfer(AccountId.fromString("0.0.7001"), Hbar.fromTinybars("10"));
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.9001"), "-1000");
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.7001"), "1000");
    tx.setTransactionId(TransactionId.generate(AccountId.fromString("0.0.5001")));
    await tx.freezeWith(Client.forTestnet());
    const payload: PaymentPayload = {
      ...basePayload,
      payload: { transaction: Buffer.from(tx.toBytes()).toString("base64") },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_unexpected_hbar_transfers");
  });

  it("rejects feePayer sending hbar", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const tx = new TransferTransaction();
    tx.addHbarTransfer(AccountId.fromString("0.0.5001"), Hbar.fromTinybars("-10"));
    tx.addHbarTransfer(AccountId.fromString("0.0.9001"), Hbar.fromTinybars("10"));
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.9001"), "-1000");
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.7001"), "1000");
    tx.setTransactionId(TransactionId.generate(AccountId.fromString("0.0.5001")));
    await tx.freezeWith(Client.forTestnet());
    const payload: PaymentPayload = {
      ...basePayload,
      payload: { transaction: Buffer.from(tx.toBytes()).toString("base64") },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_fee_payer_transferring_hbar");
  });

  it("rejects non-zero asset transfer sum", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const tx = new TransferTransaction();
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.9001"), "-1000");
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.7001"), "900");
    tx.setTransactionId(TransactionId.generate(AccountId.fromString("0.0.5001")));
    await tx.freezeWith(Client.forTestnet());
    const payload: PaymentPayload = {
      ...basePayload,
      payload: { transaction: Buffer.from(tx.toBytes()).toString("base64") },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_asset_sum_non_zero");
  });

  it("rejects feePayer sending requested asset", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const tx = new TransferTransaction();
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.5001"), "-1");
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.9001"), "-999");
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.7001"), "1000");
    tx.setTransactionId(TransactionId.generate(AccountId.fromString("0.0.5001")));
    await tx.freezeWith(Client.forTestnet());
    const payload: PaymentPayload = {
      ...basePayload,
      payload: { transaction: Buffer.from(tx.toBytes()).toString("base64") },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_fee_payer_transferring_funds");
  });

  it("rejects amount mismatch to payTo", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const tx = new TransferTransaction();
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.9001"), "-1000");
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.7001"), "999");
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.7002"), "1");
    tx.setTransactionId(TransactionId.generate(AccountId.fromString("0.0.5001")));
    await tx.freezeWith(Client.forTestnet());
    const payload: PaymentPayload = {
      ...basePayload,
      payload: { transaction: Buffer.from(tx.toBytes()).toString("base64") },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_amount_mismatch");
  });

  it("rejects extra positive recipients for requested asset", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const tx = new TransferTransaction();
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.9001"), "-1001");
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.7001"), "1000");
    tx.addTokenTransfer(TokenId.fromString("0.0.6001"), AccountId.fromString("0.0.7002"), "1");
    tx.setTransactionId(TransactionId.generate(AccountId.fromString("0.0.5001")));
    await tx.freezeWith(Client.forTestnet());
    const payload: PaymentPayload = {
      ...basePayload,
      payload: { transaction: Buffer.from(tx.toBytes()).toString("base64") },
    };

    const result = await scheme.verify(payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_extra_positive_transfers");
  });

  it("rejects invalid payTo format when aliases are rejected", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer, { aliasPolicy: "reject" });
    const badRequirements = { ...baseRequirements, payTo: "not-an-account" };
    const badPayload = { ...basePayload, accepted: badRequirements };

    const result = await scheme.verify(badPayload, badRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hedera_payload_pay_to");
  });

  it("returns failed settlement when verify fails", async () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const badRequirements = { ...baseRequirements, amount: "bad" };
    const badPayload = { ...basePayload, accepted: badRequirements };

    const settled = await scheme.settle(badPayload, badRequirements);
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe("invalid_amount");
  });

  it("returns transaction_failed when signAndSubmitTransaction throws", async () => {
    const signer = createSigner();
    signer.signAndSubmitTransaction = vi.fn(async () => {
      throw new Error("submit failed");
    });
    const scheme = new ExactHederaScheme(signer);
    const payload: PaymentPayload = {
      ...basePayload,
      payload: {
        transaction: await createTransferTransactionBase64({
          feePayer: "0.0.5001",
          payer: "0.0.9001",
          payTo: "0.0.7001",
          asset: "0.0.6001",
          amount: "1000",
        }),
      },
    };

    const settled = await scheme.settle(payload, baseRequirements);
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe("transaction_failed");
    expect(settled.errorMessage).toContain("submit failed");
  });

  it("returns managed signer addresses via getSigners", () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    expect(scheme.getSigners("hedera:testnet")).toEqual(["0.0.5001"]);
  });

  it("returns feePayer in getExtra", () => {
    const signer = createSigner();
    const scheme = new ExactHederaScheme(signer);
    const extra = scheme.getExtra("hedera:testnet");
    expect(extra).toEqual({ feePayer: "0.0.5001" });
  });

  it("returns undefined getExtra when no signer addresses are available", () => {
    const signer = createSigner();
    signer.getAddresses = () => [];
    const scheme = new ExactHederaScheme(signer);
    const extra = scheme.getExtra("hedera:testnet");
    expect(extra).toBeUndefined();
  });

  describe("preflightTransfer hook", () => {
    async function buildValidPayload(): Promise<PaymentPayload> {
      return {
        ...basePayload,
        payload: {
          transaction: await createTransferTransactionBase64({
            feePayer: "0.0.5001",
            payer: "0.0.9001",
            payTo: "0.0.7001",
            asset: "0.0.6001",
            amount: "1000",
          }),
        },
      };
    }

    it("passes payer/payTo/asset/amount/network to the hook", async () => {
      const signer = {
        ...createSigner(),
        preflightTransfer: vi.fn(async () => ({ ok: true })),
      };
      const scheme = new ExactHederaScheme(signer);
      const result = await scheme.verify(await buildValidPayload(), baseRequirements);
      expect(result.isValid).toBe(true);
      expect(signer.preflightTransfer).toHaveBeenCalledWith({
        payer: "0.0.9001",
        payTo: "0.0.7001",
        asset: "0.0.6001",
        amount: "1000",
        network: "hedera:testnet",
      });
    });

    it("fails verify when hook returns ok:false with a reason", async () => {
      const signer = {
        ...createSigner(),
        preflightTransfer: vi.fn(async () => ({
          ok: false,
          reason: "insufficient_balance",
          message: "payer has 500, needs 1000",
        })),
      };
      const scheme = new ExactHederaScheme(signer);
      const result = await scheme.verify(await buildValidPayload(), baseRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_hedera_payload_preflight_failed");
      expect(result.invalidMessage).toContain("insufficient_balance");
      expect(result.invalidMessage).toContain("payer has 500");
      expect(result.payer).toBe("0.0.9001");
    });

    it("fails verify when hook throws", async () => {
      const signer = {
        ...createSigner(),
        preflightTransfer: vi.fn(async () => {
          throw new Error("mirror node unreachable");
        }),
      };
      const scheme = new ExactHederaScheme(signer);
      const result = await scheme.verify(await buildValidPayload(), baseRequirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_hedera_payload_preflight_failed");
      expect(result.invalidMessage).toContain("mirror node unreachable");
    });

    it("settle surfaces preflight failure as error", async () => {
      const signer = {
        ...createSigner(),
        preflightTransfer: vi.fn(async () => ({ ok: false, reason: "pay_to_not_associated" })),
      };
      const scheme = new ExactHederaScheme(signer);
      const settled = await scheme.settle(await buildValidPayload(), baseRequirements);
      expect(settled.success).toBe(false);
      expect(settled.errorReason).toBe("invalid_exact_hedera_payload_preflight_failed");
      expect(settled.errorMessage).toContain("pay_to_not_associated");
      expect(signer.signAndSubmitTransaction).not.toHaveBeenCalled();
    });

    it("is a no-op when hook is not defined", async () => {
      const signer = createSigner();
      const scheme = new ExactHederaScheme(signer);
      const result = await scheme.verify(await buildValidPayload(), baseRequirements);
      expect(result.isValid).toBe(true);
    });
  });

  describe("settle on-chain receipt handling", () => {
    async function buildValidPayload(): Promise<PaymentPayload> {
      return {
        ...basePayload,
        payload: {
          transaction: await createTransferTransactionBase64({
            feePayer: "0.0.5001",
            payer: "0.0.9001",
            payTo: "0.0.7001",
            asset: "0.0.6001",
            amount: "1000",
          }),
        },
      };
    }

    it("treats a signer throwing after submit as transaction_failed and carries the receipt status in errorMessage", async () => {
      const signer = createSigner();
      // Simulates a live signer that executed and then called getReceipt(),
      // which in turn threw because consensus status was not SUCCESS.
      signer.signAndSubmitTransaction = vi.fn(async () => {
        throw new Error(
          "receipt for transaction 0.0.5001@1700000002.000000000 contained error status TOKEN_NOT_ASSOCIATED_TO_ACCOUNT",
        );
      });
      const scheme = new ExactHederaScheme(signer);

      const settled = await scheme.settle(await buildValidPayload(), baseRequirements);
      expect(settled.success).toBe(false);
      expect(settled.errorReason).toBe("transaction_failed");
      expect(settled.errorMessage).toContain("TOKEN_NOT_ASSOCIATED_TO_ACCOUNT");
      expect(settled.transaction).toBe("");
    });
  });

  describe.each([
    ["hedera:testnet", HEDERA_TESTNET_USDC],
    ["hedera:mainnet", HEDERA_MAINNET_USDC],
  ])("USDC verify + settle happy path on %s", (network, usdcAsset) => {
    const usdcRequirements: PaymentRequirements = {
      scheme: "exact",
      network: network as PaymentRequirements["network"],
      asset: usdcAsset,
      amount: "10000", // 0.01 USDC at 6 decimals
      payTo: "0.0.7001",
      maxTimeoutSeconds: 180,
      extra: { feePayer: "0.0.5001" },
    };
    const usdcBasePayload: PaymentPayload = {
      ...basePayload,
      accepted: usdcRequirements,
    };

    it("verifies a USDC transfer payload", async () => {
      const signer = createSigner();
      const scheme = new ExactHederaScheme(signer);
      const payload: PaymentPayload = {
        ...usdcBasePayload,
        payload: {
          transaction: await createTransferTransactionBase64({
            feePayer: "0.0.5001",
            payer: "0.0.9001",
            payTo: "0.0.7001",
            asset: usdcAsset,
            amount: "10000",
          }),
        },
      };

      const result = await scheme.verify(payload, usdcRequirements);
      expect(result.isValid).toBe(true);
      expect(result.payer).toBe("0.0.9001");
    });

    it("settles a USDC transfer payload", async () => {
      const signer = createSigner();
      const scheme = new ExactHederaScheme(signer);
      const payload: PaymentPayload = {
        ...usdcBasePayload,
        payload: {
          transaction: await createTransferTransactionBase64({
            feePayer: "0.0.5001",
            payer: "0.0.9001",
            payTo: "0.0.7001",
            asset: usdcAsset,
            amount: "10000",
          }),
        },
      };

      const settled = await scheme.settle(payload, usdcRequirements);
      expect(settled.success).toBe(true);
      expect(settled.transaction).toContain("0.0.5001@");
    });
  });
});
