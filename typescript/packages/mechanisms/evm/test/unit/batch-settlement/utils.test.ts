import { describe, it, expect } from "vitest";
import { decodeAbiParameters } from "viem";
import {
  channelIdBindingError,
  computeChannelId as computeChannelIdForNetwork,
  isCanonicalChannelId,
  normalizeChannelId,
} from "../../../src/batch-settlement/utils";
import {
  buildEip2612PermitData,
  buildErc3009CollectorData,
  buildErc3009DepositNonce,
  buildPermit2CollectorData,
} from "../../../src/batch-settlement/encoding";
import {
  channelIdsEqual,
  validateChannelConfig,
  erc3009AuthorizationTimeInvalidReason,
} from "../../../src/batch-settlement/facilitator/utils";
import {
  ErrChannelIdMismatch,
  ErrInvalidChannelId,
  ErrReceiverMismatch,
  ErrReceiverAuthorizerMismatch,
  ErrRefundPayload,
  ErrTokenMismatch,
  ErrWithdrawDelayMismatch,
  ErrWithdrawDelayOutOfRange,
  ErrValidAfterInFuture,
  ErrValidBeforeExpired,
} from "../../../src/batch-settlement/errors";
import {
  parseRefundSettlementSnapshot,
  readChannelStateExtra,
  readExtraNumber,
  readExtraString,
} from "../../../src/batch-settlement/server/utils";
import { MIN_WITHDRAW_DELAY, MAX_WITHDRAW_DELAY } from "../../../src/batch-settlement/constants";
import type { ChannelConfig } from "../../../src/batch-settlement/types";
import type { PaymentRequirements } from "@x402/core/types";

const BASE_CONFIG: ChannelConfig = {
  payer: "0x1234567890123456789012345678901234567890",
  payerAuthorizer: "0x1234567890123456789012345678901234567890",
  receiver: "0x9876543210987654321098765432109876543210",
  receiverAuthorizer: "0x1111111111111111111111111111111111111111",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  withdrawDelay: 900,
  salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
};

const BASE_REQUIREMENTS: PaymentRequirements = {
  scheme: "batch-settlement",
  network: "eip155:84532",
  amount: "1000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x9876543210987654321098765432109876543210",
  maxTimeoutSeconds: 3600,
  extra: {
    receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    withdrawDelay: 900,
  },
};

function computeChannelId(
  config: ChannelConfig,
  network = BASE_REQUIREMENTS.network,
): `0x${string}` {
  return computeChannelIdForNetwork(config, network);
}

describe("computeChannelId", () => {
  it("is deterministic for identical configs", () => {
    expect(computeChannelId(BASE_CONFIG)).toBe(computeChannelId({ ...BASE_CONFIG }));
  });

  it("returns a 32-byte hex string (0x + 64 chars)", () => {
    const id = computeChannelId(BASE_CONFIG);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when the chain changes", () => {
    expect(computeChannelId(BASE_CONFIG, "eip155:84532")).not.toBe(
      computeChannelId(BASE_CONFIG, "eip155:8453"),
    );
  });

  it.each([
    ["payer", { payer: "0x1111111111111111111111111111111111111111" as `0x${string}` }],
    [
      "payerAuthorizer",
      { payerAuthorizer: "0x2222222222222222222222222222222222222222" as `0x${string}` },
    ],
    ["receiver", { receiver: "0x3333333333333333333333333333333333333333" as `0x${string}` }],
    [
      "receiverAuthorizer",
      { receiverAuthorizer: "0x4444444444444444444444444444444444444444" as `0x${string}` },
    ],
    ["token", { token: "0x5555555555555555555555555555555555555555" as `0x${string}` }],
    ["withdrawDelay", { withdrawDelay: 901 }],
    [
      "salt",
      {
        salt: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
      },
    ],
  ])("changes when %s changes", (_field, override) => {
    const base = computeChannelId(BASE_CONFIG);
    const changed = computeChannelId({ ...BASE_CONFIG, ...override });
    expect(changed).not.toBe(base);
  });
});

describe("isCanonicalChannelId", () => {
  const valid = "0xABCdef0123456789ABCDEF0123456789abcdef0123456789ABCdef0123456789";

  it("accepts a mixed-case 32-byte hex string", () => {
    expect(isCanonicalChannelId(valid)).toBe(true);
    expect(isCanonicalChannelId(valid.toLowerCase())).toBe(true);
  });

  it.each([
    ["missing 0x prefix", valid.slice(2)],
    ["too short", "0x1234"],
    ["too long", `${valid}00`],
    ["non-hex character", "0xZZZdef0123456789ABCDEF0123456789abcdef0123456789ABCdef0123456789"],
    ["path traversal", "../../../etc/passwd"],
    ["absolute path", "/etc/passwd"],
    ["forward slash separator", `0x${"a".repeat(30)}/${"b".repeat(32)}`],
    ["backslash separator", `0x${"a".repeat(30)}\\${"b".repeat(32)}`],
    ["empty string", ""],
  ])("rejects %s", (_label, value) => {
    expect(isCanonicalChannelId(value)).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isCanonicalChannelId(123)).toBe(false);
    expect(isCanonicalChannelId(null)).toBe(false);
    expect(isCanonicalChannelId(undefined)).toBe(false);
    expect(isCanonicalChannelId({})).toBe(false);
  });
});

