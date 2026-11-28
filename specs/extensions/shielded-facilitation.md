# Extension: `shielded-facilitation`

## Summary

The `shielded-facilitation` extension defines how an x402 facilitator
verifies and settles payments whose contents are shielded from public
chain observers. In a shielded settlement, the public ledger shows that
a settlement occurred, but the payment's asset, amount, and memo — and,
in pool profiles, the link between payer and recipient — are not
publicly readable. The facilitator still verifies the payer's signed
authorization and still produces a settlement receipt; what changes is
the evidence the verification runs over and what a third party can
learn from the chain.

It specifies:

1. a **discovery advertisement** by which a facilitator declares the
   shielded profiles it operates, per profile and per network, with an
   honest per-profile capability state (detecting, crediting, live);
2. **settlement semantics** for shielded profiles: what the facilitator
   MUST verify before crediting a resource server, and the rule that a
   shielded settlement that cannot be verified MUST fail closed rather
   than silently degrade to a transparent one;
3. a **shielded receipt claim** — the evidence a recipient uses to
   verify that a shielded settlement happened, without a public
   transaction exposing the payment contents; and
4. two **Solana profiles**: a Privacy Rings profile built on encrypted
   UTXOs with view tags (Helius Privacy Rings / SPR), and a zero-
   knowledge pool profile (Dark Protocol). Further profiles for other
   networks can be added per chain family, as with the transport
   profiles in `agent-messaging`.

**Confidential, not anonymous.** Shielded facilitation hides payment
contents from public observers. It does not hide them from the
facilitator, which keeps the settlement ledger and always learns the
amounts it settles. Profiles differ in what stays public: the Privacy
Rings profile leaves sender and recipient addresses public and hides
asset, amount, and memo; the pool profile additionally breaks the
public payer–recipient link. Neither profile promises anonymity
against the facilitator or against a counterparty, and specifications
or marketing built on this extension MUST NOT claim otherwise.

The payment boundary is unchanged: payers sign, the facilitator
verifies and relays, and no shielded credential grants spending
authority. Shielding changes the visibility of a settlement, never its
authorization model.

## Composition with x402

This extension sits inside the facilitator's side of the payment flow,
not inside the wire protocol between client and resource server:

- It defines **no new payment headers** and does not modify
  `PaymentRequirements`, `PaymentPayload`, or the semantics of any
  scheme. A resource server selects a shielded profile the same way it
  selects a facilitator: by the facilitator's advertised capabilities.
- A facilitator advertises shielded support in its discovery document
  and its `/supported` response (below). A client paying through a
  shielded profile uses the scheme's normal payload; the shielded
  profile governs how the facilitator verifies and settles it.
- The extension composes with `agent-messaging`: a `payment.request`
  message can propose terms that settle through a shielded profile,
  and the resulting `payment.receipt` carries the shielded receipt
  claim defined here. Messaging credentials still cannot authorize the
  payment.
- The extension composes with prepaid schemes (for example a voucher
  scheme): funding a voucher balance can be a shielded settlement, and
  the funding step's visibility follows the profile's rules.

## Discovery and advertisement

A facilitator that operates shielded profiles MUST advertise them in
its discovery document with, per profile:

- the profile identifier (`rings-spr`, `zk-pool`, …);
- the network (CAIP-2) and the assets it shields;
- a **capability state**, one of:
  - `detecting` — the facilitator observes shielded activity (for
    example by scanning encrypted UTXOs for its key ring) but does not
    credit settlements from it;
  - `crediting` — the facilitator credits resource servers from
    verified shielded settlements;
  - `live` — crediting is enabled and settling in production;
- the profile's public parameters a payer needs (key ring identifier,
  view tag, pool program/address), where applicable.

A facilitator MUST NOT advertise a capability state above the one it
actually operates. In particular, a profile whose crediting is
disabled or fail-closed MUST be advertised as `detecting`, never as
`crediting` or `live`. Consumers of the discovery document (resource
servers, directories, the facilitators list) rely on this honesty:
shielded support is a claim about a running system, not about a
roadmap.

Example (abridged) discovery fragment:

```json
{
  "extensions": ["shielded-facilitation"],
  "shielded": [
    {
      "profile": "rings-spr",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "state": "detecting",
      "keyRing": "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW",
      "viewTag": "5Vt1…H55M"
    },
    {
      "profile": "zk-pool",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "state": "detecting"
    }
  ]
}
```

## Settlement semantics

For a settlement under a shielded profile, the facilitator MUST:

1. verify the payer's authorization exactly as the underlying scheme
   requires (signature, amount, asset, recipient, validity window) —
   shielding never relaxes scheme verification;
2. verify the shielded evidence for the profile (a proof, an encrypted
   UTXO set, or a pool note/nullifier, per the profile) before
   crediting;
3. credit the resource server only after both verifications pass, and
   record the settlement in its ledger with a shielded receipt claim
   (below);
4. **fail closed**: if shielded evidence cannot be verified — the
   scanning backend is unavailable, the proof system rejects, the
   profile's crediting is disabled — the facilitator MUST refuse the
   settlement with a shielded-specific error. It MUST NOT fall back to
   a transparent settlement unless the payer's payload explicitly
   opted into transparent fallback.

Replay protection follows the underlying scheme and the profile: a
shielded evidence item (a UTXO, a nullifier, a voucher) is single-use
per settlement, and the facilitator's ledger is the record of what has
been consumed.

## Shielded receipt claims

