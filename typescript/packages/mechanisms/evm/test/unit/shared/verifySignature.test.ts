import { describe, expect, it, vi } from "vitest";
import { hashTypedData, HttpRequestError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  verifyTypedDataSignature,
  verifyHashSignature,
  verifyECDSA,
  verifyERC1271,
  checkERC1271,
  checkHashSignature,
  checkTypedDataSignature,
} from "../../../src/shared/verifySignature";
import { isContractRevert } from "../../../src/shared/revert";
import type { FacilitatorEvmSigner } from "../../../src/signer";

const ECDSA_KEY = "0x4df93dc5e721ad24d04da311f073184b4c6cd036ba08956aeff970a2a43d7401" as const;
const ECDSA_ADDR = "0xabcA8d06A3925a6C06D142788a1A90ae431ccB00" as const;

const SAMPLE_DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: 84532,
  verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
};
const SAMPLE_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const SAMPLE_MESSAGE = {
  from: ECDSA_ADDR,
  to: "0x122F8Fcaf2152420445Aa424E1D8C0306935B5c9",
  value: 1000n,
  validAfter: 0n,
  validBefore: 9999999999n,
  nonce: ("0x" + "a".repeat(64)) as `0x${string}`,
};

const ERC1271_MAGIC = "0x1626ba7e";
const ERC1271_FAIL = "0xffffffff";

function mockSigner(opts: {
  code: `0x${string}` | undefined;
  isValidSignatureResult?: `0x${string}`;
  isValidSignatureThrows?: boolean;
}): FacilitatorEvmSigner {
  return {
    getAddresses: () => [],
    readContract: vi.fn(async () => {
      if (opts.isValidSignatureThrows) throw new Error("revert");
      return opts.isValidSignatureResult ?? ERC1271_FAIL;
    }),
    verifyTypedData: vi.fn(),
    writeContract: vi.fn(),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getCode: vi.fn(async () => opts.code),
  };
}

