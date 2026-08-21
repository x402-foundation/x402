import { describe, expect, it, vi } from "vitest";
import type { Account, TypedData } from "starknet";

import {
  toClientStarknetSigner,
  toFacilitatorStarknetPaymasterSigner,
  toFacilitatorStarknetSigner,
} from "../../src/signer";
import { buildCanonicalOutsideExecutionTypedData } from "../../src/typed-data";
import { CHAIN_IDS, STARKNET_SEPOLIA_CAIP2, TRANSFER_SELECTOR } from "../../src/constants";

const FORWARDER = "0x04a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
const RELAYER = "0x02eb0b878df018f7b9f722b7af6496f084b246597014d2886332ac2945431bf8";
const EXECUTOR = "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81";
const PAYER = "0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24";
const PAY_TO = "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57";
const ASSET = "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343";
const NONCE = "0x71b7b56b17c8e0f4dcd0d9427c30d0a8bfa3c53f4d95a3b26f6cf14f3d0f8e2";
const SIGNATURE = ["0x1a2b", "0x3c4d"];

const authorization = () =>
  buildCanonicalOutsideExecutionTypedData(CHAIN_IDS[STARKNET_SEPOLIA_CAIP2], {
    Caller: EXECUTOR,
    Nonce: NONCE,
    "Execute After": "1",
    "Execute Before": "1800000300",
    Calls: [{ To: ASSET, Selector: TRANSFER_SELECTOR, Calldata: [PAY_TO, "0x2710", "0x0"] }],
  });

/** A starknet.js Account stub exposing only what the signers touch. */
function stubAccount(execute = vi.fn(async () => ({ transaction_hash: "0x0e5ec" }))) {
  const signMessage = vi.fn(async (_typedData: TypedData) => ["0x5", "0x6"]);
  return {
    account: { address: EXECUTOR, execute, signMessage } as unknown as Account,
    execute,
    signMessage,
  };
}

describe("toClientStarknetSigner", () => {
  it("exposes the account address and delegates signing to the account", async () => {
    const { account, signMessage } = stubAccount();
    const signer = toClientStarknetSigner(account);
    const typedData = authorization();

    expect(signer.address).toBe(EXECUTOR);
    await expect(signer.signMessage(typedData)).resolves.toEqual(["0x5", "0x6"]);
    expect(signMessage).toHaveBeenCalledWith(typedData);
  });
});

describe("toFacilitatorStarknetSigner", () => {
  it("announces its own account as feePayer and origination sender", () => {
    const signer = toFacilitatorStarknetSigner(stubAccount().account);
    expect(signer.getAddresses()).toEqual([EXECUTOR]);
    expect(signer.getOriginationSenders?.()).toEqual([EXECUTOR]);
  });

  it("executes execute_from_outside_v2 on the payer with the signed authorization and no tip", async () => {
    const { account, execute } = stubAccount();
    const signer = toFacilitatorStarknetSigner(account);

    const result = await signer.executeFromOutside(
      { payer: PAYER, typedData: authorization(), signature: SIGNATURE },
      STARKNET_SEPOLIA_CAIP2,
    );

    expect(result).toEqual({ transactionHash: "0x0e5ec" });
    expect(execute).toHaveBeenCalledTimes(1);
    const [calls, options] = execute.mock.calls[0] as unknown as [
      { contractAddress: string; entrypoint: string; calldata: string[] }[],
      { tip: bigint },
    ];
    const call = Array.isArray(calls) ? calls[0] : calls;
    expect(BigInt(call.contractAddress)).toBe(BigInt(PAYER));
    expect(call.entrypoint).toBe("execute_from_outside_v2");
    // The serialized OutsideExecution leads with [caller, nonce, ...] and the
    // signature is appended verbatim, length-prefixed.
    expect(BigInt(call.calldata[0])).toBe(BigInt(EXECUTOR));
    expect(BigInt(call.calldata[1])).toBe(BigInt(NONCE));
    expect(call.calldata.slice(-3).map(BigInt)).toEqual([2n, ...SIGNATURE.map(BigInt)]);
    expect(options).toEqual({ tip: 0n });
  });

  it("passes a configured tip through to the account", async () => {
    const { account, execute } = stubAccount();
    const signer = toFacilitatorStarknetSigner(account, { tip: 7n });
    await signer.executeFromOutside(
      { payer: PAYER, typedData: authorization(), signature: SIGNATURE },
      STARKNET_SEPOLIA_CAIP2,
    );
    expect(execute.mock.calls[0][1]).toEqual({ tip: 7n });
  });

  it("throws when the account reports no transaction hash", async () => {
    const { account } = stubAccount(vi.fn(async () => ({ transaction_hash: "" })));
    const signer = toFacilitatorStarknetSigner(account);
    await expect(
      signer.executeFromOutside(
        { payer: PAYER, typedData: authorization(), signature: SIGNATURE },
        STARKNET_SEPOLIA_CAIP2,
      ),
    ).rejects.toThrow(/no transaction hash/);
  });
});

