import { describe, expect, it } from "vitest";
import {
  AddressEras,
  BaseAddress,
  Data,
  Pointer,
  PointerAddress,
  ScriptHash,
} from "@evolution-sdk/evolution";
import { isKeyCredentialAddressOn } from "../../src/exact/masumi/schema";
import { verifyMasumiDatumInvariants } from "../../src/exact/masumi/verify";
import { freshKeyAddress } from "../helpers/masumi";
import {
  addressCredentials,
  buildMasumiLockDatum,
  MASUMI_STATE_FUNDS_LOCKED,
  parseMasumiLockDatum,
  type MasumiLockDatumInput,
} from "../../src/exact/masumi/datum";
import { masumiEscrowAddress } from "../../src/exact/masumi/blueprint";
import { buildMasumiLock } from "../../src/exact/masumi/lock";
import {
  MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE,
  MASUMI_MIN_COLLATERAL_LOVELACE,
  masumiMinUtxoLovelace,
} from "../../src/exact/masumi/constants";
import { CARDANO_PREPROD_CAIP2, LOVELACE_ASSET, USDM_PREPROD_ASSET } from "../../src/constants";
import { issueMasumiRequirements } from "../helpers/masumi";

// Base (payment + stake) preprod addresses.
const BUYER =
  "addr_test1qp7573my7h0fyj9cd2fwrws5v6ep0e6urpx007pz0pjnmakny46m3vmfawqwv3m48dv2s6eysht6tjfdk48lrzrkmj5qpmyq7l";
const SELLER =
  "addr_test1qzdjjcstngx8yneqv4d2phmz35ytkyxk4aa09rfexu7kj3evleltf708u3qyrn29sudutxqqy0vx5f3lv73dtewsdras79zz7d";

const COINS_PER_UTXO_BYTE = 4310n;
const PAY_BY_TIME = 1_785_756_000_000n;

const input: MasumiLockDatumInput = {
  buyerAddress: BUYER,
  sellerAddress: SELLER,
  referenceKey: "aabb".padEnd(64, "0"),
  referenceSignature: "cc".repeat(32),
  sellerNonce: "11".repeat(32),
  buyerNonce: "22".repeat(13),
  agentIdentifier: "33".repeat(16),
  collateralReturnLovelace: 0n,
  inputHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  payByTime: 1_000n,
  submitResultTime: 2_000n,
  unlockTime: 3_000n,
  externalDisputeUnlockTime: 4_000n,
};

