import {
  Address,
  FeeBumpTransaction,
  SorobanDataBuilder,
  Transaction,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAP,
  CONTRACT,
  FakeRpc,
  LEDGER,
  NETWORK,
  TOKEN,
  address,
  authority,
  authoritySigner,
  channel,
  channelSigner,
  contractEvent,
  errorEvent,
  errorSimulation,
  i128,
  payer,
  payment,
  recipient,
  requirements,
  settledEvent,
  settlementEvents,
  signedAuthorization,
  sponsor,
  sponsorSigner,
  successSimulation,
  terms,
  transferEvent,
} from "./upto-helpers";
import { UptoStellarScheme, type UptoStellarFacilitatorOptions } from "../../src/upto/facilitator";
import {
  classifySimulationFailure,
  hostErrors,
  hostErrorsFromMessage,
} from "../../src/upto/facilitator/simulation";
import * as utils from "../../src/utils";
import type { FacilitatorStellarSigner } from "../../src/signer";

vi.mock("../../src/utils", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/utils")>()),
  getRpcClient: vi.fn(),
  getEstimatedLedgerCloseTimeSeconds: vi.fn(),
}));

let fake: FakeRpc;
beforeEach(() => {
  fake = new FakeRpc();
  vi.mocked(utils.getRpcClient).mockImplementation(() => fake as unknown as rpc.Server);
  vi.mocked(utils.getEstimatedLedgerCloseTimeSeconds).mockResolvedValue(5);
  // Confirmation polls once a second.
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((resolve: () => void) => {
    resolve();
    return 0;
  }) as unknown as typeof setTimeout);
});

/**
 * Error events (oldest first) of failed settlement simulations, captured on a network running the
 * settlement contract. `g-…` payers are accounts signed with a key that is not a signer, with one
 * key of a 2-of-2 multisig, with an empty signature vector, and with expired terms; `c-…` is an
 * ed25519 contract account signed with the wrong key, and with expired terms.
 */
