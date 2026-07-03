import { describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters, concat } from "viem";
import type { PaymentRequirements } from "@x402/core/types";
import { verifyEip3009DepositAuthorization } from "../../../src/batch-settlement/facilitator/deposit-eip3009";
import * as Errors from "../../../src/batch-settlement/errors";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type {
  BatchSettlementDepositPayload,
  ChannelConfig,
} from "../../../src/batch-settlement/types";

const ERC6492_MAGIC = "0x6492649264926492649264926492649264926492649264926492649264926492" as const;
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const FACTORY = "0xca11bde05977b3631167028862be2a173976ca11" as `0x${string}`;
const NETWORK = "eip155:84532";

function wrapErc6492(
  factory: `0x${string}`,
  factoryCalldata: `0x${string}`,
  inner: `0x${string}`,
): `0x${string}` {
  const encoded = encodeAbiParameters(parseAbiParameters("address, bytes, bytes"), [
    factory,
    factoryCalldata,
    inner,
  ]);
  return concat([encoded, ERC6492_MAGIC]);
}

function buildChannelConfig(): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: "0x1111111111111111111111111111111111111111",
    receiver: "0x9876543210987654321098765432109876543210",
    receiverAuthorizer: "0x2222222222222222222222222222222222222222",
    token: ASSET,
    withdrawDelay: 900,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
  };
}

function buildCounterfactualPayload(): BatchSettlementDepositPayload {
  const now = Math.floor(Date.now() / 1000);
  const inner = ("0x" + "33".repeat(65)) as `0x${string}`;
  return {
    type: "deposit",
    channelConfig: buildChannelConfig(),
    voucher: {
      channelId: ("0x" + "ab".repeat(32)) as `0x${string}`,
      maxClaimableAmount: "1000",
      signature: "0xcafebabe",
    },
    deposit: {
      amount: "1000",
      authorization: {
        erc3009Authorization: {
          validAfter: String(now - 600),
          validBefore: String(now + 3600),
          salt: ("0x" + "22".repeat(32)) as `0x${string}`,
          signature: wrapErc6492(FACTORY, "0xdeadbeef", inner),
        },
      },
    },
  };
}

function requirements(): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "1000",
    asset: ASSET,
    payTo: "0x9876543210987654321098765432109876543210",
    maxTimeoutSeconds: 3600,
    extra: { name: "USDC", version: "2" },
  } as PaymentRequirements;
}

function buildSigner(code: `0x${string}` | undefined): FacilitatorEvmSigner {
  return {
    getAddresses: () => ["0xFAC11174700123456789012345678901234aBCDe"],
    readContract: vi.fn().mockResolvedValue(undefined),
    verifyTypedData: vi.fn().mockResolvedValue(false),
    writeContract: vi.fn(),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    getCode: vi.fn().mockResolvedValue(code),
  } as unknown as FacilitatorEvmSigner;
}

describe("verifyEip3009DepositAuthorization — ERC-6492 counterfactual", () => {
  it("rejects an undeployed wallet whose factory is not allowlisted", async () => {
    const signer = buildSigner("0x"); // undeployed
    const result = await verifyEip3009DepositAuthorization(
      signer,
      buildCounterfactualPayload(),
      requirements(),
      84532,
      [], // empty allowlist
    );
    expect(result.counterfactual).toBeNull();
    expect(result.response?.invalidReason).toBe(Errors.ErrFactoryNotAllowed);
  });

  it("defers to simulation for an undeployed wallet with an allowlisted factory", async () => {
    const signer = buildSigner("0x"); // undeployed
    const result = await verifyEip3009DepositAuthorization(
      signer,
      buildCounterfactualPayload(),
      requirements(),
      84532,
      [FACTORY],
    );
    expect(result.response).toBeNull();
    expect(result.counterfactual).not.toBeNull();
    expect(result.counterfactual?.factory.toLowerCase()).toBe(FACTORY.toLowerCase());
    expect(result.counterfactual?.factoryCalldata).toBe("0xdeadbeef");
  });

  it("validates the inner signature directly when the wrapped wallet is already deployed", async () => {
    // Deployed wallet → EIP-1271 path. readContract isValidSignature returns the magic value
    // so the inner signature is accepted without any factory deployment.
    const signer = buildSigner("0x6080604052"); // has code
    (signer.readContract as ReturnType<typeof vi.fn>).mockImplementation(args =>
      args.functionName === "isValidSignature"
        ? Promise.resolve("0x1626ba7e")
        : Promise.resolve(undefined),
    );
    const result = await verifyEip3009DepositAuthorization(
      signer,
      buildCounterfactualPayload(),
      requirements(),
      84532,
      [], // allowlist irrelevant: wallet already deployed
    );
    expect(result.response).toBeNull();
    expect(result.counterfactual).toBeNull();
  });
});