async function buildSignatureFor(
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<{ digest: `0x${string}`; signature: `0x${string}` }> {
  const digest = hashTypedData({
    domain: SAMPLE_DOMAIN,
    types: SAMPLE_TYPES,
    primaryType: "TransferWithAuthorization",
    message: SAMPLE_MESSAGE,
  });
  const signature = await account.signTypedData({
    domain: SAMPLE_DOMAIN,
    types: SAMPLE_TYPES,
    primaryType: "TransferWithAuthorization",
    message: SAMPLE_MESSAGE,
  });
  return { digest, signature };
}

describe("verifyECDSA", () => {
  it("accepts a valid 65-byte signature from the address's owner", async () => {
    const account = privateKeyToAccount(ECDSA_KEY);
    const { digest, signature } = await buildSignatureFor(account);
    expect(await verifyECDSA(account.address, digest, signature)).toBe(true);
  });

  it("rejects a signature for the wrong address", async () => {
    const account = privateKeyToAccount(ECDSA_KEY);
    const { digest, signature } = await buildSignatureFor(account);
    const otherAddr = "0x0000000000000000000000000000000000000001" as `0x${string}`;
    expect(await verifyECDSA(otherAddr, digest, signature)).toBe(false);
  });

  it("rejects a signature that isn't 65 bytes", async () => {
    const account = privateKeyToAccount(ECDSA_KEY);
    const { digest } = await buildSignatureFor(account);
    expect(await verifyECDSA(account.address, digest, "0xdeadbeef")).toBe(false);
  });
});

describe("verifyERC1271", () => {
  it("accepts when isValidSignature returns the magic value", async () => {
    const signer = mockSigner({ code: "0x6080604052", isValidSignatureResult: ERC1271_MAGIC });
    const result = await verifyERC1271(
      signer,
      "0x1234567890123456789012345678901234567890",
      ("0x" + "0".repeat(64)) as `0x${string}`,
      ("0x" + "f".repeat(130)) as `0x${string}`,
    );
    expect(result).toBe(true);
  });

  it("rejects when isValidSignature returns the failure value", async () => {
    const signer = mockSigner({ code: "0x6080", isValidSignatureResult: ERC1271_FAIL });
    const result = await verifyERC1271(
      signer,
      "0x1234567890123456789012345678901234567890",
      ("0x" + "0".repeat(64)) as `0x${string}`,
      ("0x" + "f".repeat(130)) as `0x${string}`,
    );
    expect(result).toBe(false);
  });

  it("rejects (does NOT fall back to ECDSA) when isValidSignature reverts", async () => {
    const signer = mockSigner({ code: "0x6080", isValidSignatureThrows: true });
    const result = await verifyERC1271(
      signer,
      "0x1234567890123456789012345678901234567890",
      ("0x" + "0".repeat(64)) as `0x${string}`,
      ("0x" + "f".repeat(130)) as `0x${string}`,
    );
    expect(result).toBe(false);
  });
});

describe("verifyTypedDataSignature (code-routed)", () => {
  it("plain EOA + valid sig → true via ECDSA path", async () => {
    const account = privateKeyToAccount(ECDSA_KEY);
    const signer = mockSigner({ code: undefined });
    const { signature } = await buildSignatureFor(account);
    const ok = await verifyTypedDataSignature(signer, {
      address: account.address,
      domain: SAMPLE_DOMAIN,
      types: SAMPLE_TYPES,
      primaryType: "TransferWithAuthorization",
      message: SAMPLE_MESSAGE,
      signature,
    });
    expect(ok).toBe(true);
    expect(signer.readContract).not.toHaveBeenCalled();
  });

  it("plain EOA + invalid sig → false (no 1271 fallback)", async () => {
    const signer = mockSigner({ code: undefined });
    const ok = await verifyTypedDataSignature(signer, {
      address: "0x1234567890123456789012345678901234567890",
      domain: SAMPLE_DOMAIN,
      types: SAMPLE_TYPES,
      primaryType: "TransferWithAuthorization",
      message: SAMPLE_MESSAGE,
      signature: ("0x" + "f".repeat(130)) as `0x${string}`,
    });
    expect(ok).toBe(false);
    expect(signer.readContract).not.toHaveBeenCalled();
  });

  it("contract that returns ERC-1271 magic → true", async () => {
    const signer = mockSigner({ code: "0x6080604052", isValidSignatureResult: ERC1271_MAGIC });
    const account = privateKeyToAccount(ECDSA_KEY);
    const { signature } = await buildSignatureFor(account);
    const ok = await verifyTypedDataSignature(signer, {
      address: "0x1234567890123456789012345678901234567890",
      domain: SAMPLE_DOMAIN,
      types: SAMPLE_TYPES,
      primaryType: "TransferWithAuthorization",
      message: SAMPLE_MESSAGE,
      signature,
    });
    expect(ok).toBe(true);
  });

  it("REGRESSION: 7702/contract whose 1271 rejects → false (must NOT fall back to ECDSA)", async () => {
    // This is the key regression case the PR exists to fix.
    // A 7702-delegated EOA whose delegate's isValidSignature returns failure.
    // ECDSA recovery WOULD succeed (sig was made by the underlying owner key) but
    // on-chain Permit2 / USDC SignatureChecker calls isValidSignature which rejects.
    // The strict primitive must mirror that.
    const erc7702Bytecode = "0xef01001234567890abcdef1234567890abcdef12345678" as `0x${string}`;
    const signer = mockSigner({
      code: erc7702Bytecode,
      isValidSignatureResult: ERC1271_FAIL,
    });
    const account = privateKeyToAccount(ECDSA_KEY);
    const { signature } = await buildSignatureFor(account);
    const ok = await verifyTypedDataSignature(signer, {
      // Use the EOA's address — ECDSA recovery would match this if we fell back.
      address: account.address,
      domain: SAMPLE_DOMAIN,
      types: SAMPLE_TYPES,
      primaryType: "TransferWithAuthorization",
      message: SAMPLE_MESSAGE,
      signature,
    });
    expect(ok).toBe(false);
  });

  it("contract whose 1271 reverts → false (no ECDSA fallback)", async () => {
    const signer = mockSigner({ code: "0x6080", isValidSignatureThrows: true });
    const account = privateKeyToAccount(ECDSA_KEY);
    const { signature } = await buildSignatureFor(account);
    const ok = await verifyTypedDataSignature(signer, {
      address: account.address,
      domain: SAMPLE_DOMAIN,
      types: SAMPLE_TYPES,
      primaryType: "TransferWithAuthorization",
      message: SAMPLE_MESSAGE,
      signature,
    });
    expect(ok).toBe(false);
  });
});

describe("verifyHashSignature", () => {
  it("works on a raw 32-byte digest (no typed-data wrapper)", async () => {
    const signer = mockSigner({ code: undefined });
    const account = privateKeyToAccount(ECDSA_KEY);
    const { digest, signature } = await buildSignatureFor(account);
    const ok = await verifyHashSignature(signer, account.address, digest, signature);
    expect(ok).toBe(true);
  });
});

describe("isContractRevert", () => {
  it("treats revert-shaped errors as contract reverts and RPC/transport failures as not", () => {
    expect(isContractRevert(new Error("execution reverted: InvalidSignature"))).toBe(true);
    expect(
      isContractRevert(new Error("Error: VM Exception while processing transaction: revert")),
    ).toBe(true);
    expect(isContractRevert("call reverted without a reason string")).toBe(true);
    expect(isContractRevert(new Error("fetch failed"))).toBe(false);
    expect(isContractRevert(new Error("HTTP request failed"))).toBe(false);
    expect(isContractRevert(42)).toBe(false);
  });
});

describe("check* helpers: a failed read is not an invalid signature", () => {
  const CONTRACT = "0x1234567890123456789012345678901234567890" as const;
  const DIGEST = ("0x" + "0".repeat(64)) as `0x${string}`;
  const SIG = ("0x" + "f".repeat(130)) as `0x${string}`;
  const transportFailure = () =>
    new HttpRequestError({ url: "https://rpc.example/v1?token=secret", status: 503 });

  function signerWith(opts: {
    getCode?: FacilitatorEvmSigner["getCode"];
    readContract?: FacilitatorEvmSigner["readContract"];
  }): FacilitatorEvmSigner {
    return {
      getAddresses: () => [],
      readContract: opts.readContract ?? vi.fn(async () => ERC1271_MAGIC),
      verifyTypedData: vi.fn(),
      writeContract: vi.fn(),
      sendTransaction: vi.fn(),
      waitForTransactionReceipt: vi.fn(),
      getCode: opts.getCode ?? vi.fn(async () => "0x6080604052" as `0x${string}`),
    };
  }

  it("checkERC1271 reports a transport failure as lookup_failed", async () => {
    const signer = signerWith({ readContract: vi.fn().mockRejectedValue(transportFailure()) });
    expect(await checkERC1271(signer, CONTRACT, DIGEST, SIG)).toBe("lookup_failed");
    // The exported boolean helper is unchanged: false, never a throw.
    expect(await verifyERC1271(signer, CONTRACT, DIGEST, SIG)).toBe(false);
  });

  it("checkERC1271 finds a transport failure nested in the cause chain", async () => {
    const wrapped = Object.assign(new Error("contract call failed"), { cause: transportFailure() });
    const signer = signerWith({ readContract: vi.fn().mockRejectedValue(wrapped) });
    expect(await checkERC1271(signer, CONTRACT, DIGEST, SIG)).toBe("lookup_failed");
  });

  it("checkERC1271 treats a revert, JSON-RPC code 3 and an empty return as invalid", async () => {
    const cases: unknown[] = [
      new Error("execution reverted: InvalidSignature"),
      Object.assign(new Error("contract call failed"), {
        cause: new Error('The contract function "isValidSignature" reverted.'),
      }),
      Object.assign(new Error("call failed"), { code: 3 }),
      Object.assign(
        new Error('The contract function "isValidSignature" returned no data ("0x").'),
        {
          name: "ContractFunctionZeroDataError",
        },
      ),
    ];
    for (const error of cases) {
      const signer = signerWith({ readContract: vi.fn().mockRejectedValue(error) });
      expect(await checkERC1271(signer, CONTRACT, DIGEST, SIG)).toBe("invalid");
    }
  });

  it("checkERC1271 returns valid on the magic value and invalid on anything else", async () => {
    expect(await checkERC1271(signerWith({}), CONTRACT, DIGEST, SIG)).toBe("valid");
    const failing = signerWith({ readContract: vi.fn(async () => ERC1271_FAIL) });
    expect(await checkERC1271(failing, CONTRACT, DIGEST, SIG)).toBe("invalid");
  });

  it("checkHashSignature reports a failed payer eth_getCode as lookup_failed", async () => {
    const signer = signerWith({ getCode: vi.fn().mockRejectedValue(transportFailure()) });
    expect(await checkHashSignature(signer, CONTRACT, DIGEST, SIG)).toBe("lookup_failed");
    expect(await verifyHashSignature(signer, CONTRACT, DIGEST, SIG)).toBe(false);
  });

  it("checkTypedDataSignature returns valid for a correct EOA signature", async () => {
    const account = privateKeyToAccount(ECDSA_KEY);
    const signature = await account.signTypedData({
      domain: SAMPLE_DOMAIN,
      types: SAMPLE_TYPES,
      primaryType: "TransferWithAuthorization",
      message: SAMPLE_MESSAGE,
    });
    const signer = signerWith({ getCode: vi.fn(async () => "0x" as `0x${string}`) });
    expect(
      await checkTypedDataSignature(signer, {
        address: ECDSA_ADDR,
        domain: SAMPLE_DOMAIN,
        types: SAMPLE_TYPES,
        primaryType: "TransferWithAuthorization",
        message: SAMPLE_MESSAGE,
        signature,
      }),
    ).toBe("valid");
  });
});
