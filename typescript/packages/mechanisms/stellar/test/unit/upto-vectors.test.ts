import { readFileSync } from "node:fs";
import {
  Keypair,
  Networks,
  buildAuthorizationEntryPreimage,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { termsFromScVal, termsToScVal } from "../../src/upto";
import { checkUptoPayment } from "../../src/upto/facilitator/rules";
import {
  VECTORS_PATH,
  renderUptoVectors,
  type UptoVectors,
} from "../fixtures/upto-stellar-vectors";
import type { PaymentRequirements } from "@x402/core/types";

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as UptoVectors;
const requirements = vectors.check.requirements as PaymentRequirements;
const context = {
  contract: vectors.contract,
  authority: vectors.authority,
  facilitatorAddresses: new Set([vectors.authority]),
  currentLedger: vectors.check.currentLedger,
  ledgerSeconds: vectors.check.ledgerSeconds,
  maxTimeoutSeconds: vectors.check.maxTimeoutSeconds,
};
const check = (
  phase: "verify" | "settle",
  payload: Record<string, unknown>,
  overrides: Partial<PaymentRequirements> = {},
  amount?: string,
) => {
  const accepted = { ...requirements, ...overrides };
  return checkUptoPayment(
    { x402Version: 2, accepted, payload },
    { ...accepted, amount: amount ?? accepted.amount },
    { phase, ...context },
  );
};

describe("upto test vectors", () => {
  it("are up to date with the generator", async () => {
    expect(readFileSync(VECTORS_PATH, "utf8")).toBe(await renderUptoVectors());
  });

  it("derive the parties from the seeds and encode the terms as a sorted map", () => {
    const key = (seed: string) => Keypair.fromRawEd25519Seed(Buffer.from(seed, "hex")).publicKey();
    expect(
      [vectors.seeds.payer, vectors.seeds.authority, vectors.seeds.recipient].map(key),
    ).toEqual([vectors.payer, vectors.authority, vectors.recipient]);
    const value = xdr.ScVal.fromXDR(vectors.termsXdr, "base64");
    const terms = termsFromScVal(value);
    expect(terms).toEqual({ ...vectors.terms, maxAmount: BigInt(vectors.terms.maxAmount) });
    expect(terms && termsToScVal(terms).toXDR("base64")).toBe(vectors.termsXdr);
  });

  it.each(["address", "address_v2"] as const)(
    "sign the %s preimage deterministically",
    credential => {
      const arm = vectors.credentials[credential];
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(arm.authorization, "base64");
      const preimage = buildAuthorizationEntryPreimage(
        entry,
        vectors.terms.expirationLedger,
        Networks.TESTNET,
      );
      expect(preimage.toXDR("base64")).toBe(arm.preimageXdr);
      expect(hash(preimage.toXDR()).toString("hex")).toBe(arm.payloadSha256);
      expect(
        Keypair.fromPublicKey(vectors.payer).verify(
          Buffer.from(arm.payloadSha256, "hex"),
          Buffer.from(arm.signature, "hex"),
        ),
      ).toBe(true);
      expect(entry.rootInvocation().toXDR("base64")).toBe(vectors.rootInvocationXdr);
      expect(entry.rootInvocation().subInvocations()[0]?.toXDR("base64")).toBe(
        vectors.approveInvocationXdr,
      );
    },
  );

  it("give the settle call and the authority entry per amount", () => {
    for (const settle of [...vectors.settle, ...vectors.contractPayer.settle]) {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(settle.authorityEntryXdr, "base64");
      expect(entry.credentials().switch()).toBe(
        xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount(),
      );
      expect(entry.rootInvocation().function().contractFn().toXDR("base64")).toBe(
        settle.invokeContractArgsXdr,
      );
    }
    expect(vectors.settle.map(settle => settle.amount)).toEqual(["1000000", "300000", "0"]);
  });

  it("sign the contract-account payer's entry with a raw ed25519 signature", () => {
    const arm = vectors.contractPayer;
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(arm.authorization, "base64");
    const signature = entry.credentials().address().signature().bytes();
    expect(
      Keypair.fromPublicKey(vectors.payer).verify(Buffer.from(arm.payloadSha256, "hex"), signature),
    ).toBe(true);
  });

  it("accept the unmodified payments at both phases, up to the whole maximum", () => {
    const { address } = vectors.credentials;
    for (const [phase, amount] of [
      ["verify", "1000000"],
      ["settle", "300000"],
      ["settle", "0"],
    ] as const) {
      const result = check(phase, { authorization: address.authorization }, {}, amount);
      expect(result.ok && result.payment.amount).toBe(BigInt(amount));
    }
    for (const signerAuthorizations of [
      undefined,
      [vectors.contractPayer.delegatedSignerAuthorization],
    ]) {
      const result = check("verify", {
        authorization: vectors.contractPayer.authorization,
        signerAuthorizations,
      });
      expect(result.ok && result.payment.payer).toBe(vectors.contractPayer.address);
    }
  });

  it.each(vectors.negatives.map(n => [n.name, n] as const))("refuse %s", (_name, negative) => {
    const { authorization, signerAuthorizations } = negative;
    const result = check(
      negative.phase ?? "verify",
      { authorization, ...(signerAuthorizations === undefined ? {} : { signerAuthorizations }) },
      negative.requirements as Partial<PaymentRequirements> | undefined,
      negative.amount,
    );
    expect(result.ok ? "accepted" : result.rejection.code).toBe(negative.expectedCode);
  });
});