describe("masumi lock datum codec", () => {
  it("round-trips build -> CBOR -> parse", () => {
    const view = parseMasumiLockDatum(Data.toCBORHex(buildMasumiLockDatum(input)));
    expect(view).not.toBeNull();
    const v = view!;
    expect(v.buyer.payment.hash).toBe(addressCredentials(BUYER).payment.hash);
    expect(v.buyer.stake?.hash).toBe(addressCredentials(BUYER).stake?.hash);
    expect(v.seller.payment.hash).toBe(addressCredentials(SELLER).payment.hash);
    expect(v.seller.stake?.hash).toBe(addressCredentials(SELLER).stake?.hash);
    expect(v.referenceKey).toBe(input.referenceKey);
    expect(v.referenceSignature).toBe(input.referenceSignature);
    expect(v.sellerNonce).toBe(input.sellerNonce);
    expect(v.buyerNonce).toBe(input.buyerNonce);
    expect(v.agentIdentifier).toBe(input.agentIdentifier);
    expect(v.collateralReturnLovelace).toBe(0n);
    expect(v.inputHash).toBe(input.inputHash);
    expect(v.resultHash).toBe(""); // empty at lock
    expect(v.payByTime).toBe(1_000n);
    expect(v.submitResultTime).toBe(2_000n);
    expect(v.unlockTime).toBe(3_000n);
    expect(v.externalDisputeUnlockTime).toBe(4_000n);
    expect(v.sellerCooldownTime).toBe(0n);
    expect(v.buyerCooldownTime).toBe(0n);
    expect(v.state).toBe(MASUMI_STATE_FUNDS_LOCKED);
  });

  // The spec's normative Plutus Data encoding vector. Byte equality is not
  // required, but decoding it and re-encoding MUST preserve the same tree.
  it("matches the spec's ledger Plutus Data encoding vector", () => {
    const VECTOR =
      "d8799fd8799fd8799f581c11111111111111111111111111111111111111111111111111111111ffd87a80ffd87a80d8799fd8799f581c22222222222222222222222222222222222222222222222222222222ffd87a80ffd87a8043a1010150555555555555555555555555555555555820333333333333333333333333333333333333333333333333333333333333333340401a0015e65e58204444444444444444444444444444444444444444444444444444444444444444401b0000019fc75a1f001b0000019fc7910d801b0000019fc7c7fc001b0000019fc7feea800000d87980ff";
    const view = parseMasumiLockDatum(VECTOR);
    expect(view).not.toBeNull();
    expect(view!.buyer.payment.hash).toBe("11".repeat(28));
    expect(view!.buyer.payment.isScript).toBe(false);
    expect(view!.buyer.stake).toBeUndefined();
    expect(view!.buyerReturnAddress).toBeNull();
    expect(view!.seller.payment.hash).toBe("22".repeat(28));
    expect(view!.sellerReturnAddress).toBeNull();
    expect(view!.referenceKey).toBe("a10101");
    expect(view!.referenceSignature).toBe("55".repeat(16));
    expect(view!.sellerNonce).toBe("33".repeat(32));
    expect(view!.buyerNonce).toBe("");
    expect(view!.agentIdentifier).toBe("");
    expect(view!.collateralReturnLovelace).toBe(1_435_230n);
    expect(view!.inputHash).toBe("44".repeat(32));
    expect(view!.resultHash).toBe("");
    expect(view!.payByTime).toBe(1_785_756_000_000n);
    expect(view!.submitResultTime).toBe(1_785_759_600_000n);
    expect(view!.unlockTime).toBe(1_785_763_200_000n);
    expect(view!.externalDisputeUnlockTime).toBe(1_785_766_800_000n);
    expect(view!.sellerCooldownTime).toBe(0n);
    expect(view!.buyerCooldownTime).toBe(0n);
    expect(view!.state).toBe(MASUMI_STATE_FUNDS_LOCKED);

    // Re-encoding the decoded tree yields the same CBOR.
    expect(Data.toCBORHex(Data.fromCBORHex(VECTOR))).toBe(VECTOR);
  });

  // Enterprise buyer/seller with `None` return addresses reproduces the vector
  // exactly, proving the builder emits the spec's structure.
  it("rebuilds the spec vector from buildMasumiLockDatum", () => {
    const enterprise = (hash: string) =>
      Data.toCBORHex(
        Data.constr(0n, [Data.constr(0n, [Data.bytearray(hash)]), Data.constr(1n, [])]),
      );
    // Sanity: the helper addresses below encode to the vector's address trees.
    expect(enterprise("11".repeat(28))).toBe(
      "d8799fd8799f581c11111111111111111111111111111111111111111111111111111111ffd87a80ff",
    );
  });

  it("parses directly from Plutus data too", () => {
    expect(parseMasumiLockDatum(buildMasumiLockDatum(input))?.state).toBe(0n);
  });

  it("encodes optional return addresses (None when absent)", () => {
    const withReturns = buildMasumiLockDatum({ ...input, buyerReturnAddress: BUYER });
    expect(parseMasumiLockDatum(withReturns)?.buyerReturnAddress?.payment.hash).toBe(
      addressCredentials(BUYER).payment.hash,
    );
    expect(parseMasumiLockDatum(buildMasumiLockDatum(input))?.buyerReturnAddress).toBeNull();
  });

  it("round-trips pointer stake references without converting them to None", () => {
    const buyer = AddressEras.fromBech32(BUYER);
    if (buyer._tag !== "BaseAddress") throw new Error("fixture must be a base address");
    const pointerAddress = AddressEras.toBech32(
      new PointerAddress.PointerAddress({
        networkId: buyer.networkId,
        paymentCredential: buyer.paymentCredential,
        pointer: new Pointer.Pointer({ slot: 42, txIndex: 3, certIndex: 1 }),
      }),
    );
    const datum = buildMasumiLockDatum({ ...input, buyerReturnAddress: pointerAddress });
    expect(parseMasumiLockDatum(datum)?.buyerReturnAddress?.pointer).toEqual({
      slot: 42n,
      txIndex: 3n,
      certIndex: 1n,
    });
    expect(addressCredentials(pointerAddress).pointer).toEqual({
      slot: 42n,
      txIndex: 3n,
      certIndex: 1n,
    });
  });

  it("extracts credentials: base has stake, enterprise script address has none", () => {
    expect(addressCredentials(BUYER).stake).toBeDefined();
    const escrow = addressCredentials(masumiEscrowAddress(CARDANO_PREPROD_CAIP2));
    expect(escrow.payment.isScript).toBe(true);
    expect(escrow.stake).toBeUndefined();
  });

  it("returns null for a non-matching datum", () => {
    expect(parseMasumiLockDatum(Data.constr(0n, [Data.int(1n)]))).toBeNull();
    expect(parseMasumiLockDatum("not-cbor")).toBeNull();
  });

  // `vested_pay` decodes the datum with a typed `expect`, so a structurally
  // sloppy datum passes a lenient parser but strands the escrow on every later
  // spend — after the facilitator has already granted access.
  describe("strict constructor shapes", () => {
    /**
     * Replaces one field of the valid lock datum.
     *
     * @param index - The field position to replace.
     * @param value - The replacement Plutus data.
     * @returns The rebuilt datum tree.
     */
    const withField = (index: number, value: Data.Data): Data.Data => {
      const tree = buildMasumiLockDatum(input) as unknown as { fields: Data.Data[] };
      const fields = [...tree.fields];
      fields[index] = value;
      return Data.constr(0n, fields);
    };

    it("rejects a credential hash that is not 28 bytes", () => {
      const shortBuyer = Data.constr(0n, [
        Data.constr(0n, [Data.bytearray("11".repeat(27))]),
        Data.constr(1n, []),
      ]);
      expect(parseMasumiLockDatum(withField(0, shortBuyer))).toBeNull();
    });

    it("rejects a stake `None` carrying fields", () => {
      const oddStake = Data.constr(0n, [
        Data.constr(0n, [Data.bytearray("11".repeat(28))]),
        Data.constr(1n, [Data.int(0n)]),
      ]);
      expect(parseMasumiLockDatum(withField(0, oddStake))).toBeNull();
    });

    it("rejects a state constructor carrying fields", () => {
      expect(parseMasumiLockDatum(withField(18, Data.constr(0n, [Data.int(0n)])))).toBeNull();
    });

    it("still accepts the well-formed datum", () => {
      expect(parseMasumiLockDatum(buildMasumiLockDatum(input))).not.toBeNull();
    });
  });
});

