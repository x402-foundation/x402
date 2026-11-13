import { Address, mainnet } from "@evolution-sdk/evolution";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CIP30_MAX_WINDOW_SECONDS,
  CIP30_MIN_WINDOW_SECONDS,
  type Cip30ClientCardanoSignerConfig,
  type Cip30ProtocolParameters,
  createCip30ClientCardanoSigner,
} from "../../src/cip30";
import { CIP30_MAX_TOKEN_OUTPUT_LOVELACE } from "../../src/cip30/guards";
import { CIP30_TTL_MARGIN_MS } from "../../src/cip30/signer";
import { LOVELACE_ASSET, USDM_PREPROD_ASSET } from "../../src/constants";
import { ExactCardanoScheme as ExactCardanoFacilitator } from "../../src/exact/facilitator/scheme";
import type { CardanoUtxoSnapshot, FacilitatorCardanoSigner } from "../../src/signer";
import { decodeCardanoTransaction, slotToPosixMs } from "../../src/utils";
import { OFFLINE_PROTOCOL_PARAMETERS } from "../helpers/buildSignedTx";
import { createCip30Shim, encodeRawCip30Utxo, type ShimUtxoSpec } from "../helpers/cip30Shim";
import {
  buildRequirements,
  freshPreprodAddress,
  hex64,
  NETWORK,
  STUB_CURRENT_SLOT,
  stubFacilitatorSigner,
} from "../helpers/stubs";

/** Conway-era parameters, inside every CIP-30 bound. */
const TODAY_PARAMS: Cip30ProtocolParameters = OFFLINE_PROTOCOL_PARAMETERS;

const NOW_MS = slotToPosixMs(NETWORK, STUB_CURRENT_SLOT);
const hash = hex64;

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error("network access is forbidden for a CIP-30 payment");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Builds a facilitator that knows the shim's UTxOs.
 *
 * @param snapshot - Shim snapshot lookup.
 * @param overrides - Facilitator signer overrides.
 * @returns The facilitator scheme.
 */
function facilitatorFor(
  snapshot: (ref: string) => CardanoUtxoSnapshot | undefined,
  overrides: Partial<FacilitatorCardanoSigner> = {},
): ExactCardanoFacilitator {
  return new ExactCardanoFacilitator(
    stubFacilitatorSigner({
      getUtxo: async ref => snapshot(ref) ?? ({ exists: false } as CardanoUtxoSnapshot),
      ...overrides,
    }),
  );
}

/**
 * Signs a requirement with a fresh signer and wraps it as an x402 payload.
 *
 * @param utxos - Wallet UTxOs.
 * @param requirements - What to pay.
 * @param extra - Extra signer config.
 * @returns Shim, payload and signer result.
 */
async function signWith(
  utxos: ShimUtxoSpec[],
  requirements: PaymentRequirements,
  extra: Partial<Cip30ClientCardanoSignerConfig> = {},
) {
  const shim = await createCip30Shim({ utxos });
  const signer = await createCip30ClientCardanoSigner(shim.api, {
    network: NETWORK,
    protocolParameters: TODAY_PARAMS,
    clock: { now: () => NOW_MS },
    ...extra,
  });
  const result = await signer.buildAndSignPaymentTransaction({
    network: requirements.network,
    payTo: requirements.payTo,
    asset: requirements.asset,
    amount: requirements.amount,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    extra: requirements.extra,
  });
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: result.transaction, nonce: result.nonce },
  };
  return { shim, result, payload };
}

