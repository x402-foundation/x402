import { actionCreators } from "@near-js/transactions";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { ExactNearScheme } from "../../src/exact/facilitator/scheme";
import { SettlementCache } from "../../src/settlement-cache";
import { settlementCacheKey } from "../../src/utils";
import {
  EMPTY_CONTRACT_CODE_HASH,
  buildSignedDelegateB64,
  makePayload,
  makeRequirements,
  mockFacilitatorSigner,
  tamperSignature,
} from "./fixtures/near.fixture";

/**
 * Builds a scheme + a verified result for the canonical happy-path fixture.
 *
 * @param signerOptions - Mock signer overrides.
 * @returns The scheme and a freshly built valid payload + requirements.
 */
async function validSetup(signerOptions = {}) {
  const requirements = makeRequirements();
  const { b64 } = await buildSignedDelegateB64();
  const scheme = new ExactNearScheme(mockFacilitatorSigner(signerOptions));
  return { scheme, requirements, payload: makePayload(b64, requirements), b64 };
}

describe("near facilitator verify", () => {
  it("verifies a valid NEAR exact payload and attributes the payer", async () => {
    const { scheme, requirements, payload } = await validSetup();
    const result = await scheme.verify(payload, requirements);
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("alice.testnet");
  });

  it("does not require relayer extra and exposes relayer via getSigners only", () => {
    const scheme = new ExactNearScheme(mockFacilitatorSigner());
    expect(scheme.getExtra("near:testnet")).toBeUndefined();
    expect(scheme.getSigners("near:testnet")).toEqual(["relayer.testnet"]);
  });

  it("rejects wrong x402 version", async () => {
    const { scheme, requirements, payload } = await validSetup();
    const result = await scheme.verify({ ...payload, x402Version: 1 }, requirements);
    expect(result.invalidReason).toBe("invalid_x402_version");
  });

  it("rejects non-NEAR network and network mismatch", async () => {
    const { b64 } = await buildSignedDelegateB64();
    const scheme = new ExactNearScheme(mockFacilitatorSigner());

    const evmReqs = makeRequirements({ network: "eip155:8453" as PaymentRequirements["network"] });
    expect((await scheme.verify(makePayload(b64, evmReqs), evmReqs)).invalidReason).toBe(
      "invalid_network",
    );

    const mainnetReqs = makeRequirements({ network: "near:mainnet" });
    const testnetAccepted = makeRequirements({ network: "near:testnet" });
    expect(
      (await scheme.verify(makePayload(b64, testnetAccepted), mainnetReqs)).invalidReason,
    ).toBe("invalid_exact_near_network_mismatch");
  });

  it("rejects asset/payTo/amount/timeout requirement mismatches", async () => {
    const { b64 } = await buildSignedDelegateB64();
    const scheme = new ExactNearScheme(mockFacilitatorSigner());
    const reqs = makeRequirements();

    const cases: Array<[Partial<PaymentRequirements>, string]> = [
      [{ asset: "other.testnet" }, "invalid_exact_near_asset_mismatch"],
      [{ payTo: "other.testnet" }, "invalid_exact_near_pay_to_mismatch"],
      [{ amount: "2" }, "invalid_exact_near_amount_mismatch"],
    ];
    for (const [acceptedOverride, reason] of cases) {
      const accepted = makeRequirements(acceptedOverride);
      expect((await scheme.verify(makePayload(b64, accepted), reqs)).invalidReason).toBe(reason);
    }

    const zeroTimeout = makeRequirements({ maxTimeoutSeconds: 0 });
    expect((await scheme.verify(makePayload(b64, zeroTimeout), zeroTimeout)).invalidReason).toBe(
      "invalid_exact_near_max_timeout",
    );
  });

  it("rejects a malformed payload and an undecodable delegate action", async () => {
    const scheme = new ExactNearScheme(mockFacilitatorSigner());
    const reqs = makeRequirements();

    const noField = { x402Version: 2, accepted: reqs, payload: {} } as never;
    expect((await scheme.verify(noField, reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_shape",
    );

    expect((await scheme.verify(makePayload("@@not-borsh@@", reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_signed_delegate_action",
    );
  });

  it("rejects an invalid signature without attributing a payer", async () => {
    const { b64 } = await buildSignedDelegateB64();
    const reqs = makeRequirements();
    const scheme = new ExactNearScheme(mockFacilitatorSigner());
    const result = await scheme.verify(makePayload(tamperSignature(b64), reqs), reqs);
    expect(result.invalidReason).toBe("invalid_exact_near_payload_signature");
    expect(result.payer).toBeUndefined();
  });

  it("rejects relayer-as-payer (spec §3)", async () => {
    const { b64 } = await buildSignedDelegateB64();
    const reqs = makeRequirements();
    const scheme = new ExactNearScheme(mockFacilitatorSigner({ relayerIds: ["alice.testnet"] }));
    const result = await scheme.verify(makePayload(b64, reqs), reqs);
    expect(result.invalidReason).toBe("invalid_exact_near_relayer_cannot_be_payer");
    expect(result.payer).toBe("alice.testnet");
  });

  it("rejects extra actions and non-ft_transfer intents (spec §6/§7)", async () => {
    const reqs = makeRequirements();
    const scheme = new ExactNearScheme(mockFacilitatorSigner());

    const twoActions = await buildSignedDelegateB64({
      actions: [
        actionCreators.functionCall(
          "ft_transfer",
          { receiver_id: reqs.payTo, amount: reqs.amount },
          30_000_000_000_000n,
          1n,
        ),
        actionCreators.functionCall(
          "ft_transfer",
          { receiver_id: reqs.payTo, amount: reqs.amount },
          30_000_000_000_000n,
          1n,
        ),
      ],
    });
    expect((await scheme.verify(makePayload(twoActions.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_action_count",
    );

    const transferKind = await buildSignedDelegateB64({ actions: [actionCreators.transfer(1n)] });
    expect((await scheme.verify(makePayload(transferKind.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_action_kind",
    );

    const wrongMethod = await buildSignedDelegateB64({ methodName: "storage_deposit" });
    expect((await scheme.verify(makePayload(wrongMethod.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_method_name",
    );
  });

  it("rejects token/recipient/amount/deposit/gas exactness violations (spec §7)", async () => {
    const reqs = makeRequirements();
    const scheme = new ExactNearScheme(mockFacilitatorSigner());

    const wrongToken = await buildSignedDelegateB64({ receiverId: "other.testnet" });
    expect((await scheme.verify(makePayload(wrongToken.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_token_contract_mismatch",
    );

    const wrongRecipient = await buildSignedDelegateB64({ ftReceiver: "attacker.testnet" });
    expect((await scheme.verify(makePayload(wrongRecipient.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_recipient_mismatch",
    );

    const wrongAmount = await buildSignedDelegateB64({ amount: "999999" });
    expect((await scheme.verify(makePayload(wrongAmount.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_amount_mismatch",
    );

    const wrongDeposit = await buildSignedDelegateB64({ deposit: 0n });
    expect((await scheme.verify(makePayload(wrongDeposit.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_attached_deposit",
    );

    const tooMuchGas = await buildSignedDelegateB64({ gas: 200_000_000_000_000n });
    expect((await scheme.verify(makePayload(tooMuchGas.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_gas_limit_exceeded",
    );
  });

  it("enforces expiry and the deterministic timeout window (spec §5)", async () => {
    const reqs = makeRequirements();

    const expired = await buildSignedDelegateB64({ maxBlockHeight: 500n });
    const expiredScheme = new ExactNearScheme(mockFacilitatorSigner({ blockHeight: 1000n }));
    expect((await expiredScheme.verify(makePayload(expired.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_delegate_action_expired",
    );

    const tooFar = await buildSignedDelegateB64({ maxBlockHeight: 2000n });
    const tooFarScheme = new ExactNearScheme(mockFacilitatorSigner({ blockHeight: 1000n }));
    expect((await tooFarScheme.verify(makePayload(tooFar.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_delegate_action_timeout_window_exceeds_max_timeout",
    );
  });

  it("enforces nonce range and onchain nonce replay (spec §5)", async () => {
    const reqs = makeRequirements();

    const outOfRange = await buildSignedDelegateB64({
      nonce: 2_000_000_000n,
      maxBlockHeight: 1060n,
    });
    const s1 = new ExactNearScheme(mockFacilitatorSigner({ blockHeight: 1000n }));
    expect((await s1.verify(makePayload(outOfRange.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_delegate_action_nonce_out_of_range",
    );

    const reused = await buildSignedDelegateB64({ nonce: 5n, maxBlockHeight: 1060n });
    const s2 = new ExactNearScheme(
      mockFacilitatorSigner({
        blockHeight: 1000n,
        accessKey: { nonce: 10n, permissionKind: "FullAccess" },
      }),
    );
    expect((await s2.verify(makePayload(reused.b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_payload_delegate_action_nonce_already_used",
    );
  });

  it("enforces access-key existence and permission (spec §5/§8)", async () => {
    const { b64 } = await buildSignedDelegateB64();
    const reqs = makeRequirements();

    const missing = new ExactNearScheme(mockFacilitatorSigner({ accessKey: null }));
    expect((await missing.verify(makePayload(b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_access_key_not_found",
    );

    const fnKey = new ExactNearScheme(
      mockFacilitatorSigner({ accessKey: { nonce: 0n, permissionKind: "FunctionCall" } }),
    );
    expect((await fnKey.verify(makePayload(b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_function_call_key_not_allowed",
    );

    const unknownKey = new ExactNearScheme(
      mockFacilitatorSigner({ accessKey: { nonce: 0n, permissionKind: "Unknown" } }),
    );
    expect((await unknownKey.verify(makePayload(b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_unsupported_access_key_permission",
    );
  });

  it("performs chain-state preflight (spec §9)", async () => {
    const { b64 } = await buildSignedDelegateB64();
    const reqs = makeRequirements();

    const noSender = new ExactNearScheme(
      mockFacilitatorSigner({ accounts: { "alice.testnet": null } }),
    );
    expect((await noSender.verify(makePayload(b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_sender_account_not_found",
    );

    const noToken = new ExactNearScheme(
      mockFacilitatorSigner({ accounts: { "usdc.testnet": null } }),
    );
    expect((await noToken.verify(makePayload(b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_token_account_not_found",
    );

    const noCode = new ExactNearScheme(
      mockFacilitatorSigner({
        accounts: { "usdc.testnet": { codeHash: EMPTY_CONTRACT_CODE_HASH } },
      }),
    );
    expect((await noCode.verify(makePayload(b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_token_contract_no_code",
    );

    const lowBalance = new ExactNearScheme(mockFacilitatorSigner({ balance: 1n }));
    expect((await lowBalance.verify(makePayload(b64, reqs), reqs)).invalidReason).toBe(
      "insufficient_funds",
    );

    const noStorage = new ExactNearScheme(
      mockFacilitatorSigner({ storage: { supported: true, registered: false } }),
    );
    expect((await noStorage.verify(makePayload(b64, reqs), reqs)).invalidReason).toBe(
      "invalid_exact_near_recipient_not_registered_for_storage",
    );

    const noNep145 = new ExactNearScheme(mockFacilitatorSigner({ storage: { supported: false } }));
    expect((await noNep145.verify(makePayload(b64, reqs), reqs)).isValid).toBe(true);
  });

  it("fails closed when chain state cannot be determined (spec §5/§9)", async () => {
    const { b64 } = await buildSignedDelegateB64();
    const reqs = makeRequirements();
    const scheme = new ExactNearScheme(
      mockFacilitatorSigner({ blockHeightError: new Error("rpc down") }),
    );
    const result = await scheme.verify(makePayload(b64, reqs), reqs);
    expect(result.invalidReason).toBe("invalid_exact_near_current_block_height_unavailable");
    expect(result.payer).toBe("alice.testnet");
  });

  it("returns the core unexpected verify error code and message for unexpected errors", async () => {
    const { b64 } = await buildSignedDelegateB64();
    const reqs = makeRequirements();
    const signer = mockFacilitatorSigner();
    const scheme = new ExactNearScheme({
      ...signer,
      getRelayerIds: () => {
        throw new Error("relayer lookup exploded");
      },
    });

    const result = await scheme.verify(makePayload(b64, reqs), reqs);

    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      invalidMessage: "relayer lookup exploded",
    });
    expect(result.payer).toBeUndefined();
  });
});

describe("near facilitator settle", () => {
  it("settles after the inner ft_transfer receipt succeeds (spec §7)", async () => {
    const { scheme, requirements, payload } = await validSetup();
    const result = await scheme.settle(payload, requirements);
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("FIXTURETX");
    expect(result.payer).toBe("alice.testnet");
  });

  it("reports failure when the inner receipt fails", async () => {
    const requirements = makeRequirements();
    const { b64 } = await buildSignedDelegateB64();
    const scheme = new ExactNearScheme(
      mockFacilitatorSigner({
        outcome: {
          transaction: "TX2",
          innerReceipt: { kind: "failure", error: "NotEnoughBalance" },
        },
      }),
    );
    const result = await scheme.settle(makePayload(b64, requirements), requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("settlement_failed");
    expect(result.errorMessage).toBe("NotEnoughBalance");
    expect(result.transaction).toBe("TX2");
  });

  it("does not submit when verification fails", async () => {
    const requirements = makeRequirements();
    let submitted = false;
    const scheme = new ExactNearScheme(
      mockFacilitatorSigner({ onSubmit: () => (submitted = true) }),
    );
    const result = await scheme.settle(
      makePayload(tamperSignature((await buildSignedDelegateB64()).b64), requirements),
      requirements,
    );
    expect(result.success).toBe(false);
    expect(submitted).toBe(false);
  });

  it("rejects duplicate in-flight settlements (spec §10)", async () => {
    const requirements = makeRequirements();
    const { b64 } = await buildSignedDelegateB64();
    const cache = new SettlementCache();
    const scheme = new ExactNearScheme(mockFacilitatorSigner(), cache);

    // Mark this payload as already in flight.
    cache.isDuplicate(settlementCacheKey(b64), 1060n);

    const result = await scheme.settle(makePayload(b64, requirements), requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("duplicate_settlement");
  });
});