describe("normalizeChannelId", () => {
  it("lowercases a valid mixed-case id (round-trips valid ids unchanged in bytes)", () => {
    const valid = "0xABCdef0123456789ABCDEF0123456789abcdef0123456789ABCdef0123456789";
    expect(normalizeChannelId(valid)).toBe(valid.toLowerCase());
    expect(normalizeChannelId(valid.toLowerCase())).toBe(valid.toLowerCase());
  });

  it.each([
    ["../../../etc/passwd"],
    ["/etc/passwd"],
    ["0x1234"],
    [""],
    [`0x${"a".repeat(30)}/${"b".repeat(32)}`],
    [`0x${"a".repeat(30)}\\${"b".repeat(32)}`],
  ])("throws ErrInvalidChannelId for %s", value => {
    expect(() => normalizeChannelId(value)).toThrow(ErrInvalidChannelId);
  });
});

describe("channelIdBindingError", () => {
  it("returns undefined when the claimed id matches the config", () => {
    const channelId = computeChannelId(BASE_CONFIG);
    expect(
      channelIdBindingError(BASE_CONFIG, channelId, BASE_REQUIREMENTS.network),
    ).toBeUndefined();
  });

  it("accepts a mixed-case claimed id that matches the config", () => {
    const channelId = computeChannelId(BASE_CONFIG);
    const upper = channelId.toUpperCase().replace("0X", "0x");
    expect(channelIdBindingError(BASE_CONFIG, upper, BASE_REQUIREMENTS.network)).toBeUndefined();
  });

  it("returns ErrInvalidChannelId for a malformed claimed id", () => {
    expect(channelIdBindingError(BASE_CONFIG, "../../evil", BASE_REQUIREMENTS.network)).toBe(
      ErrInvalidChannelId,
    );
  });

  it("returns ErrChannelIdMismatch when the id does not match the config", () => {
    const otherId =
      "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
    expect(channelIdBindingError(BASE_CONFIG, otherId, BASE_REQUIREMENTS.network)).toBe(
      ErrChannelIdMismatch,
    );
  });
});