describe("toFacilitatorStarknetPaymasterSigner", () => {
  it("refuses a config with no feePayer address to announce", () => {
    expect(() =>
      toFacilitatorStarknetPaymasterSigner({
        feePayerAddresses: [],
        paymasterUrl: "https://sepolia.paymaster.example",
      }),
    ).toThrow(/feePayer/);
  });

  it("announces the configured feePayers without exposing internal state", () => {
    const signer = toFacilitatorStarknetPaymasterSigner({
      feePayerAddresses: [FORWARDER],
      paymasterUrl: "https://sepolia.paymaster.example",
    });
    const announced = signer.getAddresses();
    expect(announced).toEqual([FORWARDER]);
    // A caller mutating the returned array must not alter what is announced.
    announced.push("0xdead");
    expect(signer.getAddresses()).toEqual([FORWARDER]);
  });

  // The announced forwarder is a contract that can never sign a transaction, so
  // the /supported signers map must carry the relayers when known - and nothing
  // at all otherwise, rather than an address that will never appear as sender.
  it("advertises relayers, not the forwarder, as settlement signers", () => {
    const withRelayers = toFacilitatorStarknetPaymasterSigner({
      feePayerAddresses: [FORWARDER],
      paymasterUrl: "https://sepolia.paymaster.example",
      relayerAddresses: [RELAYER],
    });
    expect(withRelayers.getSettlementSigners?.()).toEqual([RELAYER]);

    const withoutRelayers = toFacilitatorStarknetPaymasterSigner({
      feePayerAddresses: [FORWARDER],
      paymasterUrl: "https://sepolia.paymaster.example",
    });
    expect(withoutRelayers.getSettlementSigners?.()).toEqual([]);
  });
});

describe("request timeouts", () => {
  it("rejects a timeout AbortSignal.timeout cannot honor", () => {
    for (const timeoutMs of [0, -1, 1.5, 2_147_483_648, Number.NaN]) {
      expect(() =>
        toFacilitatorStarknetPaymasterSigner({
          feePayerAddresses: ["0x1"],
          paymasterUrl: "http://localhost:1",
          timeoutMs,
        }),
      ).toThrow(/timeoutMs must be a positive integer/);
    }
  });

  it("accepts the bound and the default", () => {
    expect(() =>
      toFacilitatorStarknetPaymasterSigner({
        feePayerAddresses: ["0x1"],
        paymasterUrl: "http://localhost:1",
        timeoutMs: 2_147_483_647,
      }),
    ).not.toThrow();
    expect(() =>
      toFacilitatorStarknetPaymasterSigner({
        feePayerAddresses: ["0x1"],
        paymasterUrl: "http://localhost:1",
      }),
    ).not.toThrow();
  });
});
