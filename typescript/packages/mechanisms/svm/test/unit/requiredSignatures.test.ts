import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type IInstruction,
} from "@solana/kit";
import { ExactSvmScheme } from "../../src/exact/facilitator/scheme";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { encodeSignedTransaction, placeholderFeePayerSignature } from "./helpers/signedTransaction";
import * as Errors from "../../src/exact/facilitator/errors";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;

const FAKE_BLOCKHASH = {
  blockhash: "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF" as Blockhash,
  lastValidBlockHeight: 1000n,
};

/**
 * Builds a wire transaction whose compiled header requires `extraSigners + 1`
 * signatures (the fee payer plus one writable signer per extra account).
 *
 * @param feePayer - Fee payer address, always the first required signer
 * @param extraSigners - Additional writable-signer accounts to reference
 * @returns Base64 wire transaction
 */
async function buildTransactionWithSigners(
  feePayer: Address,
  extraSigners: Address[],
): Promise<string> {
  const instruction: IInstruction = {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: extraSigners.map(address => ({ address, role: 3 as never })),
    data: new Uint8Array([2, 160, 134, 1, 0]),
  };

  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(FAKE_BLOCKHASH, m),
    m => appendTransactionMessageInstruction(instruction, m),
  );

  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    compileTransactionMessage(msg),
  );
  const signatures = Object.fromEntries(
    [feePayer, ...extraSigners].map(a => [a, new Uint8Array(64)]),
  );

  return getBase64EncodedWireTransaction({ messageBytes, signatures } as never);
}

/**
 * Same as {@link buildTransactionWithSigners} but with genuine signatures on
 * every extra signer so local verification can proceed past the fee-payer slot.
 *
 * @param feePayer - Fee payer address
 * @param extraSigners - Additional writable-signer keypairs
 * @returns Base64 wire transaction
 */
async function buildSignedTransactionWithSigners(
  feePayer: Address,
  extraSigners: Array<{
    address: Address;
    signMessages: (messages: never[]) => Promise<unknown[]>;
  }>,
): Promise<string> {
  const instruction: IInstruction = {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: extraSigners.map(s => ({ address: s.address, role: 3 as never })),
    data: new Uint8Array([2, 160, 134, 1, 0]),
  };

  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(FAKE_BLOCKHASH, m),
    m => appendTransactionMessageInstruction(instruction, m),
  );

  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    compileTransactionMessage(msg),
  );

  return encodeSignedTransaction(
    messageBytes,
    extraSigners,
    placeholderFeePayerSignature(feePayer),
  );
}

describe("ExactSvmScheme maxRequiredSignatures", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * @param feePayer - Facilitator fee payer the mock signer manages
   * @returns Minimal facilitator signer mock
   */
  function mockSigner(feePayer: Address) {
    return {
      getAddresses: vi.fn().mockReturnValue([feePayer]),
      signTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
    };
  }

  /**
   * @param feePayer - Fee payer advertised in requirements.extra
   * @returns Payment requirements targeting devnet USDC
   */
  function requirementsFor(feePayer: Address): PaymentRequirements {
    return {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: "PayToAddress11111111111111111111111111",
      maxTimeoutSeconds: 3600,
      extra: { feePayer },
    } as PaymentRequirements;
  }

  it("rejects a transaction requiring more signatures than configured", async () => {
    const feePayer = await generateKeyPairSigner();
    const [a, b] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    const transaction = await buildTransactionWithSigners(feePayer.address, [a.address, b.address]);

    const scheme = new ExactSvmScheme(mockSigner(feePayer.address) as never, undefined, {
      maxRequiredSignatures: 2,
    });

    const requirements = requirementsFor(feePayer.address);
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction },
      } as unknown as PaymentPayload,
      requirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_svm_payload_excessive_signers");
  });

  it("does not apply a signature limit when the option is unset", async () => {
    const feePayer = await generateKeyPairSigner();
    const [a, b] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    const transaction = await buildSignedTransactionWithSigners(feePayer.address, [a, b]);

    const scheme = new ExactSvmScheme(mockSigner(feePayer.address) as never);

    const requirements = requirementsFor(feePayer.address);
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction },
      } as unknown as PaymentPayload,
      requirements,
    );

    // Still invalid (the payload is not a real transfer), but it must fail on
    // instruction layout rather than the signature count.
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).not.toBe("invalid_exact_svm_payload_excessive_signers");
  });

  it("rejects a forged client signature", async () => {
    const feePayer = await generateKeyPairSigner();
    const extra = await generateKeyPairSigner();
    const transaction = await buildTransactionWithSigners(feePayer.address, [extra.address]);

    const scheme = new ExactSvmScheme(mockSigner(feePayer.address) as never);
    const requirements = requirementsFor(feePayer.address);
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction },
      } as unknown as PaymentPayload,
      requirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_svm_payload_signature_invalid");
  });

  it("rejects a missing client signature", async () => {
    const feePayer = await generateKeyPairSigner();
    const extra = await generateKeyPairSigner();
    const instruction: IInstruction = {
      programAddress: COMPUTE_BUDGET_PROGRAM,
      accounts: [{ address: extra.address, role: 3 as never }],
      data: new Uint8Array([2, 160, 134, 1, 0]),
    };
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      m => setTransactionMessageFeePayer(feePayer.address, m),
      m => setTransactionMessageLifetimeUsingBlockhash(FAKE_BLOCKHASH, m),
      m => appendTransactionMessageInstruction(instruction, m),
    );
    const messageBytes = getCompiledTransactionMessageEncoder().encode(
      compileTransactionMessage(msg),
    );
    const transaction = await encodeSignedTransaction(messageBytes, [], {
      ...placeholderFeePayerSignature(feePayer.address),
      [extra.address]: new Uint8Array(0),
    });

    const scheme = new ExactSvmScheme(mockSigner(feePayer.address) as never);
    const requirements = requirementsFor(feePayer.address);
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction },
      } as unknown as PaymentPayload,
      requirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_svm_payload_signature_invalid");
  });

  it("rejects a transaction whose account 0 is not extra.feePayer", async () => {
    const feePayer = await generateKeyPairSigner();
    const otherFeePayer = await generateKeyPairSigner();
    const extra = await generateKeyPairSigner();
    const transaction = await buildSignedTransactionWithSigners(otherFeePayer.address, [extra]);

    const signer = mockSigner(feePayer.address);
    signer.getAddresses = vi.fn().mockReturnValue([feePayer.address, otherFeePayer.address]);
    const scheme = new ExactSvmScheme(signer as never);
    const requirements = requirementsFor(feePayer.address);
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction },
      } as unknown as PaymentPayload,
      requirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrFeePayerMismatch);
  });
});