describe("channelIdsEqual", () => {
  const id = "0xABCdef0123456789ABCDEF0123456789abcdef0123456789ABCdef0123456789" as `0x${string}`;

  it("matches case-insensitively", () => {
    expect(channelIdsEqual(id, id.toLowerCase())).toBe(true);
    expect(channelIdsEqual(id, id.toUpperCase())).toBe(true);
  });

  it("returns false for non-string input", () => {
    expect(channelIdsEqual(id, 123)).toBe(false);
    expect(channelIdsEqual(id, null)).toBe(false);
    expect(channelIdsEqual(id, undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(channelIdsEqual(id, "")).toBe(false);
  });

  it("returns false for completely different ids", () => {
    expect(
      channelIdsEqual(id, "0x1111111111111111111111111111111111111111111111111111111111111111"),
    ).toBe(false);
  });
});

describe("validateChannelConfig", () => {
  it("returns undefined when config matches requirements and computed id", () => {
    const channelId = computeChannelId(BASE_CONFIG);
    expect(validateChannelConfig(BASE_CONFIG, channelId, BASE_REQUIREMENTS)).toBeUndefined();
  });

  it("returns ErrChannelIdMismatch when channelId does not match config hash", () => {
    const fakeId =
      "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
    expect(validateChannelConfig(BASE_CONFIG, fakeId, BASE_REQUIREMENTS)).toBe(
      ErrChannelIdMismatch,
    );
  });

  it("returns ErrReceiverMismatch when receiver mismatches requirements.payTo", () => {
    const config: ChannelConfig = {
      ...BASE_CONFIG,
      receiver: "0x1111111111111111111111111111111111111111",
    };
    const channelId = computeChannelId(config);
    expect(validateChannelConfig(config, channelId, BASE_REQUIREMENTS)).toBe(ErrReceiverMismatch);
  });

  it("returns ErrReceiverAuthorizerMismatch when receiverAuthorizer differs from extra", () => {
    const config: ChannelConfig = {
      ...BASE_CONFIG,
      receiverAuthorizer: "0x2222222222222222222222222222222222222222",
    };
    const requirements: PaymentRequirements = {
      ...BASE_REQUIREMENTS,
      extra: {
        ...BASE_REQUIREMENTS.extra,
        receiverAuthorizer: "0x3333333333333333333333333333333333333333",
      },
    };
    const channelId = computeChannelId(config);
    expect(validateChannelConfig(config, channelId, requirements)).toBe(
      ErrReceiverAuthorizerMismatch,
    );
  });

  it("returns ErrTokenMismatch when token differs from requirements.asset", () => {
    const config: ChannelConfig = {
      ...BASE_CONFIG,
      token: "0xaaaa000000000000000000000000000000000000",
    };
    const channelId = computeChannelId(config);
    expect(validateChannelConfig(config, channelId, BASE_REQUIREMENTS)).toBe(ErrTokenMismatch);
  });

  it("returns ErrWithdrawDelayMismatch when withdrawDelay differs from extra", () => {
    const config: ChannelConfig = { ...BASE_CONFIG, withdrawDelay: 1800 };
    const channelId = computeChannelId(config);
    expect(validateChannelConfig(config, channelId, BASE_REQUIREMENTS)).toBe(
      ErrWithdrawDelayMismatch,
    );
  });

  it("returns ErrWithdrawDelayOutOfRange when below minimum (and extra not present)", () => {
    const config: ChannelConfig = { ...BASE_CONFIG, withdrawDelay: MIN_WITHDRAW_DELAY - 1 };
    const channelId = computeChannelId(config);
    const requirements: PaymentRequirements = {
      ...BASE_REQUIREMENTS,
      extra: { receiverAuthorizer: BASE_CONFIG.receiverAuthorizer },
    };
    expect(validateChannelConfig(config, channelId, requirements)).toBe(ErrWithdrawDelayOutOfRange);
  });

  it("returns ErrWithdrawDelayOutOfRange when above maximum (and extra not present)", () => {
    const config: ChannelConfig = { ...BASE_CONFIG, withdrawDelay: MAX_WITHDRAW_DELAY + 1 };
    const channelId = computeChannelId(config);
    const requirements: PaymentRequirements = {
      ...BASE_REQUIREMENTS,
      extra: { receiverAuthorizer: BASE_CONFIG.receiverAuthorizer },
    };
    expect(validateChannelConfig(config, channelId, requirements)).toBe(ErrWithdrawDelayOutOfRange);
  });

  it("returns ErrReceiverAuthorizerMismatch when receiverAuthorizer is missing from extra", () => {
    const config: ChannelConfig = {
      ...BASE_CONFIG,
      receiverAuthorizer: "0x2222222222222222222222222222222222222222",
    };
    const channelId = computeChannelId(config);
    const requirements: PaymentRequirements = {
      ...BASE_REQUIREMENTS,
      extra: { withdrawDelay: 900 },
    };
    expect(validateChannelConfig(config, channelId, requirements)).toBe(
      ErrReceiverAuthorizerMismatch,
    );
  });

  it("returns ErrReceiverAuthorizerMismatch when receiverAuthorizer is zero", () => {
    const config: ChannelConfig = {
      ...BASE_CONFIG,
      receiverAuthorizer: "0x0000000000000000000000000000000000000000",
    };
    const requirements: PaymentRequirements = {
      ...BASE_REQUIREMENTS,
      extra: {
        ...BASE_REQUIREMENTS.extra,
        receiverAuthorizer: "0x0000000000000000000000000000000000000000",
      },
    };
    const channelId = computeChannelId(config);
    expect(validateChannelConfig(config, channelId, requirements)).toBe(
      ErrReceiverAuthorizerMismatch,
    );
  });
});

describe("erc3009AuthorizationTimeInvalidReason", () => {
  const now = () => BigInt(Math.floor(Date.now() / 1000));

  it("returns undefined inside a comfortable window", () => {
    const va = now() - 60n;
    const vb = now() + 3600n;
    expect(erc3009AuthorizationTimeInvalidReason(va, vb)).toBeUndefined();
  });

  it("returns ErrValidAfterInFuture when validAfter is far in future", () => {
    const va = now() + 3600n;
    const vb = now() + 7200n;
    expect(erc3009AuthorizationTimeInvalidReason(va, vb)).toBe(ErrValidAfterInFuture);
  });

  it("returns ErrValidBeforeExpired when validBefore is in past", () => {
    const va = now() - 7200n;
    const vb = now() - 3600n;
    expect(erc3009AuthorizationTimeInvalidReason(va, vb)).toBe(ErrValidBeforeExpired);
  });

  it("returns ErrValidBeforeExpired when validBefore is right at the edge of clock-skew margin", () => {
    const va = now() - 60n;
    const vb = now() + 1n;
    expect(erc3009AuthorizationTimeInvalidReason(va, vb)).toBe(ErrValidBeforeExpired);
  });
});

describe("batch-settlement encoding", () => {
  const channelId =
    "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;
  const salt =
    "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`;

  it("binds ERC-3009 deposit nonce to channelId and salt", () => {
    const a = buildErc3009DepositNonce(channelId, salt);
    const b = buildErc3009DepositNonce(channelId, salt);
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(
      buildErc3009DepositNonce(
        channelId,
        "0x0000000000000000000000000000000000000000000000000000000000000003",
      ),
    ).not.toBe(a);
  });

  it("round-trips ERC-3009 collector data", () => {
    const encoded = buildErc3009CollectorData("0", "999", salt, "0xabcd");
    const [validAfter, validBefore, encodedSalt, signature] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
      encoded,
    );
    expect(validAfter).toBe(0n);
    expect(validBefore).toBe(999n);
    expect(encodedSalt).toBe(BigInt(salt));
    expect(signature).toBe("0xabcd");
  });

  it("encodes EIP-2612 permit data and nests it in Permit2 collector data", () => {
    const r = ("0x" + "11".repeat(32)) as `0x${string}`;
    const s = ("0x" + "22".repeat(32)) as `0x${string}`;
    const permit = buildEip2612PermitData({
      value: "1000",
      deadline: "9",
      v: 27,
      r,
      s,
    });
    const [value, deadline, v, encR, encS] = decodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint8" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      permit,
    );
    expect(value).toBe(1000n);
    expect(deadline).toBe(9n);
    expect(v).toBe(27);
    expect(encR).toBe(r);
    expect(encS).toBe(s);

    const collector = buildPermit2CollectorData("3", "8", "0xeeee", permit);
    const [nonce, permitDeadline, sig, nested] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes" }],
      collector,
    );
    expect(nonce).toBe(3n);
    expect(permitDeadline).toBe(8n);
    expect(sig).toBe("0xeeee");
    expect(nested).toBe(permit);
  });

  it("defaults the EIP-2612 segment to empty bytes", () => {
    const collector = buildPermit2CollectorData("1", "2", "0xaa");
    const [, , , nested] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes" }],
      collector,
    );
    expect(nested).toBe("0x");
  });
});