const CAPTURED = {
  contract: "CACMFU5TJ7K3REKE5NJO37Z6HP5EHJ6YDSD4DD5ER7DTG7W7NHQALTJB",
  token: "CAELJW7TKS6L37VNSANWRX4DMYDZSIKPYF7PL7UZ7UFP4QD5KIQS2E6G",
  recipient: "GBNE3RZDZXVRPDRJIQJQZW7POJS2XKSHQRGAABVGPWLUQZII7R6WHIBV",
  authority: "GCLV7ROI5DNNH5KHH2JMJNNRW4FOWV7TWI2OE2QZQ72HBE74L3IKLY2B",
  cases: {
    "g-non-member-key": {
      payer: "GAVAYBDG2ABDVDHOIVN7KIPTAWIZMUBPRKNI2YZSVN6WWLIZDWNSHQA6",
      events: [
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAAAAAAFAAAAEAAAAAEAAAACAAAADgAAACFzaWduZXIgZG9lcyBub3QgYmVsb25nIHRvIGFjY291bnQAAAAAAAANAAAAIGtL6CcamYs9h1tVg/eavDUP2KX1vvQcCGl8+i2EYABg",
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAkAAAAGAAAAEAAAAAEAAAADAAAADgAAAChmYWlsZWQgYWNjb3VudCBhdXRoZW50aWNhdGlvbiB3aXRoIGVycm9yAAAAEgAAAAAAAAAAKgwEZtACOozuRVv1IfMFkZZQL4qajWMyq31rLRkdmyMAAAACAAAAAAAAAAU=",
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAkAAAAGAAAADgAAAFFlc2NhbGF0aW5nIGVycm9yIHRvIFZNIHRyYXAgZnJvbSBmYWlsZWQgaG9zdCBmdW5jdGlvbiBjYWxsOiByZXF1aXJlX2F1dGhfZm9yX2FyZ3MAAAA=",
      ],
    },
    "g-multisig-under-threshold": {
      payer: "GBHSZQ37N6IVWJBCU43B3J45OLFU4PRJO5R7QDQFI3NL475HVUBR67E4",
      events: [
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAAAAAAFAAAAEAAAAAEAAAADAAAADgAAAChzaWduYXR1cmUgd2VpZ2h0IGlzIGxvd2VyIHRoYW4gdGhyZXNob2xkAAAAAwAAAAEAAAADAAAAAg==",
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAkAAAAGAAAAEAAAAAEAAAADAAAADgAAAChmYWlsZWQgYWNjb3VudCBhdXRoZW50aWNhdGlvbiB3aXRoIGVycm9yAAAAEgAAAAAAAAAATyzDf2+RWyQipzYdp51yy04+KXdj+A4FRtq+f6etAx8AAAACAAAAAAAAAAU=",
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAkAAAAGAAAADgAAAFFlc2NhbGF0aW5nIGVycm9yIHRvIFZNIHRyYXAgZnJvbSBmYWlsZWQgaG9zdCBmdW5jdGlvbiBjYWxsOiByZXF1aXJlX2F1dGhfZm9yX2FyZ3MAAAA=",
      ],
    },
    "g-empty-signature-vec": {
      payer: "GAVAYBDG2ABDVDHOIVN7KIPTAWIZMUBPRKNI2YZSVN6WWLIZDWNSHQA6",
      events: [
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAAAAAAFAAAADgAAABtubyBhY2NvdW50IHNpZ25hdHVyZXMgZm91bmQA",
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAkAAAAGAAAAEAAAAAEAAAADAAAADgAAAChmYWlsZWQgYWNjb3VudCBhdXRoZW50aWNhdGlvbiB3aXRoIGVycm9yAAAAEgAAAAAAAAAAKgwEZtACOozuRVv1IfMFkZZQL4qajWMyq31rLRkdmyMAAAACAAAAAAAAAAU=",
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAkAAAAGAAAADgAAAFFlc2NhbGF0aW5nIGVycm9yIHRvIFZNIHRyYXAgZnJvbSBmYWlsZWQgaG9zdCBmdW5jdGlvbiBjYWxsOiByZXF1aXJlX2F1dGhfZm9yX2FyZ3MAAAA=",
      ],
    },
    "g-terms-expired": {
      payer: "GAVAYBDG2ABDVDHOIVN7KIPTAWIZMUBPRKNI2YZSVN6WWLIZDWNSHQA6",
      events: [
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAAAAAAFAAAADgAAADZlc2NhbGF0aW5nIE9rKFNjRXJyb3JUeXBlOjpDb250cmFjdCkgZnJhbWUtZXhpdCB0byBFcnIAAA==",
      ],
    },
    "c-wrong-key": {
      payer: "CBFAPGR7KLSR72ODW7JGKZRFHKQF3FVH5KCDFRNYWHJUQP3EK262JDBB",
      events: [
        "AAAAAAAAAAAAAAABSgeaP1LlH+nDt9JlZiU6oF2Wp+qEMsW4sdNIP2RWvaQAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAUAAAACAAAADgAAABtmYWlsZWQgRUQyNTUxOSB2ZXJpZmljYXRpb24A",
        "AAAAAAAAAAAAAAABSgeaP1LlH+nDt9JlZiU6oF2Wp+qEMsW4sdNIP2RWvaQAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAUAAAACAAAADgAAAE5lc2NhbGF0aW5nIGVycm9yIHRvIFZNIHRyYXAgZnJvbSBmYWlsZWQgaG9zdCBmdW5jdGlvbiBjYWxsOiB2ZXJpZnlfc2lnX2VkMjU1MTkAAA==",
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAkAAAAGAAAAEAAAAAEAAAADAAAADgAAAChmYWlsZWQgYWNjb3VudCBhdXRoZW50aWNhdGlvbiB3aXRoIGVycm9yAAAAEgAAAAFKB5o/UuUf6cO30mVmJTqgXZan6oQyxbix00g/ZFa9pAAAAAIAAAAFAAAAAg==",
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAkAAAAGAAAADgAAAFFlc2NhbGF0aW5nIGVycm9yIHRvIFZNIHRyYXAgZnJvbSBmYWlsZWQgaG9zdCBmdW5jdGlvbiBjYWxsOiByZXF1aXJlX2F1dGhfZm9yX2FyZ3MAAAA=",
      ],
    },
    "c-terms-expired": {
      payer: "CBFAPGR7KLSR72ODW7JGKZRFHKQF3FVH5KCDFRNYWHJUQP3EK262JDBB",
      events: [
        "AAAAAAAAAAAAAAABBMLTs0/VuJFE61Lt/z47+kOn2ByHwY+kj8czft9p4AUAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAAAAAAFAAAADgAAADZlc2NhbGF0aW5nIE9rKFNjRXJyb3JUeXBlOjpDb250cmFjdCkgZnJhbWUtZXhpdCB0byBFcnIAAA==",
      ],
    },
  },
  /** The error string of the non-member-key simulation, with the host's event log. */
  nonMemberError:
    'HostError: Error(Auth, InvalidAction)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:CACMFU5TJ7K3REKE5NJO37Z6HP5EHJ6YDSD4DD5ER7DTG7W7NHQALTJB, topics:[error, Error(Auth, InvalidAction)], data:"escalating error to VM trap from failed host function call: require_auth_for_args"\n   1: [Diagnostic Event] contract:CACMFU5TJ7K3REKE5NJO37Z6HP5EHJ6YDSD4DD5ER7DTG7W7NHQALTJB, topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", GAVAYBDG2ABDVDHOIVN7KIPTAWIZMUBPRKNI2YZSVN6WWLIZDWNSHQA6, Error(Contract, #5)]\n   2: [Diagnostic Event] contract:CACMFU5TJ7K3REKE5NJO37Z6HP5EHJ6YDSD4DD5ER7DTG7W7NHQALTJB, topics:[error, Error(Contract, #5)], data:["signer does not belong to account", Bytes(6b4be8271a998b3d875b5583f79abc350fd8a5f5bef41c08697cfa2d84600060)]\n   3: [Diagnostic Event] topics:[fn_call, CACMFU5TJ7K3REKE5NJO37Z6HP5EHJ6YDSD4DD5ER7DTG7W7NHQALTJB, settle], data:[GAVAYBDG2ABDVDHOIVN7KIPTAWIZMUBPRKNI2YZSVN6WWLIZDWNSHQA6, {expiration_ledger: 518199, facilitator: GCLV7ROI5DNNH5KHH2JMJNNRW4FOWV7TWI2OE2QZQ72HBE74L3IKLY2B, max_amount: 1000, recipient: GBNE3RZDZXVRPDRJIQJQZW7POJS2XKSHQRGAABVGPWLUQZII7R6WHIBV, token: CAELJW7TKS6L37VNSANWRX4DMYDZSIKPYF7PL7UZ7UFP4QD5KIQS2E6G, valid_after_ledger: 0}, 0]\n',
  /** The error string of the expired-terms simulation, with the host's event log. */
  expiredError:
    'HostError: Error(Contract, #5)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:CACMFU5TJ7K3REKE5NJO37Z6HP5EHJ6YDSD4DD5ER7DTG7W7NHQALTJB, topics:[error, Error(Contract, #5)], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"\n   1: [Diagnostic Event] topics:[fn_call, CACMFU5TJ7K3REKE5NJO37Z6HP5EHJ6YDSD4DD5ER7DTG7W7NHQALTJB, settle], data:[GAVAYBDG2ABDVDHOIVN7KIPTAWIZMUBPRKNI2YZSVN6WWLIZDWNSHQA6, {expiration_ledger: 518167, facilitator: GCLV7ROI5DNNH5KHH2JMJNNRW4FOWV7TWI2OE2QZQ72HBE74L3IKLY2B, max_amount: 1000, recipient: GBNE3RZDZXVRPDRJIQJQZW7POJS2XKSHQRGAABVGPWLUQZII7R6WHIBV, token: CAELJW7TKS6L37VNSANWRX4DMYDZSIKPYF7PL7UZ7UFP4QD5KIQS2E6G, valid_after_ledger: 0}, 0]\n',
};

