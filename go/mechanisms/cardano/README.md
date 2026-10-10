# Cardano Mechanisms

Go implementation of the [`exact` scheme on Cardano](../../../specs/schemes/exact/scheme_exact_cardano.md), wire-compatible with the TypeScript (`@x402/cardano`) SDK.

The client builds and signs the complete transaction but never broadcasts it; the facilitator verifies it, submits the client's exact bytes and observes confirmation. The facilitator holds no funds and signs nothing.

## Export Paths

| Role | Import path | Constructor |
|------|-------------|-------------|
| Client | `github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/client` | `NewExactCardanoScheme(signer)` |
| Server | `github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/server` | `NewExactCardanoScheme(config...)` |
| Facilitator | `github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/facilitator` | `NewExactCardanoScheme(signer, config...)` |
| Signers | `github.com/x402-foundation/x402/go/v2/signers/cardano` | `NewClientSigner`, `NewFacilitatorSigner`, `NewMasumiSellerSigner`, `NewBlockfrost` |

The client and Masumi seller signers derive CIP-1852 keys from a BIP-39 mnemonic; the facilitator signer holds no key and only advertises configured addresses. All read the chain through Blockfrost. A client paying concurrently from one wallet should set `ClientSignerConfig.ReserveInputs`, so payments never spend the same UTxO; reserved inputs are held until the payment's TTL. Any chain access can be plugged in by implementing `cardano.ClientCardanoSigner` / `cardano.FacilitatorCardanoSigner`; the facilitator uses the optional `TransactionEvidenceReader`, `ProtocolParametersReader`, `TransactionEvaluator`, `Phase1Validator`, `SubmissionRejectionClassifier` and `SubmissionNotSentClassifier` interfaces when present.

## Supported Networks

`cardano:mainnet`, `cardano:preprod`, `cardano:preview` (CIP-34 aliases are accepted on input). USDM is the default asset for money prices on mainnet and preprod; lovelace and any native token can be priced with an explicit `AssetAmount`.

## Asset Transfer Methods

| Method | Description |
|--------|-------------|
| `default` | Address-to-address payment. |
| `script` | Payment to a script address derived from `extra.script` + `parameters` (or `extra.scriptHash`), with an optional inline `extra.datum`. Go core decodes `extra` into a map, so named (non-integer) parameter keys must be listed alphabetically to match TypeScript, which applies them in insertion order; otherwise the address check refuses the payment. |
| `masumi` | Locks the payment into the Masumi `vested_pay` escrow under seller-signed terms. |

### Masumi routes

Masumi quotes are issued per request and bound to the first transaction that pays them. Go core matches paid retries against the payment options it builds per request, so Masumi routes are built with helpers on a server scheme configured with a seller:

- HTTP: `scheme.MasumiPaymentOption(cardanoserver.MasumiRoute{...})` returns an `x402http.PaymentOption`.
- MCP: `scheme.WrapMasumiTool(resourceServer, cardanoserver.MasumiToolConfig{...}, handler)` wraps a tool handler.

A plain payment option declaring `assetTransferMethod: "masumi"` is rejected at request time.

Go core does not pass the resource to client schemes. To pay a quote from a registered agent (`agentIdentifier`), attach it with `cardanoclient.WithResource(ctx, paymentRequired.Resource)` and configure `MasumiClientConfig.ValidateRegistryClaim`.

By default a quote commits to the resource, the HTTP method and URL (path and query), or the MCP tool arguments; a paid retry resumes its quote only for the same request. Go core exposes neither HTTP bodies nor reliable body presence, so the default only quotes GET and HEAD requests; other methods, and GET handlers that read a body, must set `MasumiIssuerConfig.Commitment`. The in-memory quote store never evicts a quote that can still be paid or settled; when full it refuses new quotes.

## Confirmations and Settlement

`extra.confirmationPolicy.l1Confirmations` selects the evidence required before `success: true` (default `1`; `0` for block inclusion; `-1` for mempool when the facilitator sets `AcceptMempool`). A settle call waits up to `ConfirmationTimeout` (75s) and otherwise returns `settlement_pending` with the transaction id; the resource server's retry resumes observation without rebroadcasting.

`cardano.SettlementStore` guards against broadcasting a transaction twice and binds Masumi quotes to one transaction; `masumi.TermsStorage` keeps issued quotes on the server. The in-memory defaults suit single-instance deployments; multi-instance deployments need shared, atomically updating stores. A settlement record is kept until its transaction's TTL plus `SettlementRetentionGrace` and until any Masumi terms it binds expire; a full store refuses new claims rather than forget one.

A submit error that proves nothing was sent (connection refused, Blockfrost rate limit or full mempool) releases the claim so a retry submits again; ambiguous errors keep it and return `settlement_pending`, so the retry reconciles the same transaction. A rejected transaction that later appears on chain is reconciled from evidence. A facilitator without a `TransactionEvidenceReader` cannot prove a submitted transaction did not land, so a resumed settlement stays pending rather than reporting it expired. A claim whose outcome was never recorded (crash, failed store update) blocks retries only for its lease (`DefaultSettlementClaimLease`), after which a retry reconciles it from chain evidence without rebroadcasting. Such a claim is only observed, so a transaction its owner never got to submit cannot be broadcast later; the buyer pays again once it expires. Outcomes are recorded even when the settle request is cancelled.

## Related Documentation

- [Mechanisms Overview](../README.md)
- [Cardano exact spec](../../../specs/schemes/exact/scheme_exact_cardano.md)
