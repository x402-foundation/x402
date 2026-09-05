import { describe, expect, it, vi } from "vitest";

// Stub `decodeCardanoTransaction` so the test injects deterministic decoded
// shapes without going through Evolution SDK. The mock must be declared
// before importing the facilitator scheme so the bound import inside that
// module picks up the stub.
vi.mock("../../src/utils", async original => {
  const actual = (await original()) as Record<string, unknown>;
  return {
    ...actual,
    decodeCardanoTransaction: vi.fn(),
  };
});

import { decodeCardanoTransaction } from "../../src/utils";
import {
  ExactCardanoScheme as ExactCardanoFacilitatorBase,
  type ExactCardanoFacilitatorConfig,
} from "../../src/exact/facilitator/scheme";
import {
  CARDANO_MAINNET_CAIP2,
  CARDANO_MAINNET_CIP34,
  USDM_MAINNET_ASSET,
} from "../../src/constants";
import type { FacilitatorCardanoSigner } from "../../src/signer";
import type { PaymentRequirements } from "@x402/core/types";

const TX_HASH = "a".repeat(64);
const RECIPIENT = "addr1qxytestrecipientaddress00";

/** Test-only facilitator with explicit volatile replay storage. */
class ExactCardanoFacilitator extends ExactCardanoFacilitatorBase {
  constructor(signer: FacilitatorCardanoSigner, config: ExactCardanoFacilitatorConfig = {}) {
    super(signer, { inMemorySettlementStoreMaxEntries: 4096, ...config });
  }
}

const buildRequirements = (extra: Record<string, unknown> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: CARDANO_MAINNET_CAIP2,
  asset: USDM_MAINNET_ASSET,
  amount: "10000",
  payTo: RECIPIENT,
  maxTimeoutSeconds: 600,
  extra: { confirmationPolicy: { l1Confirmations: 0 }, ...extra },
});

const stubSigner: FacilitatorCardanoSigner = {
  getAddresses: () => ["addr1qfacilitator00"],
  getUtxo: async () => ({
    exists: true,
    address: "addr1qpayer00",
    coin: 0n,
    assets: { [USDM_MAINNET_ASSET.toLowerCase()]: 10_000n },
    paymentKeyHash: "payer",
  }),
  getCurrentSlot: async () => 100n,
  validatePhase1Transaction: async () => undefined,
  submitTransaction: async () => ({ txHash: "deadbeef", status: "confirmed" }),
  getTransactionEvidence: async () => ({ status: "unknown", confirmations: -2 }),
};

