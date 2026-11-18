import { describe, it, expect } from "vitest";
import type { PaymentPayload } from "@x402/core/types";
import {
  EIP2612_GAS_SPONSORING_KEY,
  ERC20_APPROVAL_GAS_SPONSORING_KEY,
  extractEip2612GasSponsoringInfo,
  extractErc20ApprovalGasSponsoringInfo,
  validateEip2612GasSponsoringInfo,
  validateErc20ApprovalGasSponsoringInfo,
} from "../../../src/exact/extensions";
import { PERMIT2_ADDRESS } from "../../../src/constants";

const basePayload = { x402Version: 2, accepted: {}, payload: {} } as PaymentPayload;

describe("gas sponsoring extension extraction", () => {
  it("returns null when extension info is incomplete", () => {
    const payload = {
      ...basePayload,
      extensions: {
        [EIP2612_GAS_SPONSORING_KEY]: { info: { from: "0x" + "aa".repeat(20) } },
      },
    } as PaymentPayload;
    expect(extractEip2612GasSponsoringInfo(payload)).toBeNull();
    expect(
      extractErc20ApprovalGasSponsoringInfo({
        ...basePayload,
        extensions: {
          [ERC20_APPROVAL_GAS_SPONSORING_KEY]: { info: { from: "0x" + "bb".repeat(20) } },
        },
      } as PaymentPayload),
    ).toBeNull();
  });

  it("validates EIP-2612 and ERC-20 approval info formatting", () => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    const sig = "aa".repeat(64) + "1b";
    const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const from = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(
      validateEip2612GasSponsoringInfo({
        from,
        asset: token,
        spender: PERMIT2_ADDRESS,
        amount: "1000",
        nonce: "1",
        deadline: future,
        signature: `0x${sig}`,
        version: "1",
      }),
    ).toBe(true);
    expect(
      validateErc20ApprovalGasSponsoringInfo({
        from,
        asset: token,
        spender: PERMIT2_ADDRESS,
        amount: "1000",
        signedTransaction: `0x${sig}`,
        version: "1",
      }),
    ).toBe(true);
    expect(
      validateEip2612GasSponsoringInfo({
        from,
        asset: token,
        spender: PERMIT2_ADDRESS,
        amount: "1000",
        nonce: "1",
        deadline: future,
        signature: "not-hex",
        version: "1",
      }),
    ).toBe(false);
  });

  it("extracts complete ERC-20 approval sponsoring info from the payment envelope", () => {
    const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const from = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const sig = "aa".repeat(64) + "1b";
    const payload = {
      ...basePayload,
      extensions: {
        [ERC20_APPROVAL_GAS_SPONSORING_KEY]: {
          info: {
            from,
            asset: token,
            spender: PERMIT2_ADDRESS,
            amount: "1000",
            signedTransaction: `0x${sig}`,
            version: "1",
          },
        },
      },
    } as PaymentPayload;
    expect(extractErc20ApprovalGasSponsoringInfo(payload)).toMatchObject({ from, asset: token });
  });

  it("extracts complete EIP-2612 info from the payment envelope", () => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    const sig = "aa".repeat(64) + "1b";
    const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const from = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const payload = {
      ...basePayload,
      extensions: {
        [EIP2612_GAS_SPONSORING_KEY]: {
          info: {
            from,
            asset: token,
            spender: PERMIT2_ADDRESS,
            amount: "1000",
            nonce: "1",
            deadline: future,
            signature: `0x${sig}`,
            version: "1",
          },
        },
      },
    } as PaymentPayload;
    expect(extractEip2612GasSponsoringInfo(payload)).toMatchObject({ from, asset: token });
  });
});