describe("createCip30ClientCardanoSigner", () => {
  it("signs a default ADA payment that passes facilitator verify without network access", async () => {
    const payTo = await freshPreprodAddress();
    const req = buildRequirements(payTo, "2000000");
    const { shim, payload } = await signWith(
      [{ ref: `${hash("1")}#0`, owner: 0, lovelace: 10_000_000n }],
      req,
    );
    const verdict = await facilitatorFor(shim.snapshot).verify(payload, req);
    expect(verdict).toMatchObject({ isValid: true });
    expect(shim.calls.signTx).toHaveLength(1);
    expect(shim.calls.signTx[0].partial).toBe(true);
    expect(shim.calls.submitTx).toBe(0);
    expect(shim.calls.signData).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("signs a USDM payment whose payee lovelace stays under the cap and verifies", async () => {
    const payTo = await freshPreprodAddress();
    const req = buildRequirements(payTo, "1500000", USDM_PREPROD_ASSET);
    const { shim, payload } = await signWith(
      [
        { ref: `${hash("2")}#0`, owner: 0, lovelace: 5_000_000n },
        {
          ref: `${hash("3")}#1`,
          owner: 0,
          lovelace: 2_000_000n,
          assets: { [USDM_PREPROD_ASSET]: 10_000_000n },
        },
      ],
      req,
    );
    const verdict = await facilitatorFor(shim.snapshot).verify(payload, req);
    expect(verdict).toMatchObject({ isValid: true });
    const decoded = decodeCardanoTransaction(payload.payload.transaction as string);
    const payee = decoded.outputs.filter(o => o.address === payTo);
    expect(payee).toHaveLength(1);
    expect(payee[0].assets[USDM_PREPROD_ASSET]).toBe(1_500_000n);
    expect(payee[0].coin <= CIP30_MAX_TOKEN_OUTPUT_LOVELACE).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("witnesses every input when coin selection spans both wallet addresses", async () => {
    const payTo = await freshPreprodAddress();
    const req = buildRequirements(payTo, "6000000");
    const { shim, payload } = await signWith(
      [
        { ref: `${hash("4")}#0`, owner: 0, lovelace: 4_000_000n },
        { ref: `${hash("5")}#0`, owner: 1, lovelace: 4_000_000n },
      ],
      req,
    );
    const decoded = decodeCardanoTransaction(payload.payload.transaction as string);
    expect(decoded.inputs).toHaveLength(2);
    expect(new Set(decoded.vkeyHashes)).toEqual(new Set(shim.paymentKeyHashes));
    expect((await facilitatorFor(shim.snapshot).verify(payload, req)).isValid).toBe(true);
  });

  it("reports the signed payment (tx id, nonce, ttl) before returning", async () => {
    const payTo = await freshPreprodAddress();
    const onSigned = vi.fn();
    const { result } = await signWith(
      [{ ref: `${hash("6")}#2`, owner: 0, lovelace: 10_000_000n }],
      buildRequirements(payTo, "1000000"),
      { onSigned },
    );
    const decoded = decodeCardanoTransaction(result.transaction);
    expect(onSigned).toHaveBeenCalledWith({
      txId: decoded.txHash,
      nonce: `${hash("6")}#2`,
      ttlMs: NOW_MS + 600_000 - CIP30_TTL_MARGIN_MS,
    });
  });

  describe("refusals before the wallet is asked to spend", () => {
    it.each(["masumi", "script", "Script", "anything"])(
      "refuses assetTransferMethod %s without reading UTxOs or signing",
      async method => {
        const payTo = await freshPreprodAddress();
        const shim = await createCip30Shim({
          utxos: [{ ref: `${hash("7")}#0`, owner: 0, lovelace: 10_000_000n }],
        });
        const signer = await createCip30ClientCardanoSigner(shim.api, {
          network: NETWORK,
          protocolParameters: TODAY_PARAMS,
          clock: { now: () => NOW_MS },
        });
        await expect(
          signer.buildAndSignPaymentTransaction({
            network: NETWORK,
            payTo,
            asset: LOVELACE_ASSET,
            amount: "1000000",
            maxTimeoutSeconds: 600,
            extra: { assetTransferMethod: method },
          }),
        ).rejects.toMatchObject({ code: "transfer_method_unsupported" });
        expect(shim.calls.getUtxos).toBe(0);
        expect(shim.calls.signTx).toHaveLength(0);
      },
    );

    it("refuses an ADA price below min-UTxO before signing", async () => {
      const payTo = await freshPreprodAddress();
      const shim = await createCip30Shim({
        utxos: [{ ref: `${hash("7")}#0`, owner: 0, lovelace: 10_000_000n }],
      });
      const signer = await createCip30ClientCardanoSigner(shim.api, {
        network: NETWORK,
        protocolParameters: TODAY_PARAMS,
        clock: { now: () => NOW_MS },
      });
      await expect(
        signer.buildAndSignPaymentTransaction({
          network: NETWORK,
          payTo,
          asset: LOVELACE_ASSET,
          amount: "500000",
          maxTimeoutSeconds: 600,
        }),
      ).rejects.toMatchObject({ code: "amount_below_min_utxo" });
      expect(shim.calls.signTx).toHaveLength(0);
    });

    it("refuses a payment window under the minimum before reading UTxOs", async () => {
      const payTo = await freshPreprodAddress();
      const shim = await createCip30Shim({
        utxos: [{ ref: `${hash("8")}#0`, owner: 0, lovelace: 10_000_000n }],
      });
      const signer = await createCip30ClientCardanoSigner(shim.api, {
        network: NETWORK,
        protocolParameters: TODAY_PARAMS,
      });
      await expect(
        signer.buildAndSignPaymentTransaction({
          network: NETWORK,
          payTo,
          asset: LOVELACE_ASSET,
          amount: "1000000",
          maxTimeoutSeconds: CIP30_MIN_WINDOW_SECONDS - 1,
        }),
      ).rejects.toMatchObject({ code: "payment_window_too_short" });
      expect(shim.calls.getUtxos).toBe(0);
    });

    it("refuses a requirement on another network", async () => {
      const payTo = await freshPreprodAddress();
      const shim = await createCip30Shim({
        utxos: [{ ref: `${hash("9")}#0`, owner: 0, lovelace: 10_000_000n }],
      });
      const signer = await createCip30ClientCardanoSigner(shim.api, {
        network: NETWORK,
        protocolParameters: TODAY_PARAMS,
      });
      await expect(
        signer.buildAndSignPaymentTransaction({
          network: "cardano:preview",
          payTo,
          asset: LOVELACE_ASSET,
          amount: "1000000",
          maxTimeoutSeconds: 600,
        }),
      ).rejects.toMatchObject({ code: "network_mismatch" });
      expect(shim.calls.getUtxos).toBe(0);
    });

    it("refuses a mainnet wallet for a preprod payment before any signing", async () => {
      const shim = await createCip30Shim({
        chain: mainnet,
        utxos: [{ ref: `${hash("a")}#0`, owner: 0, lovelace: 10_000_000n }],
      });
      await expect(
        createCip30ClientCardanoSigner(shim.api, {
          network: NETWORK,
          protocolParameters: TODAY_PARAMS,
        }),
      ).rejects.toMatchObject({ code: "wallet_network_mismatch" });
      expect(shim.calls.signTx).toHaveLength(0);
    });

    it("does not report a wallet without addresses as a network mismatch", async () => {
      const shim = await createCip30Shim({ utxos: [] });
      shim.api.getUsedAddresses = async () => [];
      const failure = createCip30ClientCardanoSigner(shim.api, {
        network: NETWORK,
        protocolParameters: TODAY_PARAMS,
      });
      await expect(failure).rejects.toThrow(/no addresses/);
      await expect(failure).rejects.not.toMatchObject({ code: "wallet_network_mismatch" });
    });

    it.each([
      ["inflated coinsPerUtxoByte", { coinsPerUtxoByte: 400_000n }],
      ["inflated minFeeA", { minFeeA: 4_400 }],
      ["swapped minFeeA/minFeeB", { minFeeA: 155381, minFeeB: 44 }],
    ])("refuses %s before touching the wallet", async (_label, patch) => {
      const shim = await createCip30Shim({
        utxos: [{ ref: `${hash("b")}#0`, owner: 0, lovelace: 10_000_000n }],
      });
      await expect(
        createCip30ClientCardanoSigner(shim.api, {
          network: NETWORK,
          protocolParameters: { ...TODAY_PARAMS, ...patch },
        }),
      ).rejects.toMatchObject({ code: "protocol_parameters_out_of_bounds" });
      expect(shim.calls.getUsedAddresses).toBe(0);
      expect(shim.calls.signTx).toHaveLength(0);
    });
  });

  describe("nonce choice", () => {
    it("prefers an ADA-only UTxO over a token UTxO listed first", async () => {
      const payTo = await freshPreprodAddress();
      const { result } = await signWith(
        [
          {
            ref: `${hash("1")}#0`,
            owner: 0,
            lovelace: 5_000_000n,
            assets: { [USDM_PREPROD_ASSET]: 1n },
          },
          { ref: `${hash("f")}#3`, owner: 0, lovelace: 10_000_000n },
        ],
        buildRequirements(payTo, "1000000"),
      );
      expect(result.nonce).toBe(`${hash("f")}#3`);
    });

    it("picks the lowest txHash#index among ADA-only UTxOs regardless of wallet order", async () => {
      const payTo = await freshPreprodAddress();
      const { result } = await signWith(
        [
          { ref: `${hash("e")}#0`, owner: 0, lovelace: 10_000_000n },
          { ref: `${hash("c")}#5`, owner: 1, lovelace: 10_000_000n },
          { ref: `${hash("c")}#1`, owner: 0, lovelace: 10_000_000n },
        ],
        buildRequirements(payTo, "1000000"),
      );
      expect(result.nonce).toBe(`${hash("c")}#1`);
    });

    it("spends the pinned nonce even when a better candidate exists", async () => {
      const payTo = await freshPreprodAddress();
      const { result } = await signWith(
        [
          { ref: `${hash("1")}#0`, owner: 0, lovelace: 10_000_000n },
          { ref: `${hash("d")}#4`, owner: 1, lovelace: 10_000_000n },
        ],
        buildRequirements(payTo, "1000000"),
        { pinnedNonce: () => `${hash("d")}#4` },
      );
      expect(result.nonce).toBe(`${hash("d")}#4`);
    });

    it("refuses to choose a new nonce when the pinned one is gone", async () => {
      const payTo = await freshPreprodAddress();
      const shim = await createCip30Shim({
        utxos: [{ ref: `${hash("1")}#0`, owner: 0, lovelace: 10_000_000n }],
      });
      const signer = await createCip30ClientCardanoSigner(shim.api, {
        network: NETWORK,
        protocolParameters: TODAY_PARAMS,
        clock: { now: () => NOW_MS },
        pinnedNonce: () => `${hash("9")}#9`,
      });
      await expect(
        signer.buildAndSignPaymentTransaction({
          network: NETWORK,
          payTo,
          asset: LOVELACE_ASSET,
          amount: "1000000",
          maxTimeoutSeconds: 600,
        }),
      ).rejects.toMatchObject({ code: "pinned_nonce_missing" });
      expect(shim.calls.signTx).toHaveLength(0);
    });

    it("never spends datum-bearing, script-locked or undecodable UTxOs", async () => {
      const payTo = await freshPreprodAddress();
      const scriptAddress = new Uint8Array([0x70, ...new Uint8Array(28).fill(7)]);
      const keyAddress = Address.toBytes(Address.fromBech32(payTo));
      const shim = await createCip30Shim({
        utxos: [],
        rawUtxoHexes: [
          encodeRawCip30Utxo(hash("1"), 0n, scriptAddress, 50_000_000n),
          encodeRawCip30Utxo(hash("2"), 0n, keyAddress, 50_000_000n, new Uint8Array(32).fill(1)),
          "deadbeef",
        ],
      });
      const signer = await createCip30ClientCardanoSigner(shim.api, {
        network: NETWORK,
        protocolParameters: TODAY_PARAMS,
        clock: { now: () => NOW_MS },
      });
      await expect(
        signer.buildAndSignPaymentTransaction({
          network: NETWORK,
          payTo,
          asset: LOVELACE_ASSET,
          amount: "1000000",
          maxTimeoutSeconds: 600,
        }),
      ).rejects.toMatchObject({ code: "no_spendable_utxo" });
      expect(shim.calls.signTx).toHaveLength(0);
    });
  });

  describe("TTL margin and validity horizon", () => {
    it.each([
      [89n, true],
      [91n, false],
    ])("facilitator clock %ss behind → accepted=%s", async (behind, accepted) => {
      const payTo = await freshPreprodAddress();
      const req = buildRequirements(payTo, "1000000");
      const { shim, payload } = await signWith(
        [{ ref: `${hash("1")}#0`, owner: 0, lovelace: 10_000_000n }],
        req,
      );
      const verdict = await facilitatorFor(shim.snapshot, {
        getCurrentSlot: async () => STUB_CURRENT_SLOT - behind,
      }).verify(payload, req);
      expect(verdict.isValid).toBe(accepted);
      if (!accepted) {
        expect(verdict.invalidReason).toBe("invalid_exact_cardano_payload_ttl_too_far");
      }
    });

    it("caps the validity horizon for long routes", async () => {
      const payTo = await freshPreprodAddress();
      const { result } = await signWith(
        [{ ref: `${hash("1")}#0`, owner: 0, lovelace: 10_000_000n }],
        { ...buildRequirements(payTo, "1000000"), maxTimeoutSeconds: 3600 },
      );
      const ttlSlot = decodeCardanoTransaction(result.transaction).ttlSlot!;
      expect(slotToPosixMs(NETWORK, ttlSlot) - NOW_MS).toBeLessThanOrEqual(
        CIP30_MAX_WINDOW_SECONDS * 1000 - CIP30_TTL_MARGIN_MS,
      );
    });

    it("refuses to hand out a payment whose window ran out while the wallet was signing", async () => {
      const payTo = await freshPreprodAddress();
      let now = NOW_MS;
      const shim = await createCip30Shim({
        utxos: [{ ref: `${hash("1")}#0`, owner: 0, lovelace: 10_000_000n }],
        beforeSign: () => {
          now += 150_000;
        },
      });
      const signer = await createCip30ClientCardanoSigner(shim.api, {
        network: NETWORK,
        protocolParameters: TODAY_PARAMS,
        clock: { now: () => now },
      });
      await expect(
        signer.buildAndSignPaymentTransaction({
          network: NETWORK,
          payTo,
          asset: LOVELACE_ASSET,
          amount: "1000000",
          maxTimeoutSeconds: 300,
        }),
      ).rejects.toMatchObject({ code: "payment_window_expired" });
    });
  });

  describe("wallet signing failures", () => {
    it.each([
      [{ code: 2, info: "user declined sign tx" }, "wallet_declined"],
      [{ code: -3, info: "refused" }, "wallet_declined"],
      [{ code: 1, info: "proof generation failed" }, "wallet_sign_failed"],
      [new Error("wallet crashed"), "wallet_sign_failed"],
    ])("maps the CIP-30 rejection %o to %s", async (rejection, code) => {
      const payTo = await freshPreprodAddress();
      const shim = await createCip30Shim({
        utxos: [{ ref: `${hash("1")}#0`, owner: 0, lovelace: 10_000_000n }],
        beforeSign: () => {
          throw rejection;
        },
      });
      const signer = await createCip30ClientCardanoSigner(shim.api, {
        network: NETWORK,
        protocolParameters: TODAY_PARAMS,
        clock: { now: () => NOW_MS },
      });
      const failure = signer.buildAndSignPaymentTransaction({
        network: NETWORK,
        payTo,
        asset: LOVELACE_ASSET,
        amount: "1000000",
        maxTimeoutSeconds: 600,
      });
      await expect(failure).rejects.toMatchObject({ code });
      await expect(failure).rejects.not.toThrow(/object Object/);
    });
  });

  it.each(["1.5", "-1", "0", "01", "abc", ""])(
    "refuses the amount %j before reading UTXOs",
    async amount => {
      const payTo = await freshPreprodAddress();
      const shim = await createCip30Shim({
        utxos: [{ ref: `${hash("1")}#0`, owner: 0, lovelace: 10_000_000n }],
      });
      const signer = await createCip30ClientCardanoSigner(shim.api, {
        network: NETWORK,
        protocolParameters: TODAY_PARAMS,
      });
      await expect(
        signer.buildAndSignPaymentTransaction({
          network: NETWORK,
          payTo,
          asset: LOVELACE_ASSET,
          amount,
          maxTimeoutSeconds: 600,
        }),
      ).rejects.toMatchObject({ code: "amount_invalid" });
      expect(shim.calls.getUtxos).toBe(0);
    },
  );

  it("exposes the wallet's change address", async () => {
    const shim = await createCip30Shim({ utxos: [] });
    const signer = await createCip30ClientCardanoSigner(shim.api, {
      network: NETWORK,
      protocolParameters: TODAY_PARAMS,
    });
    expect(signer.getAddress()).toBe(shim.addresses[0]);
  });
});