describe("Cardano facilitator security", () => {
  const decodedPayment = () => ({
    txHash: "abc",
    networkId: 1,
    ttlSlot: undefined,
    validityStartSlot: undefined,
    inputs: [`${TX_HASH}#0`],
    fee: 0n,
    unsupportedPhase1Operations: [],
    outputs: [
      {
        address: RECIPIENT,
        coin: 0n,
        assets: { [USDM_MAINNET_ASSET.toLowerCase()]: 10_000n },
      },
    ],
    vkeyHashes: ["payer"],
    isValid: true,
    vkeyWitnessCount: 1,
    scriptWitnessCount: 0,
    redeemerCount: 0,
    signaturesValid: true,
  });

  it("rejects excessive input fan-out before any provider lookup", async () => {
    const getUtxo = vi.fn(stubSigner.getUtxo);
    const inputs = [
      `${TX_HASH}#0`,
      ...Array.from(
        { length: 256 },
        (_, index) => `${(index + 1).toString(16).padStart(64, "0")}#0`,
      ),
    ];
    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce({ ...decodedPayment(), inputs });

    const requirements = buildRequirements();
    const result = await new ExactCardanoFacilitator({ ...stubSigner, getUtxo }).verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction: "AAAA", nonce: `${TX_HASH}#0` },
      },
      requirements,
    );

    expect(result.invalidReason).toBe("invalid_exact_cardano_payload_phase1_invalid");
    expect(getUtxo).not.toHaveBeenCalled();
  });

  it("limits concurrent provider lookups for transaction inputs", async () => {
    let active = 0;
    let maximumActive = 0;
    const getUtxo = vi.fn(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return {
        exists: true,
        address: "addr1qpayer00",
        coin: 0n,
        assets: { [USDM_MAINNET_ASSET.toLowerCase()]: 10_000n },
        paymentKeyHash: "payer",
      };
    });
    const inputs = [
      `${TX_HASH}#0`,
      ...Array.from(
        { length: 19 },
        (_, index) => `${(index + 1).toString(16).padStart(64, "0")}#0`,
      ),
    ];
    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce({ ...decodedPayment(), inputs });

    const requirements = buildRequirements();
    const result = await new ExactCardanoFacilitator({ ...stubSigner, getUtxo }).verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction: "AAAA", nonce: `${TX_HASH}#0` },
      },
      requirements,
    );

    expect(result.isValid).toBe(true);
    expect(getUtxo).toHaveBeenCalledTimes(20);
    expect(maximumActive).toBeLessThanOrEqual(8);
  });

  it("reads assetTransferMethod from canonical requirements, not client-echoed accepted", async () => {
    let capturedExtra: Record<string, unknown> | undefined;

    class CaptureFacilitator extends ExactCardanoFacilitator {
      protected override async runMethodSpecificChecks(
        requirements: PaymentRequirements,
      ): Promise<{ ok: true } | { ok: false; reason: string }> {
        capturedExtra = requirements.extra ? { ...requirements.extra } : undefined;
        return { ok: true };
      }
    }

    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce({
      txHash: "abc",
      networkId: 1,
      ttlSlot: undefined,
      validityStartSlot: undefined,
      inputs: [`${TX_HASH}#0`],
      fee: 0n,
      unsupportedPhase1Operations: [],
      outputs: [
        {
          address: RECIPIENT,
          coin: 0n,
          assets: { [USDM_MAINNET_ASSET.toLowerCase()]: 10_000n },
        },
      ],
      vkeyHashes: ["payer"],
      isValid: true,
      vkeyWitnessCount: 1,
      scriptWitnessCount: 0,
      redeemerCount: 0,
      signaturesValid: true,
    });

    const facilitator = new CaptureFacilitator(stubSigner);
    const serverReqs = buildRequirements({
      assetTransferMethod: "script",
      scriptHash: "deadbeef",
    });
    const payload = {
      x402Version: 2,
      accepted: buildRequirements({ assetTransferMethod: "default" }),
      payload: { transaction: "AAAA", nonce: `${TX_HASH}#0` },
    };
    const result = await facilitator.verify(payload, serverReqs);
    expect(result.isValid).toBe(true);
    expect(capturedExtra).toEqual({
      assetTransferMethod: "script",
      confirmationPolicy: { l1Confirmations: 0 },
      scriptHash: "deadbeef",
    });
  });

  it("treats a CIP-34 alias network as equal to its canonical id", async () => {
    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce({
      txHash: "abc",
      networkId: 1,
      ttlSlot: undefined,
      validityStartSlot: undefined,
      inputs: [`${TX_HASH}#0`],
      fee: 0n,
      unsupportedPhase1Operations: [],
      outputs: [
        {
          address: RECIPIENT,
          coin: 0n,
          assets: { [USDM_MAINNET_ASSET.toLowerCase()]: 10_000n },
        },
      ],
      vkeyHashes: ["payer"],
      isValid: true,
      vkeyWitnessCount: 1,
      scriptWitnessCount: 0,
      redeemerCount: 0,
      signaturesValid: true,
    });

    const facilitator = new ExactCardanoFacilitator(stubSigner);
    // Client echoes the CIP-34 form; the server requires the canonical id. The
    // facilitator must normalize both and treat them as the same network.
    const payload = {
      x402Version: 2,
      accepted: { ...buildRequirements(), network: CARDANO_MAINNET_CIP34 },
      payload: { transaction: "AAAA", nonce: `${TX_HASH}#0` },
    };
    const result = await facilitator.verify(payload, buildRequirements());
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("addr1qpayer00");
  });

  it("rejects Masumi settlement fields on the default method", async () => {
    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce(decodedPayment());
    const requirements = buildRequirements();
    const result = await new ExactCardanoFacilitator(stubSigner).verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction: "AAAA", nonce: `${TX_HASH}#0`, settlementLayer: "l1" },
      },
      requirements,
    );
    expect(result.invalidReason).toBe("invalid_exact_cardano_payload_settlement_layer_mismatch");
  });

  it("rejects a confirmation depth it cannot authenticate", async () => {
    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce(decodedPayment());
    const withoutEvidence = { ...stubSigner, getTransactionEvidence: undefined };
    const requirements = buildRequirements({ confirmationPolicy: { l1Confirmations: 1 } });
    const result = await new ExactCardanoFacilitator(withoutEvidence).verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction: "AAAA", nonce: `${TX_HASH}#0` },
      },
      requirements,
    );
    expect(result.invalidReason).toBe("exact_cardano_facilitator_evidence_unavailable");
  });

  it("rejects server submission when a complete phase-1 validator is unavailable", async () => {
    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce(decodedPayment());
    const withoutPhase1 = { ...stubSigner, validatePhase1Transaction: undefined };
    const requirements = buildRequirements();
    const result = await new ExactCardanoFacilitator(withoutPhase1).verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction: "AAAA", nonce: `${TX_HASH}#0` },
      },
      requirements,
    );
    expect(result.invalidReason).toBe("invalid_exact_cardano_payload_phase1_invalid");
    expect(result.invalidMessage).toContain("requires a complete Cardano phase-1 validator");
  });

  it("surfaces a complete phase-1 validator rejection", async () => {
    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce(decodedPayment());
    const invalidSigner: FacilitatorCardanoSigner = {
      ...stubSigner,
      validatePhase1Transaction: async () => {
        throw new Error("ValueNotConservedUTxO");
      },
    };
    const requirements = buildRequirements();
    const result = await new ExactCardanoFacilitator(invalidSigner).verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction: "AAAA", nonce: `${TX_HASH}#0` },
      },
      requirements,
    );
    expect(result.invalidReason).toBe("invalid_exact_cardano_payload_phase1_invalid");
    expect(result.invalidMessage).toContain("ValueNotConservedUTxO");
  });

  it("uses an explicit full phase-1 validator for non-payment transaction shapes", async () => {
    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce({
      ...decodedPayment(),
      unsupportedPhase1Operations: ["mint"],
      vkeyHashes: ["unrelated"],
    });
    const validatePhase1Transaction = vi.fn(async () => undefined);
    const advancedSigner: FacilitatorCardanoSigner = {
      ...stubSigner,
      validatePhase1Transaction,
    };
    const requirements = buildRequirements({ confirmationPolicy: { l1Confirmations: 0 } });
    const result = await new ExactCardanoFacilitator(advancedSigner).verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction: "AAAA", nonce: `${TX_HASH}#0` },
      },
      requirements,
    );
    expect(result.isValid).toBe(true);
    expect(validatePhase1Transaction).toHaveBeenCalledWith("AAAA", CARDANO_MAINNET_CAIP2);
  });

  // `is_valid` sits outside the transaction body, so it is not covered by the
  // transaction id: a client can broadcast the failing (`is_valid = false`) form
  // and hand the facilitator the identical payload claiming `true`. Evidence
  // keyed by that id would then point at a transaction that created no outputs.
  // Only a Plutus-script transaction can be phase-2 invalid at all.
  it("refuses a client-submitted payment that runs Plutus scripts", async () => {
    const decoded = {
      txHash: "abc",
      networkId: 1,
      ttlSlot: undefined,
      validityStartSlot: undefined,
      inputs: [`${TX_HASH}#0`],
      fee: 0n,
      unsupportedPhase1Operations: [],
      outputs: [
        {
          address: RECIPIENT,
          coin: 0n,
          assets: { [USDM_MAINNET_ASSET.toLowerCase()]: 10_000n },
        },
      ],
      vkeyHashes: ["payer"],
      isValid: true,
      vkeyWitnessCount: 1,
      scriptWitnessCount: 1,
      redeemerCount: 1,
      signaturesValid: true,
    };
    const clientReqs = buildRequirements({ submissionPolicy: "client" });
    const evidenceSigner: FacilitatorCardanoSigner = {
      ...stubSigner,
      // Even a provider that vouches for the transaction cannot rescue it.
      getTransactionEvidence: async () => ({ status: "confirmed", confirmations: 5 }),
    };
    const payload = {
      x402Version: 2,
      accepted: clientReqs,
      payload: { transaction: "AAAA", nonce: `${TX_HASH}#0`, submissionMode: "client" },
    };

    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce(decoded);
    const refused = await new ExactCardanoFacilitator(evidenceSigner).verify(payload, clientReqs);
    expect(refused.isValid).toBe(false);
    expect(refused.invalidReason).toBe("invalid_exact_cardano_payload_phase2_invalid");

    // The same payment without redeemers is fine.
    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce({
      ...decoded,
      scriptWitnessCount: 0,
      redeemerCount: 0,
    });
    const allowed = await new ExactCardanoFacilitator(evidenceSigner).verify(payload, clientReqs);
    expect(allowed.isValid).toBe(true);

    // An operator with a provider that verifies `valid_contract` can opt in.
    vi.mocked(decodeCardanoTransaction).mockReturnValueOnce(decoded);
    const optedIn = await new ExactCardanoFacilitator(evidenceSigner, {
      allowClientScriptExecution: true,
    }).verify(payload, clientReqs);
    expect(optedIn.isValid).toBe(true);
  });
});
