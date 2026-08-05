# Extension: `personhood`

## Summary

The `personhood` extension lets a resource server require, alongside payment, **proof that a real, unique human stands behind the paying agent** — verified against public on-chain state, with no centralized gatekeeper. It standardizes the "verified-resource gate": **paid AND personhood-proven**.

This is a **Server ↔ Client** extension. The Facilitator is not involved in the personhood check.

The extension is proof-of-personhood-scheme agnostic. A scheme identifier (`por`, `worldid`, …) names the credential system; this document defines the requirement, how it is advertised and echoed, and how it is verified — not the internals of any one scheme.

## Motivation

As autonomous agents become buyers, "charge per call" is necessary but not sufficient. A paid endpoint is still trivially **sybil-farmed**: one operator spins up thousands of agents, each paying dust, to scrape, drain rate-limited quotas, claim per-identity rewards, or grief. Payment proves *funds*, not *who is behind the request*.

Services selling to agents want a cheap, open way to say *"one real human per agent."* Today they reach for centralized KYC, captchas (which agents can't and shouldn't solve), or API-key allowlists — all of which break the permissionless, agent-native promise of x402.

## The binding is two facts, checked separately

A personhood claim about a party is established by proving:

- **(A) That party controls address `X`.**
- **(B) That `X` holds a credential meeting the required `scheme` / `minLevel` / `unique`.**

Fact B is a plain on-chain read: any third party can check it against public state without the holder participating at verification time. Fact A is whatever proof of address control the flow already produces.

The extension MUST NOT trust a client-claimed identity. The address is always **derived** from a signature, never read from a field.

**For the paying agent, the payment is the proof of control.** The agent signs the x402 payment with a key that holds a credential; the server derives the payer from the signed payment and checks fact B against it. No extra challenge round-trip, and the economic act uses cryptographically the same key as the identity claim — the payment does double duty.

