import { describe, it, expect } from "vitest";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";
import {
  channelIdsEqual,
  validateChannelConfig,
  erc3009AuthorizationTimeInvalidReason,
} from "../../../src/batch-settlement/facilitator/utils";
import {
  ErrChannelIdMismatch,
  ErrReceiverMismatch,
  ErrReceiverAuthorizerMismatch,
  ErrTokenMismatch,
  ErrWithdrawDelayMismatch,
  ErrWithdrawDelayOutOfRange,
  ErrValidAfterInFuture,
  ErrValidBeforeExpired,
} from "../../../src/batch-settlement/errors";
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