const facilitator = (options: UptoStellarFacilitatorOptions = {}) =>
  new UptoStellarScheme([channelSigner], {
    settlementAuthority: authoritySigner,
    feeBumpSigner: sponsorSigner,
    contracts: { [NETWORK]: CONTRACT },
    ...options,
  });

/**
 * The amount a settlement transaction settles.
 *
 * @param transaction - The transaction
 * @returns Its `settle` amount
 */
function settledAmount(transaction: Transaction): bigint {
  const operation = transaction.operations[0];
  if (operation?.type !== "invokeHostFunction") throw new Error("not a settlement");
  const parts = operation.func.invokeContract().args()[2]?.i128();
  if (parts === undefined) throw new Error("no amount");
  return (parts.hi().toBigInt() << 64n) | parts.lo().toBigInt();
}

/** Answers every simulation with the events a correct settlement of the simulated amount emits. */
const honest = (shape: "sac" | "sep41" = "sac") => {
  fake.defaultSimulation = tx => successSimulation(settlementEvents(settledAmount(tx), shape));
};

const settleRequest = async (amount: bigint) => ({
  payload: await payment(),
  settleRequirements: requirements({ amount: amount.toString() }),
});

describe("upto facilitator: supported kind", () => {
  it("advertises sponsored fees and the settlement authority", () => {
    const scheme = facilitator();
    expect(scheme.getExtra(NETWORK)).toEqual({
      areFeesSponsored: true,
      facilitatorAddress: authority.publicKey(),
    });
    expect(scheme.getSigners(NETWORK).sort()).toEqual(
      [channel.publicKey(), authority.publicKey(), sponsor.publicKey()].sort(),
    );
  });

  it("requires a signer and a G… authority", () => {
    expect(() => new UptoStellarScheme([])).toThrow();
    const contractAuthority = { ...authoritySigner, address: CONTRACT };
    expect(
      () => new UptoStellarScheme([channelSigner], { settlementAuthority: contractAuthority }),
    ).toThrow(/G… account/);
    expect(new UptoStellarScheme([channelSigner]).authority.address).toBe(channel.publicKey());
  });
});