That is a convenience of the payer case, not the mechanism. Where the credentialed party is not the one paying, fact A is supplied by an explicit signature instead ([§Parties that do not pay](#parties-that-do-not-pay)). The credential check is identical in both.

## PaymentRequired

A Server advertises a personhood requirement by including the `personhood` key in the `extensions` object of the `402 Payment Required` response.

```json
{
  "x402Version": "2",
  "accepts": [
    {
      "scheme": "exact",
      "network": "sui:mainnet",
      "amount": "10000",
      "asset": "0x2::sui::SUI",
      "payTo": "0xa1b2c3d4e5f6708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
      "maxTimeoutSeconds": 60
    }
  ],
  "extensions": {
    "personhood": {
      "scheme": "por",
      "network": "sui:mainnet",
      "minLevel": "DeviceHuman",
      "unique": true
    }
  }
}
```

| Field      | Type      | Required | Description                                                                                          |
| ---------- | --------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `scheme`   | `string`  | Required | Proof-of-personhood scheme identifier (e.g. `por`, `worldid`).                                        |
| `network`  | `string`  | Required | CAIP-2 network where the credential is read. MAY differ from the payment network.                     |
| `minLevel` | `string`  | Required | Minimum assurance level required, interpreted by `scheme`.                                            |
| `unique`   | `boolean` | Optional | Whether a uniqueness proof is required. Defaults to `false`. See [§Scope and caveats](#scope-and-caveats). |

A Server MUST advertise `personhood` in the same `402` response that carries `accepts`, so a client learns the requirement before paying.

## PaymentPayload

A Client MAY echo the `personhood` key in the `extensions` object of its `PaymentPayload` to reference the credential it expects to satisfy the requirement.

```json
{
  "x402Version": "2",
  "accepted": { "scheme": "exact", "network": "sui:mainnet", "...": "..." },
  "payload": { "...": "..." },
  "extensions": {
    "personhood": {
      "scheme": "por",
      "credentialRef": "0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0"
    }
  }
}
```

| Field           | Type     | Required | Description                                                                              |
| --------------- | -------- | -------- | ------------------------------------------------------------------------------------------ |
| `scheme`        | `string` | Required | Echo of the advertised scheme identifier.                                                |
| `credentialRef` | `string` | Optional | A hint identifying the credential, to save the Server a lookup.                          |

`credentialRef` is a **hint only**. A Server MUST verify the credential on-chain against the address it derived from the signature, and MUST NOT accept `credentialRef` as evidence of anything. A Client that omits the echo entirely is still served if the derived address satisfies the requirement — the echo is an optimization, never the proof.

## Verification

```
1. agent  → GET resource
2. server → 402  { accepts: [...], extensions: { personhood } }
3. agent  → GET resource  (payment signed by a personhood-bearing key)
4. server:  payer := senderOf(payment)          # derived, not claimed
            verify personhood(payer) on-chain   # FIRST — before settling
            if !ok → 403                        # agent is never charged
            settle payment via facilitator
            recompute settlement on-chain       # don't trust, recompute
          → 200 + resource
```

Ordering is normative: a Server MUST evaluate the personhood requirement **before** settling payment, so an unverified agent is rejected without being charged.

A Server MUST return `403 Forbidden` when payment would otherwise be acceptable but the personhood requirement is unmet, and the response SHOULD state which of `scheme` / `minLevel` / `unique` failed, so a client can tell "wrong credential" from "no credential."

## Parties that do not pay

Some flows need a personhood claim about a party who never signs a payment — most concretely, a **data subject** whose attribute is being disclosed and who consents to that disclosure ([#2734](https://github.com/x402-foundation/x402/issues/2734)). The payer is the reader; the subject is a different party, and no payment signature exists to derive them from.

The same two facts apply, with fact A supplied explicitly:

- **(A) Control of address `X`** — the party signs the document carrying their decision (a consent grant, a mandate, an authorization) with the key for `X`, using an off-chain personal-message signature. No transaction, no gas, no on-chain footprint. The verifier recovers `X` from the signature; it is never claimed in a field.
- **(B) Credential at `X`** — verified exactly as in the payer case, against the same `scheme` / `minLevel` / `unique` shape, by the same public on-chain read.

A document verified this way carries the property *"signed by a credentialed unique human."* That is what makes a per-party payout resistant to fabricated parties: where a protocol settles value to subjects, creating subjects is otherwise free, because keypairs are free. Requiring fact B for the signing key makes it cost one credentialed human per scope.

The requirement for a non-paying party is stated in the same scheme-keyed shape as the `extensions.personhood` object above, so a composing extension states the requirement abstractly and any conforming scheme satisfies it.

**This extension defines the requirement and its verification only.** It does not define the document being signed, which belongs to the composing extension.

## Trustlessness

Both gates are independently checkable; no operator trust is required.

- **Payment** — recompute the net transfer to `payTo` from the settlement digest (the [settlement-receipt binding](https://github.com/x402-foundation/x402/pull/2666) pattern).
- **Personhood** — the credential and, under `unique: true`, the uniqueness proof are on-chain objects. Anyone can verify the derived address controls them from public state, without the holder's cooperation. In the first reference implementation (PoR on Sui) the credential is a soulbound owned object, so "holds a credential" is ownership of that object by the derived address: no delegation step, no separately registered key.

## Scope and caveats

- **Personhood is not authority.** This proves a unique human is *behind* the agent. It does **not** prove the agent is authorized to act for that human, and it is not KYC or KYB. It MUST NOT be used as an authorization or compliance primitive.
- **Assurance is a spectrum.** A device-plus-liveness level is weaker than a uniqueness-backed one; `unique: true` is what delivers sybil-resistance. A resource should require the level its threat model needs and no more.
- **Uniqueness is correlatable — it is not a privacy primitive.** A uniqueness proof under `unique: true` is a public fact about a persistent identifier. In the first reference implementation that identifier is **one global nullifier per human per deployment**, stored in a public table and emitted in an event, so every resource that sees it sees the same value. Requiring `unique: true` is therefore a decision to make a party linkable across every verifier using that deployment. Do not treat a nullifier as a scope-local or per-application identifier unless the scheme in question actually derives one — the underlying circuit here admits a per-context nullifier, but the deployment pins a single context and rejects proofs for any other. Where a party needs only a stable key for their own audit trail, the address they already signed with is the weaker and better choice.
- **The credential read is public.** A verifier learns that the derived address holds a qualifying credential. Servers should not treat the check as private to the transaction.

## Relationship to other work

- **[Settlement-receipt binding](https://github.com/x402-foundation/x402/pull/2666)** — composable. A receipt can additionally bind the personhood proof, producing a signed, recomputable record of *who* (a unique human) paid *what*.
- **[`sign-in-with-x`](./sign-in-with-x.md)** — complementary and non-overlapping. SIWX establishes fact A (control of an address) for an authenticated, possibly non-paying reader; this extension supplies fact B (that address holds a personhood credential). A deployment needing both can use SIWX for control and `personhood` for the credential check.
- **[Consent-binding and subject-settlement (#2734)](https://github.com/x402-foundation/x402/issues/2734)** — composes above this extension. It carries the consent grant and the settlement division; this extension supplies the requirement that the grant-signing key is a credentialed unique human, which is what makes a required per-subject payout resistant to fabricated subjects.

## Open questions

1. Credential **freshness and expiry** semantics in the challenge — should the requirement carry a maximum credential age?
2. Should a resource state the **exact credential type or registry** it trusts, or a scheme identifier plus discovery?
3. **Privacy.** The on-chain check is public, and under `unique: true` the nullifier is a cross-verifier correlator (see [§Scope and caveats](#scope-and-caveats)). Hashing resource-side metadata does not address this, because the correlatable value originates on-chain. The real options are scheme-level: per-scope nullifier derivation, or a predicate proof showing "holds ≥ L, is unique" without revealing a persistent identifier. Neither exists in the first reference implementation today.
4. A standard response-header shape for conveying the verified level back to the client.
