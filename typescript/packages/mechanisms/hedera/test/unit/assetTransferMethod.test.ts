import { describe, expect, it } from "vitest";
import {
  isCryptoTransferPayload,
  isTransferExecutorPayload,
  resolveHederaAssetTransferMethod,
} from "../../src";
import { parseTransferExecutorPayload } from "../../src/internal";

const cryptoTransferPayload = { transaction: "dGVzdA==" };
const transferExecutorPayload = {
  payer: "0.0.5001",
  executor: "0.0.7000",
  authorization: "0xdeadbeef",
};

describe("isCryptoTransferPayload", () => {
  it("accepts a payload with a string transaction", () => {
    expect(isCryptoTransferPayload(cryptoTransferPayload)).toBe(true);
  });

  it.each([
    ["a transferExecutor payload", transferExecutorPayload],
    ["null", null],
    ["undefined", undefined],
    ["an array", ["dGVzdA=="]],
    ["a string", "dGVzdA=="],
    ["a non-string transaction", { transaction: 123 }],
  ])("rejects %s", (_, payload) => {
    expect(isCryptoTransferPayload(payload)).toBe(false);
  });
});

describe("isTransferExecutorPayload", () => {
  it("accepts a payload with a payer, an executor and a hex authorization", () => {
    expect(isTransferExecutorPayload(transferExecutorPayload)).toBe(true);
  });

  it.each([
    ["a cryptoTransfer payload", cryptoTransferPayload],
    ["null", null],
    ["undefined", undefined],
    ["an array", [transferExecutorPayload]],
    ["a payload with only authorization", { authorization: "0xdeadbeef" }],
    ["a non-string payer", { ...transferExecutorPayload, payer: 5001 }],
    ["a payer that is not an account id", { ...transferExecutorPayload, payer: "0.0.abc" }],
    ["a non-string executor", { ...transferExecutorPayload, executor: null }],
    ["a non-string authorization", { ...transferExecutorPayload, authorization: {} }],
    ["a non-hex authorization", { ...transferExecutorPayload, authorization: "0xabc" }],
  ])("rejects %s", (_, payload) => {
    expect(isTransferExecutorPayload(payload)).toBe(false);
  });
});

describe("parseTransferExecutorPayload", () => {
  it("returns the typed payload when every field is well formed", () => {
    expect(parseTransferExecutorPayload(transferExecutorPayload)).toEqual({
      payload: transferExecutorPayload,
    });
  });

  it("returns only the three payload fields", () => {
    expect(parseTransferExecutorPayload({ ...transferExecutorPayload, extra: 1 })).toEqual({
      payload: transferExecutorPayload,
    });
  });

  it.each([
    ["payload", null],
    ["payload", ["0.0.5001"]],
    ["payer", { ...transferExecutorPayload, payer: undefined }],
    ["payer", { ...transferExecutorPayload, payer: "0.0.b794f5" }],
    ["executor", { ...transferExecutorPayload, executor: "contract" }],
    ["authorization", { ...transferExecutorPayload, authorization: "deadbeef" }],
  ])("names %s as the first malformed field of %j", (malformedField, payload) => {
    expect(parseTransferExecutorPayload(payload)).toEqual({ malformedField });
  });
});

describe("resolveHederaAssetTransferMethod", () => {
  it("defaults to cryptoTransfer when the method is absent", () => {
    expect(resolveHederaAssetTransferMethod(undefined)).toBe("cryptoTransfer");
    expect(resolveHederaAssetTransferMethod({})).toBe("cryptoTransfer");
    expect(resolveHederaAssetTransferMethod({ feePayer: "0.0.9000" })).toBe("cryptoTransfer");
  });

  it("treats a null method as absent", () => {
    expect(resolveHederaAssetTransferMethod({ assetTransferMethod: null })).toBe("cryptoTransfer");
  });

  it.each(["cryptoTransfer", "transferExecutor"])("resolves %s to itself", method => {
    expect(resolveHederaAssetTransferMethod({ assetTransferMethod: method })).toBe(method);
  });

  it.each([["default"], ["foo"], [123]])("returns null for %j", method => {
    expect(resolveHederaAssetTransferMethod({ assetTransferMethod: method })).toBeNull();
  });
});