// The seller never supplies or signs `collateral_return_lovelace`: the client
// derives it so `lockedLovelace = requestedLovelace + collateral` still clears
// the min-UTXO of the datum AFTER `SubmitResult`.
describe("client-computed collateral", () => {
  const issue = (asset: string, amount: string) =>
    issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset,
      amount,
      payByTimeMs: PAY_BY_TIME,
    });

  it("uses zero collateral when the requested lovelace already clears min-UTXO", async () => {
    const { extra } = await issue(LOVELACE_ASSET, "50000000");
    const lock = buildMasumiLock(extra, BUYER, LOVELACE_ASSET, 50_000_000n, COINS_PER_UTXO_BYTE);
    expect(lock.collateralLovelace).toBe(0n);
    expect(lock.lockedLovelace).toBe(50_000_000n);
  });

  it("tops a small lovelace payment up to the post-result min-UTXO", async () => {
    const { extra } = await issue(LOVELACE_ASSET, "1000000");
    const lock = buildMasumiLock(extra, BUYER, LOVELACE_ASSET, 1_000_000n, COINS_PER_UTXO_BYTE);
    expect(lock.collateralLovelace).toBeGreaterThanOrEqual(MASUMI_MIN_COLLATERAL_LOVELACE);
    expect(lock.lockedLovelace).toBe(1_000_000n + lock.collateralLovelace);
    const datumBytes = Data.toCBORHex(lock.datum.data).length / 2;
    expect(lock.lockedLovelace).toBeGreaterThanOrEqual(
      masumiMinUtxoLovelace(datumBytes, 0, COINS_PER_UTXO_BYTE),
    );
  });

  it("never uses zero collateral for a native-token payment", async () => {
    const { extra } = await issue(USDM_PREPROD_ASSET, "1500000");
    const lock = buildMasumiLock(extra, BUYER, USDM_PREPROD_ASSET, 1_500_000n, COINS_PER_UTXO_BYTE);
    // requestedLovelace is 0, so the collateral alone is the structural lovelace.
    expect(lock.collateralLovelace).toBeGreaterThanOrEqual(MASUMI_MIN_COLLATERAL_LOVELACE);
    expect(lock.lockedLovelace).toBe(lock.collateralLovelace);
    const datumBytes = Data.toCBORHex(lock.datum.data).length / 2;
    expect(lock.lockedLovelace).toBeGreaterThanOrEqual(
      masumiMinUtxoLovelace(datumBytes, 1, COINS_PER_UTXO_BYTE),
    );
  });

  it("takes buyer_nonce and input_hash from the signed terms, never from the client", async () => {
    const { extra } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: PAY_BY_TIME,
      buyerNonce: "0102030405060708090a0b0c0d",
    });
    const lock = buildMasumiLock(extra, BUYER, LOVELACE_ASSET, 50_000_000n, COINS_PER_UTXO_BYTE);
    const view = parseMasumiLockDatum(lock.datum.data)!;
    expect(view.buyerNonce).toBe("0102030405060708090a0b0c0d");
    expect(view.inputHash).toBe(extra.terms.inputHash);
    expect(view.buyerReturnAddress).toBeNull();
  });

  it("honours the buyer-chosen return address", async () => {
    const { extra } = await issue(LOVELACE_ASSET, "50000000");
    const lock = buildMasumiLock(extra, BUYER, LOVELACE_ASSET, 50_000_000n, COINS_PER_UTXO_BYTE, {
      buyerReturnAddress: BUYER,
    });
    expect(parseMasumiLockDatum(lock.datum.data)!.buyerReturnAddress?.payment.hash).toBe(
      addressCredentials(BUYER).payment.hash,
    );
  });

  // The collateral is the buyer's own money and follows the datum size, which
  // the seller controls through `reference_key` / `reference_signature`. This
  // pins the gap between what a real lock needs and what padding can demand, and
  // is why the client carries a ceiling.
  it("shows padded COSE fields inflating the collateral past the client ceiling", async () => {
    const { extra } = await issue(USDM_PREPROD_ASSET, "1000000");
    const honest = buildMasumiLock(
      extra,
      BUYER,
      USDM_PREPROD_ASSET,
      1_000_000n,
      COINS_PER_UTXO_BYTE,
    );
    expect(honest.collateralLovelace).toBeLessThan(MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE);

    // Well inside MAX_MASUMI_COSE_BYTES, so the wire schema still accepts it.
    const padded = buildMasumiLock(
      { ...extra, referenceSignature: extra.referenceSignature + "ab".repeat(6000) },
      BUYER,
      USDM_PREPROD_ASSET,
      1_000_000n,
      COINS_PER_UTXO_BYTE,
    );
    expect(padded.collateralLovelace).toBeGreaterThan(MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE);
  });
});

