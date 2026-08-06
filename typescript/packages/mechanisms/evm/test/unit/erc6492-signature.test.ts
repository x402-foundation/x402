import { describe, expect, it } from "vitest";
import { decodeAbiParameters, serializeErc6492Signature } from "viem";
import { PERMIT2_DEPOSIT_COLLECTOR_ADDRESS } from "../../src/batch-settlement/constants";
import { buildEip3009DepositCollectorData } from "../../src/batch-settlement/facilitator/deposit-eip3009";
import { buildPermit2DepositCollectorData } from "../../src/batch-settlement/facilitator/deposit-permit2";
import type { BatchSettlementDepositPayload } from "../../src/batch-settlement/types";
import { x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress } from "../../src/constants";
import { buildExactPermit2SettleArgs, buildUptoPermit2SettleArgs } from "../../src/shared/permit2";
import type { ExactPermit2Payload, UptoPermit2Payload } from "../../src/types";

const PAYER = "0x1234567890123456789012345678901234567890" as const;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const RECEIVER = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0" as const;
const FACILITATOR = "0xeF4f6ABbC1Cb87Aea6Cd86B5a4019fC6599178AC" as const;
const CHANNEL_ID = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const INNER_SIGNATURE = `0x${"ab".repeat(65)}` as `0x${string}`;
const WRAPPED_SIGNATURE = serializeErc6492Signature({
  address: "0xca11bde05977b3631167028862be2a173976ca11",
  data: "0xdeadbeef",
  signature: INNER_SIGNATURE,
});

function makeExactPermit2Payload(signature: `0x${string}`): ExactPermit2Payload {
  return {
    signature,
    permit2Authorization: {
      from: PAYER,
      permitted: { token: TOKEN, amount: "1000000" },
      spender: x402ExactPermit2ProxyAddress,
      nonce: "123",
      deadline: "9999999999",
      witness: { to: RECEIVER, validAfter: "0" },
    },
  };
}

function makeUptoPermit2Payload(signature: `0x${string}`): UptoPermit2Payload {
  return {
    signature,
    permit2Authorization: {
      from: PAYER,
      permitted: { token: TOKEN, amount: "1000000" },
      spender: x402UptoPermit2ProxyAddress,
      nonce: "123",
      deadline: "9999999999",
      witness: { to: RECEIVER, facilitator: FACILITATOR, validAfter: "0" },
    },
  };
}

function makeBatchDepositPayload(
  authorization: BatchSettlementDepositPayload["deposit"]["authorization"],
): BatchSettlementDepositPayload {
  return {
    type: "deposit",
    channelConfig: {
      payer: PAYER,
      payerAuthorizer: "0x0000000000000000000000000000000000000000",
      receiver: RECEIVER,
      receiverAuthorizer: FACILITATOR,
      token: TOKEN,
      withdrawDelay: 900,
      salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
    voucher: {
      channelId: CHANNEL_ID,
      maxClaimableAmount: "1000000",
      signature: INNER_SIGNATURE,
    },
    deposit: {
      amount: "1000000",
      authorization,
    },
  };
}

describe("ERC-6492 signatures in onchain calldata builders", () => {
  it("unwraps exact Permit2 signatures before building settle args", () => {
    const args = buildExactPermit2SettleArgs(makeExactPermit2Payload(WRAPPED_SIGNATURE));

    expect(args[3]).toBe(INNER_SIGNATURE);
  });

  it("unwraps upto Permit2 signatures before building settle args", () => {
    const args = buildUptoPermit2SettleArgs(
      makeUptoPermit2Payload(WRAPPED_SIGNATURE),
      1000000n,
      FACILITATOR,
    );

    expect(args[4]).toBe(INNER_SIGNATURE);
  });

  it("unwraps batch EIP-3009 signatures before encoding collector data", () => {
    const collectorData = buildEip3009DepositCollectorData(
      makeBatchDepositPayload({
        erc3009Authorization: {
          validAfter: "0",
          validBefore: "9999999999",
          salt: "0x01",
          signature: WRAPPED_SIGNATURE,
        },
      }),
    );

    const [, , , signature] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
      collectorData,
    );
    expect(signature).toBe(INNER_SIGNATURE);
  });

  it("unwraps batch Permit2 signatures before encoding collector data", () => {
    const collectorData = buildPermit2DepositCollectorData(
      makeBatchDepositPayload({
        permit2Authorization: {
          from: PAYER,
          permitted: { token: TOKEN, amount: "1000000" },
          spender: PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
          nonce: "123",
          deadline: "9999999999",
          witness: { channelId: CHANNEL_ID },
          signature: WRAPPED_SIGNATURE,
        },
      }),
    );

    const [, , signature] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes" }],
      collectorData,
    );
    expect(signature).toBe(INNER_SIGNATURE);
  });

  it("leaves non-wrapped batch EIP-3009 signatures unchanged", () => {
    const collectorData = buildEip3009DepositCollectorData(
      makeBatchDepositPayload({
        erc3009Authorization: {
          validAfter: "0",
          validBefore: "9999999999",
          salt: "0x01",
          signature: INNER_SIGNATURE,
        },
      }),
    );

    const [, , , signature] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
      collectorData,
    );
    expect(signature).toBe(INNER_SIGNATURE);
  });
});