describe("server extra parsers", () => {
  it("reads nested channelState and coerces mixed extra types", () => {
    expect(readChannelStateExtra(undefined)).toBeUndefined();
    expect(readChannelStateExtra({ channelState: "nope" })).toBeUndefined();
    expect(readChannelStateExtra({ channelState: null })).toBeUndefined();
    expect(readChannelStateExtra({ channelState: { balance: "1" } })).toEqual({ balance: "1" });

    expect(readExtraString({ balance: "9" }, "balance", "0")).toBe("9");
    expect(readExtraString({ balance: 12 }, "balance", "0")).toBe("12");
    expect(readExtraString({ balance: true }, "balance", "0")).toBe("0");
    expect(readExtraString(undefined, "balance", "0")).toBe("0");

    expect(readExtraNumber({ refundNonce: 3 }, "refundNonce", 0)).toBe(3);
    expect(readExtraNumber({ refundNonce: "8" }, "refundNonce", 0)).toBe(8);
    expect(readExtraNumber({ refundNonce: "nope" }, "refundNonce", 4)).toBe(4);
    expect(readExtraNumber({ refundNonce: true }, "refundNonce", 1)).toBe(1);
  });

  it("parses a refund snapshot from string or numeric extra fields", () => {
    expect(
      parseRefundSettlementSnapshot({
        channelState: {
          balance: 1000,
          totalClaimed: "200",
          withdrawRequestedAt: 0,
          refundNonce: "3",
        },
      }),
    ).toEqual({
      balance: "1000",
      totalClaimed: "200",
      withdrawRequestedAt: 0,
      refundNonce: 3,
    });
  });

  it("rejects a refund snapshot that omits required uint fields", () => {
    expect(() => parseRefundSettlementSnapshot({ channelState: { balance: "1" } })).toThrow(
      ErrRefundPayload,
    );
    expect(() =>
      parseRefundSettlementSnapshot({
        channelState: {
          balance: "1",
          totalClaimed: "2",
          withdrawRequestedAt: -1,
          refundNonce: 0,
        },
      }),
    ).toThrow(ErrRefundPayload);
    expect(() =>
      parseRefundSettlementSnapshot({
        channelState: {
          balance: 1.5,
          totalClaimed: "2",
          withdrawRequestedAt: 0,
          refundNonce: 0,
        },
      }),
    ).toThrow(ErrRefundPayload);
  });
});
