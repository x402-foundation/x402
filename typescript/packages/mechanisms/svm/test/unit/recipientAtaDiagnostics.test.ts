import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "../../src/exact/facilitator/scheme";
import type { FacilitatorAccountInfo, FacilitatorSvmSigner } from "../../src/signer";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { buildExactPaymentTransaction } from "./helpers/signedTransaction";

const SIMULATION_MESSAGE = "Transaction simulation failed: InvalidAccountData";
const GENERIC_REASON = "invalid_exact_svm_transaction_simulation_failed";
const MISSING_REASON = "invalid_exact_svm_recipient_ata_missing";
const OWNER_REASON = "invalid_exact_svm_recipient_ata_wrong_program_owner";

describe.each([
  ["SPL Token", TOKEN_PROGRAM_ADDRESS],
  ["Token-2022", TOKEN_2022_PROGRAM_ADDRESS],
] as const)("recipient ATA diagnostics (%s)", (_label, tokenProgram) => {
  let payload: PaymentPayload;
  let requirements: PaymentRequirements;
  let destination: Address;
  let payerAddress: Address;
  let feePayerAddress: Address;

  beforeAll(async () => {
    const [payer, feePayer, recipient, mint] = await Promise.all(
      Array.from({ length: 4 }, () => generateKeyPairSigner()),
    );
    payerAddress = payer.address;
    feePayerAddress = feePayer.address;
    requirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: mint.address,
      amount: "100000",
      payTo: recipient.address,
      maxTimeoutSeconds: 60,
      extra: { feePayer: feePayer.address },
    };
    [destination] = await findAssociatedTokenPda({
      mint: mint.address,
      owner: recipient.address,
      tokenProgram,
    });
    const transaction = await buildExactPaymentTransaction({
      amount: 100000n,
      feePayer: feePayer.address,
      mint: mint.address,
      payTo: recipient.address,
      payer,
      tokenProgram,
    });
    payload = { x402Version: 2, accepted: requirements, payload: { transaction } };
  });

  function setup(account: FacilitatorAccountInfo | null = null) {
    const signer = {
      getAddresses: () => [feePayerAddress],
      simulateTransaction: vi.fn(async (): Promise<void> => {
        throw new Error(SIMULATION_MESSAGE);
      }),
      getAccountInfo: vi.fn(async function (this: FacilitatorSvmSigner) {
        // Custom signers may depend on their method receiver.
        expect(this.getAddresses()).toEqual([feePayerAddress]);
        return account;
      }),
      simulateTransactionWithInnerInstructions: vi.fn(async () => {
        throw new Error("Unexpected smart-wallet fallback");
      }),
      getConfirmedTransactionInnerInstructions: vi.fn(async () => {
        throw new Error("Unexpected transaction read");
      }),
      getTokenAccountBalance: vi.fn(async () => {
        throw new Error("Unexpected balance read");
      }),
      fetchAddressLookupTables: vi.fn(async () => {
        throw new Error("Unexpected ALT read");
      }),
      signTransaction: vi.fn(async () => {
        throw new Error("Unexpected signing");
      }),
      sendTransaction: vi.fn(async () => {
        throw new Error("Unexpected submission");
      }),
      confirmTransaction: vi.fn(async () => {
        throw new Error("Unexpected confirmation");
      }),
    } satisfies FacilitatorSvmSigner;
    const scheme = new ExactSvmScheme(signer, undefined, { enableSmartWalletVerification: true });
    return { signer, scheme };
  }

  function accountOwnedBy(owner: string): FacilitatorAccountInfo {
    return { owner, data: ["", "base64"], lamports: 2039280n };
  }

  function expectNoSettlement(signer: ReturnType<typeof setup>["signer"]) {
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(signer.sendTransaction).not.toHaveBeenCalled();
    expect(signer.confirmTransaction).not.toHaveBeenCalled();
    expect(signer.simulateTransactionWithInnerInstructions).not.toHaveBeenCalled();
  }

  it.each(["missing", "system program", "other token program"] as const)(
    "diagnoses %s only after failed simulation",
    async state => {
      const owner =
        state === "system program"
          ? "11111111111111111111111111111111"
          : tokenProgram === TOKEN_PROGRAM_ADDRESS
            ? TOKEN_2022_PROGRAM_ADDRESS
            : TOKEN_PROGRAM_ADDRESS;
      const { signer, scheme } = setup(state === "missing" ? null : accountOwnedBy(owner));
      const result = await scheme.verify(payload, requirements);
      expect(result).toMatchObject({
        isValid: false,
        payer: payerAddress,
        invalidReason: state === "missing" ? MISSING_REASON : OWNER_REASON,
      });
      expect(result.invalidMessage).toContain(SIMULATION_MESSAGE);
      expect(result.invalidMessage).toContain(destination);
      if (state !== "missing") {
        expect(result.invalidMessage).toContain(owner);
        expect(result.invalidMessage).toContain(tokenProgram);
      }
      expect(signer.getAccountInfo).toHaveBeenCalledExactlyOnceWith(
        destination,
        SOLANA_DEVNET_CAIP2,
        { commitment: "confirmed" },
      );
      expect(signer.simulateTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        signer.getAccountInfo.mock.invocationCallOrder[0],
      );
      expectNoSettlement(signer);
    },
  );

  it.each(["correct owner", "read error", "inconclusive owner", "no getter"] as const)(
    "preserves the original simulation failure with %s",
    async state => {
      const { signer } = setup(accountOwnedBy(state === "inconclusive owner" ? "" : tokenProgram));
      if (state === "read error") {
        signer.getAccountInfo.mockRejectedValueOnce(new Error("Account read unavailable"));
      }
      const configured = state === "no getter" ? { ...signer, getAccountInfo: undefined } : signer;
      const scheme = new ExactSvmScheme(configured, undefined, {
        enableSmartWalletVerification: true,
      });
      expect(await scheme.verify(payload, requirements)).toEqual({
        isValid: false,
        invalidReason: GENERIC_REASON,
        invalidMessage: SIMULATION_MESSAGE,
        payer: payerAddress,
      });
      expect(signer.getAccountInfo).toHaveBeenCalledTimes(state === "no getter" ? 0 : 1);
      expectNoSettlement(signer);
    },
  );

  it("does not read the account after successful simulation", async () => {
    const { signer, scheme } = setup();
    signer.simulateTransaction.mockResolvedValueOnce(undefined);
    expect(await scheme.verify(payload, requirements)).toMatchObject({
      isValid: true,
      payer: payerAddress,
    });
    expect(signer.getAccountInfo).not.toHaveBeenCalled();
    expectNoSettlement(signer);
  });

  it("does not diagnose an earlier amount rejection", async () => {
    const { signer, scheme } = setup();
    expect(await scheme.verify(payload, { ...requirements, amount: "100001" })).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_svm_payload_amount_mismatch",
      payer: payerAddress,
    });
    expect(signer.simulateTransaction).not.toHaveBeenCalled();
    expect(signer.getAccountInfo).not.toHaveBeenCalled();
    expectNoSettlement(signer);
  });

  it("does not diagnose an earlier mint rejection", async () => {
    const { signer, scheme } = setup();
    expect(await scheme.verify(payload, { ...requirements, asset: feePayerAddress })).toMatchObject(
      {
        isValid: false,
        invalidReason: "invalid_exact_svm_payload_mint_mismatch",
        payer: payerAddress,
      },
    );
    expect(signer.simulateTransaction).not.toHaveBeenCalled();
    expect(signer.getAccountInfo).not.toHaveBeenCalled();
    expectNoSettlement(signer);
  });

  it("does not diagnose an undecodable transaction", async () => {
    const { signer, scheme } = setup();
    expect(
      await scheme.verify({ ...payload, payload: { transaction: "invalid-base64" } }, requirements),
    ).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_svm_payload_transaction_could_not_be_decoded",
    });
    expect(signer.simulateTransaction).not.toHaveBeenCalled();
    expect(signer.getAccountInfo).not.toHaveBeenCalled();
    expectNoSettlement(signer);
  });

  it.each([true, false])("propagates a diagnosis through settle (missing=%s)", async missing => {
    const { signer, scheme } = setup(
      missing ? null : accountOwnedBy("11111111111111111111111111111111"),
    );
    const result = await scheme.settle(payload, requirements);
    expect(result).toMatchObject({
      success: false,
      errorReason: missing ? MISSING_REASON : OWNER_REASON,
      transaction: "",
      payer: payerAddress,
    });
    expect(result.errorMessage).toContain(SIMULATION_MESSAGE);
    expect(result.errorMessage).toContain(destination);
    expect(signer.getAccountInfo).toHaveBeenCalledTimes(1);
    expectNoSettlement(signer);
  });
});