describe("upto facilitator: verify", () => {
  it.each(["sac", "sep41"] as const)(
    "accepts a payment after simulating its maximum (%s events)",
    async shape => {
      honest(shape);
      expect(await facilitator().verify(await payment(), requirements())).toEqual({
        isValid: true,
        payer: payer.publicKey(),
      });
      expect(settledAmount(fake.simulated[0] as Transaction)).toBe(CAP);
      expect(fake.sent).toHaveLength(0);
    },
  );

  it("refuses networks it does not serve and other protocol versions", async () => {
    const pubnet = requirements({ network: "stellar:pubnet" });
    const evm = requirements({ network: "eip155:8453" });
    for (const req of [pubnet, evm]) {
      const result = await facilitator().verify(await payment({ requirements: req }), req);
      expect(result.invalidReason).toBe("invalid_network");
    }
    const v1 = { ...(await payment()), x402Version: 1 };
    expect((await facilitator().verify(v1, requirements())).invalidReason).toBe(
      "invalid_x402_version",
    );
    // Rule 1 checks the version and the scheme before the network.
    const v1Pubnet = { ...(await payment({ requirements: pubnet })), x402Version: 1 };
    expect((await facilitator().verify(v1Pubnet, pubnet)).invalidReason).toBe(
      "invalid_x402_version",
    );
    const exactPubnet = { ...pubnet, scheme: "exact" };
    expect(
      (await facilitator().verify(await payment({ requirements: exactPubnet }), exactPubnet))
        .invalidReason,
    ).toBe("unsupported_scheme");
  });

  it("returns static refusals with the payer, before any simulation", async () => {
    const authorization = await signedAuthorization({
      terms: terms({ recipient: authority.publicKey() }),
    });
    expect(
      await facilitator().verify(await payment({ authorization }), requirements()),
    ).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_wrong_recipient",
      payer: payer.publicKey(),
    });
    const noAccepted = { ...(await payment()), accepted: null } as never;
    expect((await facilitator().verify(noAccepted, requirements())).invalidReason).toBe(
      "invalid_upto_stellar_payload_accepted_mismatch",
    );
    expect(fake.simulated).toHaveLength(0);
  });

  it("accepts the expiration of a client that estimated 5 s ledgers when it estimates 6 s", async () => {
    honest();
    vi.mocked(utils.getEstimatedLedgerCloseTimeSeconds).mockResolvedValue(6);
    const accepted = requirements({ maxTimeoutSeconds: 300 });
    const signed = async (expirationLedger: number) =>
      payment({
        requirements: accepted,
        authorization: await signedAuthorization({ terms: terms({ expirationLedger }) }),
      });
    expect((await facilitator().verify(await signed(LEDGER + 60), accepted)).isValid).toBe(true);
    expect((await facilitator().verify(await signed(LEDGER + 63), accepted)).invalidReason).toBe(
      "invalid_upto_stellar_signature_expiration_too_far",
    );
  });

  it("applies the asset allow-list and the timeout range", async () => {
    honest();
    const allowList = facilitator({ isAssetAccepted: () => false });
    expect((await allowList.verify(await payment(), requirements())).invalidReason).toBe(
      "invalid_upto_stellar_requirements_asset_not_accepted",
    );
    for (const maxTimeoutSeconds of [14, 301]) {
      const req = requirements({ maxTimeoutSeconds });
      expect(await facilitator().verify(await payment({ requirements: req }), req)).toMatchObject({
        invalidReason: "invalid_upto_stellar_requirements_timeout_out_of_range",
        invalidMessage: "maxTimeoutSeconds must be an integer from 15 to 300.",
      });
    }
  });

  it("enforces the fee ceiling, counting the inclusion fee of the fee bump too", async () => {
    const run = async (minResourceFee: number, options: UptoStellarFacilitatorOptions = {}) => {
      fake.simulations.push(successSimulation(settlementEvents(CAP), { minResourceFee }));
      return (await facilitator(options).verify(await payment(), requirements())).invalidReason;
    };
    expect(await run(499_800)).toBeUndefined();
    expect(await run(499_801)).toBe("invalid_upto_stellar_payload_fee_exceeds_maximum");
    expect(await run(499_000, { inclusionFeeStroops: 500 })).toBeUndefined();
    expect(await run(499_001, { inclusionFeeStroops: 500 })).toBe(
      "invalid_upto_stellar_payload_fee_exceeds_maximum",
    );
    expect(await run(499_900, { feeBumpSigner: undefined })).toBeUndefined();
    expect(await run(499_901, { feeBumpSigner: undefined })).toBe(
      "invalid_upto_stellar_payload_fee_exceeds_maximum",
    );
  });

  describe("simulation failures", () => {
    const other = Address.contract(Buffer.alloc(32, 41)).toString();
    const auth = (code: xdr.ScErrorCode, message?: string) =>
      errorEvent(undefined, xdr.ScError.sceAuth(code), message);
    const contractError = (contract: string, code: number, ...args: xdr.ScVal[]) =>
      errorEvent(contract, xdr.ScError.sceContract(code), "error", ...args);
    it.each<[string, xdr.DiagnosticEvent, string]>([
      [
        "replay",
        auth(xdr.ScErrorCode.scecExistingValue()),
        "invalid_upto_stellar_payload_nonce_already_used",
      ],
      ["contract #1", contractError(CONTRACT, 1), "invalid_upto_stellar_payload_invalid_terms"],
      [
        "contract #2",
        contractError(CONTRACT, 2),
        "invalid_upto_stellar_requirements_invalid_amount",
      ],
      [
        "contract #3",
        contractError(CONTRACT, 3),
        "invalid_upto_stellar_payload_settlement_exceeds_amount",
      ],
      ["contract #4", contractError(CONTRACT, 4), "invalid_upto_stellar_payload_not_yet_valid"],
      ["contract #5", contractError(CONTRACT, 5), "invalid_upto_stellar_signature_expired"],
      [
        "contract #6",
        contractError(CONTRACT, 6),
        "invalid_upto_stellar_requirements_invalid_pay_to",
      ],
      ["token #6", contractError(TOKEN, 6), "invalid_upto_stellar_payload_account_missing"],
      ["token #10", contractError(TOKEN, 10), "insufficient_funds"],
      [
        "token #11",
        contractError(TOKEN, 11),
        "invalid_upto_stellar_payload_trustline_not_authorized",
      ],
      [
        "token #13 (payTo)",
        contractError(TOKEN, 13, address(recipient.publicKey())),
        "invalid_upto_stellar_payload_recipient_trustline_missing",
      ],
      [
        "token #13 (payer)",
        contractError(TOKEN, 13, address(payer.publicKey())),
        "invalid_upto_stellar_payload_payer_trustline_missing",
      ],
      ["token #100", contractError(TOKEN, 100), "insufficient_funds"],
      ["token #55", contractError(TOKEN, 55), "invalid_upto_stellar_payload_simulation_failed"],
      [
        "other contract",
        contractError(other, 77),
        "invalid_upto_stellar_payload_simulation_failed",
      ],
      [
        "ed25519",
        errorEvent(undefined, xdr.ScError.sceCrypto(xdr.ScErrorCode.scecInvalidInput())),
        "invalid_upto_stellar_payload_invalid_signature",
      ],
      [
        "authentication",
        auth(xdr.ScErrorCode.scecInvalidAction(), "failed account authentication"),
        "invalid_upto_stellar_payload_invalid_signature",
      ],
      [
        "signature expiry",
        auth(xdr.ScErrorCode.scecInvalidInput(), "signature has expired"),
        "invalid_upto_stellar_signature_expired",
      ],
      [
        "unauthorized call",
        auth(xdr.ScErrorCode.scecInvalidAction(), "Unauthorized function call"),
        "invalid_upto_stellar_payload_invalid_signature",
      ],
      [
        "budget",
        errorEvent(undefined, xdr.ScError.sceBudget(xdr.ScErrorCode.scecExceededLimit())),
        "invalid_upto_stellar_payload_simulation_failed",
      ],
    ])("maps %s", async (_name, event, code) => {
      fake.simulations.push(errorSimulation([event]));
      const result = await facilitator().verify(await payment(), requirements());
      expect(result.invalidReason).toBe(code);
      expect(result.invalidMessage).toBeTruthy();
    });

    it("reads host errors from the error string when no events are returned", async () => {
      fake.simulations.push(
        errorSimulation([], "HostError: Error(Auth, ExistingValue)"),
        errorSimulation([], "HostError: Error(WasmVm, InvalidAction)"),
      );
      expect((await facilitator().verify(await payment(), requirements())).invalidReason).toBe(
        "invalid_upto_stellar_payload_nonce_already_used",
      );
      expect(await facilitator().verify(await payment(), requirements())).toMatchObject({
        invalidReason: "invalid_upto_stellar_payload_simulation_failed",
        invalidMessage: expect.stringContaining("Error(WasmVm, InvalidAction)"),
      });
    });

    it("attributes refusals inside a smart account's __check_auth to the account", () => {
      const smart = Address.contract(Buffer.alloc(32, 5)).toString();
      const policy = Address.contract(Buffer.alloc(32, 6)).toString();
      const parties = {
        contract: CONTRACT,
        token: TOKEN,
        payer: smart,
        recipient: recipient.publicKey(),
        authority: authority.publicKey(),
        facilitatorAddresses: new Set<string>(),
      };
      for (const event of [
        errorEvent(policy, xdr.ScError.sceContract(8)),
        errorEvent(smart, xdr.ScError.sceContract(3002)),
        errorEvent(policy, xdr.ScError.sceCrypto(xdr.ScErrorCode.scecInvalidInput())),
        errorEvent(undefined, xdr.ScError.sceCrypto(xdr.ScErrorCode.scecInvalidInput())),
        errorEvent(
          undefined,
          xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction()),
          "failed account authentication",
        ),
      ]) {
        expect(classifySimulationFailure(hostErrors([event]), parties, "").code).toBe(
          "invalid_upto_stellar_payload_smart_account_rejected",
        );
      }
    });

    describe("captured host errors", () => {
      const partiesOf = (payerAddress: string) => ({
        contract: CAPTURED.contract,
        token: CAPTURED.token,
        payer: payerAddress,
        recipient: CAPTURED.recipient,
        authority: CAPTURED.authority,
        facilitatorAddresses: new Set([CAPTURED.authority]),
      });
      const classify = (name: keyof typeof CAPTURED.cases) => {
        const { payer: captured, events } = CAPTURED.cases[name];
        const decoded = events.map(event => xdr.DiagnosticEvent.fromXDR(event, "base64"));
        return classifySimulationFailure(hostErrors(decoded), partiesOf(captured), "");
      };

      it.each([
        ["g-non-member-key", "signer does not belong to account"],
        ["g-multisig-under-threshold", "signature weight is lower than threshold"],
        ["g-empty-signature-vec", "no account signatures found"],
      ] as const)("reports %s as a bad signature, not an expiry", (name, cause) => {
        // The host raises Error(Contract, #5) in the settlement contract's frame, the number of
        // the contract's own Expired, then "failed account authentication".
        const rejection = classify(name);
        expect(rejection.code).toBe("invalid_upto_stellar_payload_invalid_signature");
        expect(rejection.reason).toContain(cause);
      });

      it("reports a contract account's failed authentication as its refusal", () => {
        expect(classify("c-wrong-key").code).toBe(
          "invalid_upto_stellar_payload_smart_account_rejected",
        );
      });

      it("keeps the contract's #5 without an authentication failure as expired terms", () => {
        expect(classify("g-terms-expired").code).toBe("invalid_upto_stellar_signature_expired");
        expect(classify("c-terms-expired").code).toBe("invalid_upto_stellar_signature_expired");
      });

      it("classifies the same failures from the error string", () => {
        const parties = partiesOf(CAPTURED.cases["g-non-member-key"].payer);
        const fromMessage = (message: string) =>
          classifySimulationFailure(hostErrorsFromMessage(message), parties, message).code;
        expect(hostErrorsFromMessage(CAPTURED.nonMemberError).map(e => [e.type, e.code])).toEqual([
          ["Contract", 5],
          ["Auth", "InvalidAction"],
          ["Auth", "InvalidAction"],
        ]);
        expect(fromMessage(CAPTURED.nonMemberError)).toBe(
          "invalid_upto_stellar_payload_invalid_signature",
        );
        expect(fromMessage(CAPTURED.expiredError)).toBe("invalid_upto_stellar_signature_expired");
        // A contract error that names no contract is not mapped by its number.
        expect(fromMessage("HostError: Error(Contract, #5)")).toBe(
          "invalid_upto_stellar_payload_simulation_failed",
        );
        expect(fromMessage("HostError: Error(Contract, #6)")).toBe(
          "invalid_upto_stellar_payload_simulation_failed",
        );
      });
    });
  });

  it("requires exactly one transfer of the amount and one matching upto_settled event", async () => {
    const run = async (events: xdr.DiagnosticEvent[]) => {
      fake.simulations.push(successSimulation(events));
      return (await facilitator().verify(await payment(), requirements())).invalidReason;
    };
    const unexpected = "invalid_upto_stellar_payload_unexpected_balance_change";
    const mismatch = "invalid_upto_stellar_payload_settlement_event_mismatch";
    const [from, to] = [payer.publicKey(), recipient.publicKey()];
    const moved = transferEvent(from, to, CAP);
    const mint = contractEvent(TOKEN, [xdr.ScVal.scvSymbol("mint"), address(to)], i128(CAP));
    for (const events of [
      [settledEvent(CAP)],
      [transferEvent(from, to, CAP - 1n), settledEvent(CAP)],
      [transferEvent(to, from, CAP), settledEvent(CAP)],
      [transferEvent(from, to, CAP, CONTRACT), settledEvent(CAP)],
      [moved, transferEvent(from, to, 1n), settledEvent(CAP)],
      [mint, settledEvent(CAP)],
      [transferEvent(from, authority.publicKey(), CAP), settledEvent(CAP)],
    ]) {
      expect(await run(events)).toBe(unexpected);
    }
    for (const events of [
      [moved],
      [moved, settledEvent(CAP), settledEvent(CAP)],
      [moved, settledEvent(CAP - 1n)],
      [moved, settledEvent(CAP, { cap: CAP + 1n })],
      [moved, settledEvent(CAP, { facilitator: from })],
      [moved, settledEvent(CAP, { token: CONTRACT })],
    ]) {
      expect(await run(events)).toBe(mismatch);
    }
    // Events of calls that were rolled back do not count.
    const rolledBack = contractEvent(TOKEN, [xdr.ScVal.scvSymbol("mint")], i128(5n), false);
    expect(await run([rolledBack, ...settlementEvents(CAP)])).toBeUndefined();
  });

  it("refuses archived state, naming the settlement contract's own", async () => {
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(CONTRACT).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const otherKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(TOKEN).toScAddress(),
        key: xdr.ScVal.scvSymbol("balance"),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const data = (keys: xdr.LedgerKey[], archived: number[]) =>
      new xdr.SorobanTransactionData({
        ext: new xdr.SorobanTransactionDataExt(
          1,
          new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: archived }),
        ),
        resources: new xdr.SorobanResources({
          footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: keys }),
          instructions: 1,
          diskReadBytes: 1,
          writeBytes: 1,
        }),
        resourceFee: xdr.Int64.fromString("150000"),
      });
    const restore = successSimulation(
      settlementEvents(CAP),
    ) as rpc.Api.SimulateTransactionRestoreResponse;
    restore.restorePreamble = {
      minResourceFee: "1",
      transactionData: new SorobanDataBuilder(data([otherKey], [0])),
    };
    fake.simulations.push(
      successSimulation(settlementEvents(CAP), { data: data([otherKey, instanceKey], [1]) }),
      successSimulation(settlementEvents(CAP), { data: data([otherKey], [0]) }),
      restore,
    );
    // The settlement contract's code is found through its instance.
    const codeKey = (seed: number) =>
      xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, seed) }));
    fake.wasmHash = Buffer.alloc(32, 7);
    fake.simulations.push(
      successSimulation(settlementEvents(CAP), { data: data([otherKey, codeKey(7)], [1]) }),
      successSimulation(settlementEvents(CAP), { data: data([codeKey(8)], [0]) }),
    );
    const codes = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await facilitator().verify(await payment(), requirements())).invalidReason);
    }
    expect(codes).toEqual([
      "invalid_upto_stellar_settlement_contract_archived",
      "invalid_upto_stellar_payload_archived_state",
      "invalid_upto_stellar_payload_archived_state",
      "invalid_upto_stellar_settlement_contract_archived",
      "invalid_upto_stellar_payload_archived_state",
    ]);
  });

  it("reports unexpected errors with a reason", async () => {
    fake.getLatestLedger = () => Promise.reject(new Error("rpc down"));
    expect(await facilitator().verify(await payment(), requirements())).toMatchObject({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      invalidMessage: "rpc down",
    });
  });
});