A shielded settlement produces a **receipt claim**: a facilitator-
signed statement binding the settlement's identifier, the profile, the
network, and a commitment to the payment contents (for example a hash
of the note or the encrypted UTXO identifiers), without publishing the
contents themselves. The claim is evidence the facilitator settled; it
is not itself a settlement.

- A recipient verifies a claim by checking the facilitator's signature
  and the commitment against the evidence it holds (its own view of
  the pool or ring), never from a message alone — the same discipline
  `agent-messaging` applies to `payment.receipt` messages.
- Claims are safe to relay through untrusted channels (including the
  `agent-messaging` mailbox): they reveal the settlement identifier
  and the commitment, not the asset, amount, or parties beyond what
  the profile leaves public.

## Profile: Solana Privacy Rings (`rings-spr`)

The Privacy Rings profile settles over encrypted UTXOs on Solana,
using the Helius Privacy Rings (SPR) infrastructure:

- The facilitator operates a **key ring** and publishes a **view tag**.
  Payers encrypt payment outputs to the ring; the asset, amount, and
  memo inside an output are hidden from public observers. Sender and
  recipient addresses remain public in this profile.
- The facilitator **detects** incoming shielded outputs by scanning
  for encrypted UTXOs matching its view tag (SPR
  `getEncryptedUtxosByTags`), and **credits** a resource server when a
  detected output satisfies a verified payment authorization.
- The public → private funding step (a payer's first deposit into the
  ring) is as public as a normal transfer. Privacy accrues to payments
  made from already-funded shielded balances; implementations MUST
  surface this to payers rather than imply the funding step is hidden.
- Crediting requires a viewing-authority decryptor under the
  facilitator's control. Until that decryptor is provisioned, a
  conforming deployment operates in `detecting` state and its crediting
  path stays fail-closed.

## Profile: Solana ZK pool (`zk-pool`)

The ZK pool profile settles through a zero-knowledge shielded pool on
Solana (Dark Protocol):

- Payers deposit assets into the pool and pay out of it with notes:
  private commitments spent with a zero-knowledge proof (Groth16 in
  the reference implementation) and a public nullifier that prevents
  double-spending without revealing which note was spent.
- Because deposits and withdrawals are unlinkable to public observers
  (subject to pool anonymity-set size and timing), this profile hides
  the payer–recipient link as well as the payment contents.
- Note encryption MUST use a real key exchange the recipient can
  recompute (for example X25519 ECDH between sender and recipient
  keys). A construction in which only the sender can derive the note
  key — so the recipient cannot recover the note — does not conform.
- The facilitator verifies proofs and nullifiers before crediting,
  under the same fail-closed rule as every profile.

## Security considerations

- **The facilitator learns amounts.** Shielding is against public
  observers, not against the facilitator, which keeps the ledger.
  Deployments MUST state this plainly; "confidential" is the correct
  word, "anonymous" is not.
- **Funding-step visibility.** In both specified profiles, moving
  funds from a public balance into the shielded system is a public
  transfer. Privacy claims apply to payments made after funding.
- **Anonymity set and timing.** Pool unlinkability depends on the
  pool's anonymity set and on deposit/withdrawal timing correlation.
  Profiles SHOULD publish pool size so payers can judge the set they
  are joining.
- **Proof-system agility.** Groth16 proofs are not post-quantum
  secure: a quantum adversary could forge pool withdrawals.
  Implementations SHOULD plan a migration path to hash-based proof
  systems and MUST NOT present the current proof system as
  quantum-resistant.
- **Key custody.** Ring viewing keys and pool viewing authority are
  settlement-critical secrets: whoever holds them can deanonymize the
  contents they cover. They belong in the facilitator's key custody,
  never in client payloads, discovery documents, or logs.
- **No authority expansion.** A shielded credential, view tag, or
  receipt claim never authorizes a payment. Authorization remains the
  payer's scheme signature, verified as usual.

## Conformance

An implementation conforms for a profile if:

- its discovery advertisement matches its operated capability state
  (a `detecting` deployment fails any test that expects crediting, and
  passes the fail-closed tests);
- scheme verification is never relaxed for shielded settlements;
- an unverifiable shielded settlement is refused, with no transparent
  fallback absent an explicit payer opt-in;
- receipt claims verify against the facilitator's published keys and
  the profile's evidence, and reveal nothing beyond the profile's
  public surface;
- for `zk-pool`, note encryption passes a recipient-recovery vector:
  a note encrypted by a sender can be recomputed and spent by its
  intended recipient.

## Reference deployment

The x402.wtf facilitator hub operates the reference deployment of this
extension on its shielded edition, https://dark.x402.wtf:

- `rings-spr` on Solana mainnet: **detecting, live in production** —
  the hub scans its key ring (`ring1GaL…ANW`) for encrypted UTXOs via
  Helius Privacy Rings and reports detections at
  `https://dark.x402.wtf/api/private/status`. Crediting is disabled by
  design (Rings step 2) and the crediting path is fail-closed, as this
  specification requires of a `detecting` deployment.
- `zk-pool` (Dark Protocol, https://protocol.darkx402.com): the pool
  program is live on Solana devnet and pre-mainnet; the profile is
  specified here ahead of its mainnet crediting state.
- The hub's transparent rails (Solana, Base, Robinhood Chain,
  HyperEVM, Bitcoin, Lightning, Cardano) are unaffected by this
  extension and are listed in the facilitators documentation.

Status as of 2026-11-25. This extension is a specification
contribution; the reference implementation is not part of this
repository's packages.
