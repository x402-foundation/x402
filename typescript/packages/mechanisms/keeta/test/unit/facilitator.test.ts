import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import * as KeetaNet from "@keetanetwork/keetanet-client";
import { KeyPairKeyAlgorithm } from "@keetanetwork/keetanet-client/lib/account";
import { BlockOperations } from "@keetanetwork/keetanet-client/lib/block/operations";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { getNewKeetaAccount } from "./utils";
import { ExactKeetaScheme } from "../../src/exact/facilitator/scheme";
import { KEETA_MAINNET_CAIP2, KEETA_TESTNET_CAIP2 } from "../../src/constants";
import type { ExactKeetaPayload } from "../../src/types";
import { getUsdcAddress, KTA_TESTNET_ADDRESS } from "../../src/utils";

const TESTNET_NETWORK_ID = BigInt(KEETA_TESTNET_CAIP2.split(":")[1]);
const MAINNET_NETWORK_ID = BigInt(KEETA_MAINNET_CAIP2.split(":")[1]);
const AMOUNT = "1000000000";
const EXTERNAL = "ext-ref-abc123";
const FEE_PAYER_1 = getNewKeetaAccount().publicKeyString.toString();
const FEE_PAYER_2 = getNewKeetaAccount().publicKeyString.toString();
const KTA_TESTNET_TOKEN = KeetaNet.lib.Account.fromPublicKeyString(KTA_TESTNET_ADDRESS);

/**
 * Build and seal a signed block.
 */
async function buildSignedBlock(
  signerAccount: InstanceType<typeof KeetaNet.lib.Account<KeyPairKeyAlgorithm>>,
  networkId: bigint,
  operations: BlockOperations[],
  blockAccount?: InstanceType<typeof KeetaNet.lib.Account>,
  previous?: ReturnType<typeof KeetaNet.lib.Block.getAccountOpeningHash>,
): Promise<string> {
  const account = blockAccount ?? signerAccount;
  const builder = new KeetaNet.lib.Block.Builder();
  builder.network = networkId;
  builder.version = 2;
  builder.account = account;
  builder.signer = signerAccount;
  builder.previous = previous ?? KeetaNet.lib.Block.getAccountOpeningHash(account);
  builder.date = new Date();
  for (const op of operations) {
    builder.addOperation(op);
  }
  const block = await builder.seal();
  return Buffer.from(block.toBytes(true)).toString("base64");
}