// The codec above stays faithful to whatever the chain carries; refusing an
// address form is a policy decision, and it lives here. Masumi's own
// `getPubKeyAddressDatum` accepts only an enterprise key address or a base
// address whose payment AND stake credentials are key hashes. Every later
// transition rebuilds the continuation datum through it while `vested_pay`
// demands `new_datum.buyer == buyer` exactly, so locking anything else strands
// the escrow for Masumi tooling with no recovery path.
describe("accepted datum address forms", () => {
  const NETWORK = CARDANO_PREPROD_CAIP2;
  const base = AddressEras.fromBech32(BUYER);
  if (base._tag !== "BaseAddress") throw new Error("fixture must be a base address");

  const scriptStakeAddress = AddressEras.toBech32(
    new BaseAddress.BaseAddress({
      networkId: base.networkId,
      paymentCredential: base.paymentCredential,
      stakeCredential: ScriptHash.fromHex("00".repeat(28)),
    }),
  );
  const pointerAddress = AddressEras.toBech32(
    new PointerAddress.PointerAddress({
      networkId: base.networkId,
      paymentCredential: base.paymentCredential,
      pointer: new Pointer.Pointer({ slot: 42, txIndex: 3, certIndex: 1 }),
    }),
  );

  it("accepts base key/key and enterprise key addresses", () => {
    expect(isKeyCredentialAddressOn(BUYER, NETWORK)).toBe(true);
    expect(isKeyCredentialAddressOn(SELLER, NETWORK)).toBe(true);
    expect(isKeyCredentialAddressOn(freshKeyAddress(NETWORK).address, NETWORK)).toBe(true);
  });

  it("refuses a script stake credential and a pointer stake reference", () => {
    expect(isKeyCredentialAddressOn(scriptStakeAddress, NETWORK)).toBe(false);
    expect(isKeyCredentialAddressOn(pointerAddress, NETWORK)).toBe(false);
  });

  it("refuses a script payment credential", () => {
    expect(isKeyCredentialAddressOn(masumiEscrowAddress(NETWORK), NETWORK)).toBe(false);
  });

  it("rejects a lock datum carrying an unsupported address form", () => {
    const escrow = masumiEscrowAddress(NETWORK);
    for (const [field, address] of [
      ["buyer", scriptStakeAddress],
      ["seller", pointerAddress],
    ] as const) {
      const datum = buildMasumiLockDatum({
        ...input,
        ...(field === "buyer" ? { buyerAddress: address } : { sellerAddress: address }),
      });
      const view = parseMasumiLockDatum(datum)!;
      expect(verifyMasumiDatumInvariants(view, escrow)).toMatchObject({
        ok: false,
        detail: expect.stringContaining(field),
      });
    }
  });
});