describe("upto facilitator: settle", () => {
  it("submits settle(payer, terms, amount) with the authority as operation source", async () => {
    honest();
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const result = await facilitator().settle(payload, settleRequirements);
    expect(result).toMatchObject({
      success: true,
      network: NETWORK,
      payer: payer.publicKey(),
      amount: "300000",
    });

    const bump = fake.sent[0] as FeeBumpTransaction;
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
    expect(result.transaction).toBe(bump.hash().toString("hex"));
    expect(bump.feeSource).toBe(sponsor.publicKey());
    const inner = bump.innerTransaction;
    expect(inner.source).toBe(channel.publicKey());
    expect(inner.signatures).toHaveLength(2);
    expect(inner.ledgerBounds).toEqual({ minLedger: 0, maxLedger: LEDGER + 13 });
    const operation = inner.operations[0] as {
      source?: string;
      auth?: xdr.SorobanAuthorizationEntry[];
    };
    expect(operation.source).toBe(authority.publicKey());
    expect(settledAmount(inner)).toBe(300_000n);
    const [payerEntry, authorityEntry, extra] = operation.auth ?? [];
    expect(extra).toBeUndefined();
    expect(payerEntry?.toXDR("base64")).toBe(payload.payload["authorization"]);
    expect(authorityEntry?.credentials().switch()).toBe(
      xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount(),
    );
  });

  it("signs once when the source is the authority, without a fee bump", async () => {
    honest();
    const scheme = new UptoStellarScheme([authoritySigner], { contracts: { [NETWORK]: CONTRACT } });
    const { payload, settleRequirements } = await settleRequest(CAP);
    expect((await scheme.settle(payload, settleRequirements)).success).toBe(true);
    const sent = fake.sent[0] as Transaction;
    expect(sent).toBeInstanceOf(Transaction);
    expect(sent.signatures).toHaveLength(1);
  });

  it("settles zero on-chain by default", async () => {
    honest();
    const { payload, settleRequirements } = await settleRequest(0n);
    const result = await facilitator().settle(payload, settleRequirements);
    expect(result).toMatchObject({ success: true, amount: "0" });
    expect(settledAmount((fake.sent[0] as FeeBumpTransaction).innerTransaction)).toBe(0n);
  });

  it("refuses an amount above the maximum before simulating", async () => {
    const { payload, settleRequirements } = await settleRequest(CAP + 1n);
    expect(await facilitator().settle(payload, settleRequirements)).toMatchObject({
      success: false,
      errorReason: "invalid_upto_stellar_payload_settlement_exceeds_amount",
      transaction: "",
      amount: (CAP + 1n).toString(),
    });
    expect(fake.simulated).toHaveLength(0);
  });

  it("submits one transaction for concurrent repeats and refuses another amount", async () => {
    honest();
    const scheme = facilitator();
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => scheme.settle(payload, settleRequirements)),
      scheme.settle(payload, requirements({ amount: "1" })),
    ]);
    const conflict = results.pop();
    expect(fake.sent).toHaveLength(1);
    expect(results.every(r => r.success && r.transaction === results[0]?.transaction)).toBe(true);
    expect(conflict).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_idempotency_conflict",
      errorMessage: `This authorization was already submitted in another settlement request (transaction ${results[0]?.transaction}).`,
      transaction: results[0]?.transaction,
    });
  });

  it("settles a request whose conflicting predecessor failed before submission", async () => {
    honest();
    fake.simulations.push(errorSimulation([errorEvent(TOKEN, xdr.ScError.sceContract(10))]));
    const scheme = facilitator();
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const [refused, settled] = await Promise.all([
      scheme.settle(payload, requirements({ amount: "1" })),
      scheme.settle(payload, settleRequirements),
    ]);
    expect(refused).toMatchObject({ errorReason: "insufficient_funds", transaction: "" });
    expect(settled).toMatchObject({ success: true, amount: "300000" });
  });

  it("answers pending with the hash, and confirms it on a repeat", async () => {
    honest();
    fake.statuses = Array(30).fill(rpc.Api.GetTransactionStatus.NOT_FOUND);
    const scheme = facilitator();
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const pending = await scheme.settle(payload, settleRequirements);
    expect(pending).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      amount: "300000",
    });
    expect(pending.transaction).toBe(fake.sent[0]?.hash().toString("hex"));
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({
      success: true,
      transaction: pending.transaction,
    });
    expect(fake.sent).toHaveLength(1);
  });

  it("answers a broadcast whose RPC answer was lost as pending with its hash", async () => {
    honest();
    fake.sendTransaction = transaction => {
      fake.sent.push(transaction);
      return Promise.reject(new Error("socket hang up"));
    };
    const { payload, settleRequirements } = await settleRequest(300_000n);
    expect(await facilitator().settle(payload, settleRequirements)).toMatchObject({
      errorReason: "settlement_pending",
      transaction: fake.sent[0]?.hash().toString("hex"),
    });
  });

  it("reports on-chain failure and expiry with the hash", async () => {
    honest();
    const failedWith = (result: xdr.TransactionResultResult) =>
      new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString("100"),
        result,
        ext: new xdr.TransactionResultExt(0),
      });
    for (const [result, code] of [
      [xdr.TransactionResultResult.txFailed([]), "settle_upto_stellar_transaction_failed"],
      [xdr.TransactionResultResult.txTooLate(), "settle_upto_stellar_transaction_expired"],
    ] as const) {
      fake.statuses = [rpc.Api.GetTransactionStatus.FAILED];
      fake.failedResult = failedWith(result);
      const { payload, settleRequirements } = await settleRequest(300_000n);
      const settled = await facilitator().settle(payload, settleRequirements);
      expect(settled).toMatchObject({ success: false, errorReason: code });
      expect(settled.transaction).not.toBe("");
    }
  });

  it("lets a payment be retried when nothing reached the network", async () => {
    honest();
    fake.sendStatus = "ERROR";
    const scheme = facilitator();
    const { payload, settleRequirements } = await settleRequest(300_000n);
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({
      errorReason: "settle_upto_stellar_transaction_submission_failed",
      transaction: "",
    });
    fake.sendStatus = "PENDING";
    const getAccount = fake.getAccount.bind(fake);
    fake.getAccount = () => Promise.reject(new Error("account lookup failed"));
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({
      errorReason: "unexpected_settle_error",
      errorMessage: "account lookup failed",
      transaction: "",
    });
    fake.getAccount = getAccount;
    expect((await scheme.settle(payload, settleRequirements)).success).toBe(true);
    expect(fake.sent).toHaveLength(2);
  });

  it("reports signing failures", async () => {
    honest();
    const refusing = (signer: FacilitatorStellarSigner): FacilitatorStellarSigner => ({
      ...signer,
      signTransaction: () =>
        Promise.resolve({ signedTxXdr: "", error: { message: "hsm offline", code: -1 } }),
    });
    for (const [options, code] of [
      [
        { settlementAuthority: refusing(authoritySigner) },
        "settle_upto_stellar_transaction_signing_failed",
      ],
      [{ feeBumpSigner: refusing(sponsorSigner) }, "settle_upto_stellar_fee_bump_signing_failed"],
    ] as const) {
      const { payload, settleRequirements } = await settleRequest(300_000n);
      expect((await facilitator(options).settle(payload, settleRequirements)).errorReason).toBe(
        code,
      );
    }
  });

  it("answers repeats from the record before the expiration rule", async () => {
    honest();
    const scheme = facilitator();
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const settled = await scheme.settle(payload, settleRequirements);
    expect(settled.success).toBe(true);
    // Inside the margin before E, and after E: the recorded result, or the conflict.
    for (const ledger of [LEDGER + 11, LEDGER + 20]) {
      fake.ledger = ledger;
      expect(await scheme.settle(payload, settleRequirements)).toEqual(settled);
      expect((await scheme.settle(payload, requirements({ amount: "1" }))).errorReason).toBe(
        "settle_upto_stellar_idempotency_conflict",
      );
    }
    // A request without a record still has to pass the window.
    expect((await scheme.settle(await payment(), settleRequirements)).errorReason).toBe(
      "invalid_upto_stellar_signature_expired",
    );
    fake.ledger = LEDGER + 11;
    expect((await scheme.settle(await payment(), settleRequirements)).errorReason).toBe(
      "invalid_upto_stellar_signature_expiration_too_soon",
    );
    // Once the record is dropped, a repeat is refused like any expired authorization.
    fake.ledger = LEDGER + 200;
    expect((await scheme.settle(payload, settleRequirements)).errorReason).toBe(
      "invalid_upto_stellar_signature_expired",
    );
    expect(fake.sent).toHaveLength(1);
  });

  it("polls a pending settlement again on a repeat after the authorization expires", async () => {
    honest();
    fake.statuses = Array(30).fill(rpc.Api.GetTransactionStatus.NOT_FOUND);
    const scheme = facilitator();
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const pending = await scheme.settle(payload, settleRequirements);
    expect(pending.errorReason).toBe("settlement_pending");
    fake.ledger = LEDGER + 30;
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({
      success: true,
      transaction: pending.transaction,
    });
    expect(fake.sent).toHaveLength(1);
  });
});
