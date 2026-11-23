# New network scheme spec

Checklist for authoring a new per-network scheme spec file (`scheme_<name>_<chain>.md`). Follow the [general spec rules](../SKILL.md) as well.

## Spec contents

- Scheme-specific information (e.g. in `PaymentRequired`) goes in `extra`, not in `extensions` or at the top level.
- Define any scheme-specific `extra` fields (optional/required, with description), and show them in `PaymentRequired`, `PaymentPayload`, and `SettlementResponse` messages or `supported/` examples.
- Every field placed in `PaymentRequired.extra` must be consumed by the client to construct the payment or by the facilitator to verify or settle it; do not include human-readable or otherwise purely informational fields.

## Compliance and conventions

- Comply with the network-agnostic scheme definition (e.g. `scheme_exact_<network>.md` complies with [`scheme_exact.md`](../../../../specs/schemes/exact/scheme_exact.md)).
- Reuse field names already established by existing schemes instead of coining new ones. For example, when the scheme must name the account that sponsors network fees (typically the facilitator), use `extra.feePayer` as in [`scheme_exact_svm.md`](../../../../specs/schemes/exact/scheme_exact_svm.md); when the scheme offers more than one payload format, use `extra.assetTransferMethod` to select among them as in [`scheme_exact_evm.md`](../../../../specs/schemes/exact/scheme_exact_evm.md).
- Write one spec per virtual machine family, not per chain. EVM chains need no new spec.
- Confirm the CAIP-2 identifier with the chain's own team.

## Fee sponsorship and infrastructure

- Fee sponsorship is strongly preferred; clients and servers should not need to pay gas or hold the native token.
- The server should not need an RPC; the client may use an RPC; a facilitator RPC can be considered a given.
- If the network cannot sponsor fees, say so in the spec and advertise `extra.areFeesSponsored: false`.

## Statelessness

- Stateless design is strongly preferred for client and server, and especially the facilitator. A short-lived cache is acceptable but needs to be well justified (see the duplicate-settlement mitigation in [`scheme_exact_svm.md`](../../../../specs/schemes/exact/scheme_exact_svm.md#duplicate-settlement-mitigation-recommended)). Persistent storage warrants discussion with maintainers.
- The reason is portability: if a scheme needs state held by one facilitator, a server can no longer switch facilitators, spread load across several, or self-facilitate.
- When state is unavoidable, prefer state held by the resource server (see `batch-settlement`). Facilitator-side state should be rebuildable from onchain data and bounded by an onchain fact rather than by `maxTimeoutSeconds`, which the server controls. Justify it in a dedicated section of the spec.
- Where the network offers no onchain record to rely on and facilitators must share a store, the spec must say so, as [`scheme_exact_lnbtc.md`](../../../../specs/schemes/exact/scheme_exact_lnbtc.md) does for its replay store.
- A mode in which the facilitator holds custody state (for example `extra.voucherManager: "facilitator"` in [`scheme_batch_settlement_evm.md`](../../../../specs/schemes/batch-settlement/scheme_batch_settlement_evm.md)) is opt-in, advertised on `/supported`, and never the default.

## Nonces

- Sequential nonces are strongly discouraged. They effectively lock the client account until the server route handler completes and the transaction settles, which may take several minutes (bounded only by `maxTimeoutSeconds`, on which the protocol enforces no upper limit). If the client submits another transaction from that account between verification and settlement, the nonce is consumed, settlement fails, and the work the server already performed is wasted.

## Verification and settlement

- Do not introduce new facilitator endpoints beyond `verify/`, `settle/`, and `supported/`. A scheme must express all facilitator interactions through these existing endpoints.
- Use transaction simulation, not only structural payload checks, to confirm the transaction would actually succeed onchain. If that is not possible, at least targeted checks of onchain state MUST be done (e.g. sufficient client token balance, nonce unconsumed).
- Verify should provide the strongest possible guarantee that settlement will succeed. If settle fails, the client does NOT get access to the resource; but if verify succeeded, the server did unnecessary work, wasting resources (compute). This is a server protection.
- The facilitator must confirm onchain that the expected transfer happened, not only that the transaction did not revert, before returning success to the server.
- The facilitator must protect its own funds and bound its fee exposure. Its signature must authorize only the network fee: the facilitator must not appear as the authority, source, or sender of any value-moving instruction (fee-payer isolation), so it cannot be induced to transfer its own funds. It must also cap the fees it pays against client-controlled parameters (e.g. explicit gas limits, compute-unit and priority-fee caps), so a client cannot inflate them.
- Evaluate fee caps with non-wrapping arithmetic (arbitrary precision, or at least 128-bit integers).
- If the facilitator would sign a transaction that calls code the client chose, reject anything that neither the spec enumerates nor the operator has allowlisted.
- When the payment itself is a transaction the client already broadcast, it is a client-submitted payment proof. Under `exact` it uses the `upfront` flow and needs both Request binding (so it cannot pay for another request) and Single-use claim (so it cannot be redeemed twice) from [`scheme_exact.md`](../../../../specs/schemes/exact/scheme_exact.md).

## Trust model

- The client must treat all server-provided fields as untrusted and must not rely on a server value for anything it can determine authoritatively itself. For example, if a scheme placed token `decimals` in `extra` and the client trusted it, a misconfigured or malicious server could report a wrong value, causing the client to compute too large an atomic `amount` and overpay; the client must instead read `decimals` (and similar token metadata) from onchain state.
- The server and facilitator must consider the client payload untrusted.
- The client should never interact with the facilitator directly, always via the server as proxy.
- Prefer designs where the facilitator holds only a key that pays network fees, not a role that can redirect, withhold, or refund value. Where a scheme gives it such a role (for example the `delegated` operator in `auth-capture`, or a facilitator-provided `receiverAuthorizer` in `batch-settlement`), the spec must say what the server gives up by trusting it.
- Having the facilitator fund accounts a counterparty can close and reclaim (for example token accounts) is a griefing risk. Allow it only as an explicit opt-in that the facilitator advertises on `/supported`.

## Account requirements

- Enumerate every account precondition that must hold before a payment can be verified and settled, naming the responsible role (client, server, or facilitator). Examples: a minimum native balance for rent or fees, an asset trustline or token association / opt-in, and account or associated-token-account creation.