describe("ExactKeetaFacilitator", () => {
  let payerAddress: string;
  let payerAccount: InstanceType<typeof KeetaNet.lib.Account<KeyPairKeyAlgorithm>>;
  let recipientAddress: string;
  let payerOpeningHashHex: string;
  let usdcTestnetAddress: string;

  // Different encoded blocks for specific test scenarios
  let sendOp: InstanceType<typeof KeetaNet.lib.Block.Operation.SEND>;
  // testnet, SEND, correct token/amount/recipient
  let encodedValidBlock: string;
  // same but includes external field
  let encodedValidBlockWithExternal: string;
  // signer != account
  let encodedDelegateSendBlock: string;
  // the account used as the delegate block's account (signer signs on its behalf)
  let delegateAccount: InstanceType<typeof KeetaNet.lib.Account>;

  let facilitator: ExactKeetaScheme;
  let mockKeetaClient: {
    getAccountInfo: ReturnType<typeof vi.fn>;
    listACLsByPrincipal: ReturnType<typeof vi.fn>;
  };
  let mockSigner: {
    getAddresses: () => string[];
    getKeetaUserClient: ReturnType<typeof vi.fn>;
    submitBlock: ReturnType<typeof vi.fn>;
    destroy: () => Promise<void>;
    [Symbol.asyncDispose]: () => Promise<void>;
  };

  function createValidPayload(blockStr?: string): PaymentPayload {
    return {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: KEETA_TESTNET_CAIP2,
        amount: AMOUNT,
        asset: KTA_TESTNET_ADDRESS,
        payTo: recipientAddress,
        maxTimeoutSeconds: 60,
        extra: {},
      },
      resource: {
        url: "https://example.com/api",
        description: "Test resource",
        mimeType: "application/json",
      },
      payload: { block: blockStr ?? encodedValidBlock } as ExactKeetaPayload,
    };
  }

  function createValidRequirements(
    overrides: Partial<PaymentRequirements> = {},
  ): PaymentRequirements {
    return {
      scheme: "exact",
      network: KEETA_TESTNET_CAIP2,
      amount: AMOUNT,
      asset: KTA_TESTNET_ADDRESS,
      payTo: recipientAddress,
      maxTimeoutSeconds: 60,
      extra: {},
      ...overrides,
    };
  }

  beforeAll(async () => {
    payerAccount = getNewKeetaAccount();
    payerAddress = payerAccount.publicKeyString.toString();
    payerOpeningHashHex = KeetaNet.lib.Block.getAccountOpeningHash(payerAccount).toString();

    const recipientAccount = getNewKeetaAccount();
    recipientAddress = recipientAccount.publicKeyString.toString();

    usdcTestnetAddress = await getUsdcAddress(KEETA_TESTNET_CAIP2);

    delegateAccount = getNewKeetaAccount();

    sendOp = new KeetaNet.lib.Block.Operation.SEND({
      type: KeetaNet.lib.Block.OperationType.SEND,
      to: recipientAddress,
      amount: AMOUNT,
      token: KTA_TESTNET_ADDRESS,
    });

    const sendOpWithExternal = new KeetaNet.lib.Block.Operation.SEND({
      type: KeetaNet.lib.Block.OperationType.SEND,
      to: recipientAddress,
      amount: AMOUNT,
      token: KTA_TESTNET_ADDRESS,
      external: EXTERNAL,
    });

    encodedValidBlock = await buildSignedBlock(payerAccount, TESTNET_NETWORK_ID, [sendOp]);
    encodedValidBlockWithExternal = await buildSignedBlock(payerAccount, TESTNET_NETWORK_ID, [
      sendOpWithExternal,
    ]);
    // Block where payerAccount signs on behalf of delegateAccount
    encodedDelegateSendBlock = await buildSignedBlock(
      payerAccount,
      TESTNET_NETWORK_ID,
      [sendOp],
      delegateAccount,
    );
  });

  beforeEach(() => {
    mockKeetaClient = {
      getAccountInfo: vi.fn().mockResolvedValue({
        balances: [
          {
            token: KTA_TESTNET_TOKEN,
            balance: BigInt(AMOUNT),
          },
        ],
        currentHeadBlock: payerOpeningHashHex,
      }),
      listACLsByPrincipal: vi.fn().mockResolvedValue([]),
    };

    mockSigner = {
      getAddresses: () => [FEE_PAYER_1],
      getKeetaUserClient: vi.fn().mockReturnValue({ client: mockKeetaClient }),
      submitBlock: vi.fn().mockResolvedValue("BLOCKHASH123"),
      destroy: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    };
    facilitator = new ExactKeetaScheme(mockSigner);
  });

  describe("Scheme", () => {
    it("has scheme set to exact", () => {
      expect(facilitator.scheme).toBe("exact");
    });

    it("should have caipFamily property set to keeta:*", () => {
      expect(facilitator.caipFamily).toBe("keeta:*");
    });
  });

  describe("getSigners", () => {
    it("returns addresses from signer", () => {
      expect(facilitator.getSigners(KEETA_TESTNET_CAIP2)).toEqual([FEE_PAYER_1]);
    });

    it("returns multiple addresses when configured", () => {
      const multiSigner = {
        getAddresses: () => [FEE_PAYER_1, FEE_PAYER_2],
        getKeetaUserClient: vi.fn(),
        submitBlock: vi.fn(),
        destroy: () => Promise.resolve(),
        [Symbol.asyncDispose]: () => Promise.resolve(),
      };
      expect(new ExactKeetaScheme(multiSigner).getSigners(KEETA_TESTNET_CAIP2)).toEqual([
        FEE_PAYER_1,
        FEE_PAYER_2,
      ]);
    });
  });

  describe("getExtra", () => {
    it("returns undefined", () => {
      expect(facilitator.getExtra(KEETA_TESTNET_CAIP2)).toBeUndefined();
    });
  });

  describe("verify - valid payload", () => {
    it("returns isValid true with the payer address for a correct payment", async () => {
      const result = await facilitator.verify(createValidPayload(), createValidRequirements());

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(payerAddress);
      expect(result.invalidReason).toBeUndefined();
    });

    it("succeeds when block has an external field but requirements do not require it", async () => {
      const result = await facilitator.verify(
        createValidPayload(encodedValidBlockWithExternal),
        createValidRequirements(),
      );

      expect(result.isValid).toBe(true);
    });

    it("succeeds when external field matches requirements.extra.external exactly", async () => {
      const result = await facilitator.verify(
        createValidPayload(encodedValidBlockWithExternal),
        createValidRequirements({ extra: { external: EXTERNAL } }),
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe("verify - x402Version check", () => {
    it("rejects when x402Version != 2", async () => {
      const payload = createValidPayload();
      payload.x402Version = 1;
      const result = await facilitator.verify(payload, createValidRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_unsupported_version");
    });
  });

  describe("verify - scheme check", () => {
    it("rejects when payload.accepted.scheme is not exact", async () => {
      const payload = createValidPayload();
      payload.accepted.scheme = "other";
      const result = await facilitator.verify(payload, createValidRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_scheme");
    });

    it("rejects when requirements.scheme is not exact", async () => {
      const result = await facilitator.verify(
        createValidPayload(),
        createValidRequirements({ scheme: "other" }),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_scheme");
    });
  });

  describe("verify - requirements.network format", () => {
    it.each<[string, string, string]>([
      ["no colon separator", "keetaX123", "invalid_exact_keeta_requirements_network_malformed"],
      [
        "more than one colon",
        "keeta:1:extra",
        "invalid_exact_keeta_requirements_network_malformed",
      ],
      ["non-integer network ID", "keeta:notanumber", "invalid_exact_keeta_requirements_network_id"],
      ["decimal (non-integer) ID", "keeta:3.14", "invalid_exact_keeta_requirements_network_id"],
    ])("rejects when requirements.network has %s", async (_label, network, invalidReason) => {
      const result = await facilitator.verify(
        createValidPayload(),
        createValidRequirements({ network: network as `${string}:${string}` }),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(invalidReason);
    });
  });

  describe("verify - network check (payload vs requirements)", () => {
    it("rejects when payload.accepted.network does not match requirements.network", async () => {
      const payload = createValidPayload();
      payload.accepted.network = KEETA_MAINNET_CAIP2;
      const result = await facilitator.verify(
        payload,
        createValidRequirements({ network: KEETA_TESTNET_CAIP2 }),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("network_mismatch");
    });
  });

  describe("verify - block decoding", () => {
    it("rejects when block string is not valid DER (cannot be decoded)", async () => {
      const result = await facilitator.verify(
        createValidPayload("not-valid-base64-der"),
        createValidRequirements(),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_block_could_not_be_decoded");
    });

    it("rejects when block has an invalid signature", async () => {
      // Build a block with an invalid signature by replacing only the signature bytes.
      // Strategy: locate the signature in the signed block's DER encoding by finding
      // the raw signature value (from the block's JSON), then flip those bytes.
      // This guarantees we corrupt only the signature, not any other block content.
      const validBlock = new KeetaNet.lib.Block(encodedValidBlock);
      const sigHex = validBlock.signatures[0].toString("hex");
      const signedBytes = Buffer.from(validBlock.toBytes(true));
      const sigBytes = Buffer.from(sigHex, "hex");
      const sigOffset = signedBytes.indexOf(sigBytes);
      if (sigOffset === -1) {
        throw new Error("Could not locate signature bytes in signed block DER encoding");
      }
      const tamperedBytes = Buffer.from(signedBytes);
      for (let i = sigOffset; i < sigOffset + sigBytes.length; i++) {
        tamperedBytes[i] = tamperedBytes[i] ^ 0xff;
      }

      const encodedTamperedSignatureBlock = tamperedBytes.toString("base64");

      const result = await facilitator.verify(
        createValidPayload(encodedTamperedSignatureBlock),
        createValidRequirements(),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_block_could_not_be_decoded");
    });

    it("rejects when block network does not match CAIP-2 network ID", async () => {
      const encodedMainnetBlock = await buildSignedBlock(payerAccount, MAINNET_NETWORK_ID, [
        sendOp,
      ]);

      // encodedMainnetBlock was signed for mainnet; requirements say testnet
      const result = await facilitator.verify(
        createValidPayload(encodedMainnetBlock),
        createValidRequirements({ network: KEETA_TESTNET_CAIP2 }),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("network_mismatch");
    });
  });

  describe("verify - operations count check", () => {
    it("rejects when block has more than one operation", async () => {
      const encodedTwoOpsBlock = await buildSignedBlock(payerAccount, TESTNET_NETWORK_ID, [
        sendOp,
        sendOp,
      ]);

      const result = await facilitator.verify(
        createValidPayload(encodedTwoOpsBlock),
        createValidRequirements(),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_operations_length");
    });
  });

  describe("verify - operation type check", () => {
    it("rejects when operation type is not SEND", async () => {
      const setRepOp = new KeetaNet.lib.Block.Operation.SET_REP({
        type: KeetaNet.lib.Block.OperationType.SET_REP,
        to: recipientAddress,
      });
      const encodedNonSendBlock = await buildSignedBlock(payerAccount, TESTNET_NETWORK_ID, [
        setRepOp,
      ]);

      const result = await facilitator.verify(
        createValidPayload(encodedNonSendBlock),
        createValidRequirements(),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_payment_operation_type");
    });
  });

  describe("verify - token/asset check", () => {
    it("rejects when requirements.asset does not match the block token", async () => {
      const usdcAddress = await getUsdcAddress(KEETA_TESTNET_CAIP2);

      // Block pays KTA_TESTNET_ADDRESS; requirements ask for USDC_TESTNET_ADDRESS
      const result = await facilitator.verify(
        createValidPayload(),
        createValidRequirements({ asset: usdcAddress }),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_payment_asset_mismatch");
    });
  });

  describe("verify - amount check", () => {
    it("rejects when requirements.amount does not match the block amount", async () => {
      // Block has AMOUNT; requirements ask for a different amount
      const result = await facilitator.verify(
        createValidPayload(),
        createValidRequirements({ amount: "999999" }),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_payment_amount_mismatch");
    });

    it("rejects when requirements.amount is not a valid BigInt", async () => {
      const result = await facilitator.verify(
        createValidPayload(),
        createValidRequirements({ amount: "not-a-number" }),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_payment_amount_invalid");
    });

    it("accepts when requirements.amount exactly matches the block amount", async () => {
      const result = await facilitator.verify(createValidPayload(), createValidRequirements());
      expect(result.isValid).toBe(true);
    });
  });

  describe("verify - recipient (to) check", () => {
    it("rejects when requirements.payTo does not match the block recipient", async () => {
      // payer != recipient
      const differentAddress = payerAddress;
      const result = await facilitator.verify(
        createValidPayload(),
        createValidRequirements({ payTo: differentAddress }),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_payment_to_mismatch");
    });
  });

  describe("verify - external field check", () => {
    it("rejects when external is required but does not match block external", async () => {
      // encodedValidBlockWithExternal has external=EXTERNAL; requirements say something else
      const result = await facilitator.verify(
        createValidPayload(encodedValidBlockWithExternal),
        createValidRequirements({ extra: { external: "different-external-value" } }),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_payment_external_mismatch");
    });

    it("rejects when external is required but block has no external", async () => {
      // encodedValidBlock has no external; requirements require one
      const result = await facilitator.verify(
        createValidPayload(encodedValidBlock),
        createValidRequirements({ extra: { external: "required-value" } }),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_payment_external_mismatch");
    });
  });

  describe("verify - simulation: insufficient balance", () => {
    it("rejects when account has no token balance", async () => {
      mockKeetaClient.getAccountInfo.mockResolvedValue({
        balances: [],
        currentHeadBlock: payerOpeningHashHex,
      });

      const result = await facilitator.verify(createValidPayload(), createValidRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_insufficient_funds");
    });

    it("rejects when account balance is less than required amount", async () => {
      mockKeetaClient.getAccountInfo.mockResolvedValue({
        balances: [
          {
            token: KTA_TESTNET_TOKEN,
            balance: BigInt(AMOUNT) - 1n,
          },
        ],
        currentHeadBlock: payerOpeningHashHex,
      });

      const result = await facilitator.verify(createValidPayload(), createValidRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_insufficient_funds");
    });

    it("rejects when account has balance for a different token only", async () => {
      mockKeetaClient.getAccountInfo.mockResolvedValue({
        balances: [
          {
            // different token
            token: KeetaNet.lib.Account.fromPublicKeyString(usdcTestnetAddress),
            balance: BigInt(AMOUNT) * 10n,
          },
        ],
        currentHeadBlock: payerOpeningHashHex,
      });

      const result = await facilitator.verify(createValidPayload(), createValidRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_insufficient_funds");
    });
  });

  describe("verify - simulation: previous head mismatch", () => {
    it("rejects when account head block does not match block.previous", async () => {
      mockKeetaClient.getAccountInfo.mockResolvedValue({
        balances: [
          {
            token: KTA_TESTNET_TOKEN,
            balance: BigInt(AMOUNT),
          },
        ],
        currentHeadBlock: "0000000000000000000000000000000000000000000000000000000000000000",
      });

      const result = await facilitator.verify(createValidPayload(), createValidRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_previous_head_mismatch");
    });

    it("accepts when account is not opened yet and block.previous equals the account opening hash", async () => {
      // currentHeadBlock is null, account not yet opened on-chain
      mockKeetaClient.getAccountInfo.mockResolvedValue({
        balances: [
          {
            token: KTA_TESTNET_TOKEN,
            balance: BigInt(AMOUNT),
          },
        ],
        currentHeadBlock: null,
      });

      // encodedValidBlock was built with getAccountOpeningHash(payerAccount) as previous
      const result = await facilitator.verify(createValidPayload(), createValidRequirements());

      expect(result.isValid).toBe(true);
    });

    it("rejects when account is not opened yet and block.previous does not equal the account opening hash", async () => {
      // currentHeadBlock is null, account not yet opened on-chain
      mockKeetaClient.getAccountInfo.mockResolvedValue({
        balances: [
          {
            token: KTA_TESTNET_TOKEN,
            balance: BigInt(AMOUNT),
          },
        ],
        currentHeadBlock: null,
      });

      // Build a block whose previous is a different account's opening hash
      const otherAccount = getNewKeetaAccount();
      const encodedBlockWithWrongPrevious = await buildSignedBlock(
        payerAccount,
        TESTNET_NETWORK_ID,
        [sendOp],
        undefined,
        KeetaNet.lib.Block.getAccountOpeningHash(otherAccount),
      );

      const result = await facilitator.verify(
        createValidPayload(encodedBlockWithWrongPrevious),
        createValidRequirements(),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_previous_head_mismatch");
    });
  });

  describe("verify - simulation: signer permission check", () => {
    it("rejects when signer has no ACL entry for the block account", async () => {
      const delegateBlock = new KeetaNet.lib.Block(encodedDelegateSendBlock);
      mockKeetaClient.getAccountInfo.mockResolvedValue({
        balances: [
          {
            token: KTA_TESTNET_TOKEN,
            balance: BigInt(AMOUNT),
          },
        ],
        currentHeadBlock: delegateBlock.previous.toString(),
      });
      mockKeetaClient.listACLsByPrincipal.mockResolvedValue([]);

      const result = await facilitator.verify(
        createValidPayload(encodedDelegateSendBlock),
        createValidRequirements(),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_missing_permission");
    });

    it("rejects when signer ACL entry has neither OWNER nor SEND_ON_BEHALF flag", async () => {
      const delegateBlock = new KeetaNet.lib.Block(encodedDelegateSendBlock);
      mockKeetaClient.getAccountInfo.mockResolvedValue({
        balances: [
          {
            token: KTA_TESTNET_TOKEN,
            balance: BigInt(AMOUNT),
          },
        ],
        currentHeadBlock: delegateBlock.previous.toString(),
      });
      mockKeetaClient.listACLsByPrincipal.mockResolvedValue([
        {
          entity: delegateAccount,
          permissions: new KeetaNet.lib.Permissions(["ACCESS"]),
        },
      ]);

      const result = await facilitator.verify(
        createValidPayload(encodedDelegateSendBlock),
        createValidRequirements(),
      );

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_keeta_payload_missing_permission");
    });

    it("accepts when signer has OWNER permission for the block account", async () => {
      const delegateBlock = new KeetaNet.lib.Block(encodedDelegateSendBlock);
      mockKeetaClient.getAccountInfo.mockResolvedValue({
        balances: [
          {
            token: KTA_TESTNET_TOKEN,
            balance: BigInt(AMOUNT),
          },
        ],
        currentHeadBlock: delegateBlock.previous.toString(),
      });
      mockKeetaClient.listACLsByPrincipal.mockResolvedValue([
        {
          entity: delegateAccount,
          permissions: new KeetaNet.lib.Permissions(["OWNER"]),
        },
      ]);

      const result = await facilitator.verify(
        createValidPayload(encodedDelegateSendBlock),
        createValidRequirements(),
      );

      expect(result.isValid).toBe(true);
    });

    it("accepts when signer has SEND_ON_BEHALF permission for the block account", async () => {
      const delegateBlock = new KeetaNet.lib.Block(encodedDelegateSendBlock);
      mockKeetaClient.getAccountInfo.mockResolvedValue({
        balances: [
          {
            token: KTA_TESTNET_TOKEN,
            balance: BigInt(AMOUNT),
          },
        ],
        currentHeadBlock: delegateBlock.previous.toString(),
      });
      mockKeetaClient.listACLsByPrincipal.mockResolvedValue([
        {
          entity: delegateAccount,
          permissions: new KeetaNet.lib.Permissions(["SEND_ON_BEHALF"]),
        },
      ]);

      const result = await facilitator.verify(
        createValidPayload(encodedDelegateSendBlock),
        createValidRequirements(),
      );

      expect(result.isValid).toBe(true);
    });
  });

  describe("settle", () => {
    it("submits block and returns a success response for a valid payment", async () => {
      const blockHash = new KeetaNet.lib.Block(encodedValidBlock).hash.toString();
      mockSigner.submitBlock.mockResolvedValue(blockHash);

      const result = await facilitator.settle(createValidPayload(), createValidRequirements());

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(blockHash);
      expect(result.network).toBe(KEETA_TESTNET_CAIP2);
      expect(result.payer).toBe(payerAddress);
    });

    it("calls submitBlock with the fee payer address and the original encoded block", async () => {
      await facilitator.settle(createValidPayload(), createValidRequirements());

      expect(mockSigner.submitBlock).toHaveBeenCalledWith(
        FEE_PAYER_1,
        encodedValidBlock,
        KEETA_TESTNET_CAIP2,
      );
    });

    it("returns failure when verify fails (does not call submitBlock)", async () => {
      const payload = createValidPayload();
      payload.x402Version = 1;

      const result = await facilitator.settle(payload, createValidRequirements());

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("invalid_exact_keeta_payload_unsupported_version");
      expect(mockSigner.submitBlock).not.toHaveBeenCalled();
    });

    it("returns failure when submitBlock throws", async () => {
      mockSigner.submitBlock.mockRejectedValue(new Error("Network error"));

      const result = await facilitator.settle(createValidPayload(), createValidRequirements());

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("transaction_failed");
    });

    it("returns duplicate_block when the same block is settled while still pending", async () => {
      // Keep the first settlement in flight so the block stays pending
      mockSigner.submitBlock.mockImplementationOnce(() => new Promise<string>(() => {}));

      const first = facilitator.settle(createValidPayload(), createValidRequirements());

      // Let the first settlement register itself as pending before re-submitting
      await new Promise(r => setTimeout(r, 50));

      const duplicate = await facilitator.settle(createValidPayload(), createValidRequirements());

      expect(duplicate.success).toBe(false);
      expect(duplicate.errorReason).toBe("duplicate_block");
      void first;
    });

    it("selects a fee payer from multiple available addresses", async () => {
      const multiSigner = {
        getAddresses: () => [FEE_PAYER_1, FEE_PAYER_2],
        getKeetaUserClient: vi.fn().mockReturnValue({ client: mockKeetaClient }),
        submitBlock: vi.fn().mockResolvedValue("HASH"),
        destroy: () => Promise.resolve(),
        [Symbol.asyncDispose]: () => Promise.resolve(),
      };
      const facilitator = new ExactKeetaScheme(multiSigner);

      await facilitator.settle(createValidPayload(), createValidRequirements());

      expect(multiSigner.submitBlock).toHaveBeenCalledTimes(1);
      expect([FEE_PAYER_1, FEE_PAYER_2]).toContain(multiSigner.submitBlock.mock.calls[0][0]);
    });

    it("includes the payer address in the failure response when submitBlock throws", async () => {
      mockSigner.submitBlock.mockRejectedValue(new Error("timeout"));

      const result = await facilitator.settle(createValidPayload(), createValidRequirements());

      expect(result.success).toBe(false);
      expect(result.payer).toBe(payerAddress);
    });

    it("returns failure when no fee payer addresses are available", async () => {
      const emptySigner = {
        getAddresses: () => [] as string[],
        getKeetaUserClient: vi.fn().mockReturnValue({ client: mockKeetaClient }),
        submitBlock: vi.fn(),
        destroy: () => Promise.resolve(),
        [Symbol.asyncDispose]: () => Promise.resolve(),
      };
      const facilitator = new ExactKeetaScheme(emptySigner);

      const result = await facilitator.settle(createValidPayload(), createValidRequirements());

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("transaction_failed");
      expect(emptySigner.submitBlock).not.toHaveBeenCalled();
    });
  });
});
