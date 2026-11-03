# Facilitator-managed EVM batch settlement

Python buyers and HTTP resource servers can use the existing Go facilitator's
managed voucher store. The Python facilitator does not implement this mode.
Self-managed server custody remains the default.

Configure the resource server with the facilitator's URL and managed custody:

```python
from x402 import x402ResourceServerSync
from x402.http import FacilitatorConfig, HTTPFacilitatorClientSync
from x402.mechanisms.evm.batch_settlement.server import (
    BatchSettlementEvmScheme,
    BatchSettlementEvmSchemeServerConfig,
)

facilitator = HTTPFacilitatorClientSync(FacilitatorConfig(url=facilitator_url))
server = x402ResourceServerSync(facilitator)
server.register(
    "eip155:*",
    BatchSettlementEvmScheme(
        receiver_address,
        BatchSettlementEvmSchemeServerConfig(voucher_store_mode="facilitator"),
    ),
)
server.initialize()
```

Use `x402ResourceServer` and `HTTPFacilitatorClient` for async HTTP middleware.
Configure Flask or FastAPI routes as in the existing batch-settlement server
example. The existing Python batch-settlement buyer also works with managed
requirements; it automatically binds an advertised refund authorizer into the
channel salt. Decimal channel indexes up to `2**53 - 1` and uint256 `0x` hex
salts are supported, matching the Go buyer.

Register that buyer with the existing HTTP client wrapper:

```python
from x402 import x402ClientSync
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementEvmScheme as BatchSettlementBuyer,
    BatchSettlementEvmSchemeOptions,
)

buyer = x402ClientSync().register(
    "eip155:*",
    BatchSettlementBuyer(wallet_signer, BatchSettlementEvmSchemeOptions(salt="1")),
)
```

The facilitator must advertise `voucherManager: ["facilitator"]` (possibly
alongside `"server"`), a nonzero `receiverAuthorizer`, and a valid `withdrawDelay`.
The server copies these terms; its local `withdraw_delay` does not override
the facilitator's value.

Choose one refund-consent path:

- With delegated consent, the facilitator must advertise `delegatedRefund: true`.
  Configure its authenticated caller identity using the existing facilitator
  client's authentication options.
- With server-owned consent, pass an `AuthorizerSigner` as
  `refund_authorizer_signer` in the scheme config. This is a distinct role from
  `receiver_authorizer_signer`. The buyer binds that address into channel identity,
  and the server signs refunds while the facilitator authorizes claims.

Every managed voucher verifies and settles remotely. The server echoes the
facilitator's reservation ID, cancels failed handlers with a zero-amount settle,
and skips the business handler for refunds. Optional server storage is an
observational replica; it cannot authorize payments or supply corrective proofs.
A replica write failure is logged and preserves the facilitator's known receipt.
Incomplete authoritative snapshots fail closed; known admission is released when
verification aborts. Explicit settlement-hook aborts and unrecovered local
settlement-enrichment failures release admission before dispatch. Pending or
uncertain facilitator calls retain request context for reconciliation.
Run the voucher store and settlement worker at the Go facilitator. Server-initiated
cooperative refunds are unavailable in this mode; buyers initiate refunds.

Structured non-200 HTTP failures depend on the shared Python facilitator HTTP
adapter and the Go service's error responses. A facilitator that discards
`channelState` or signed `voucherState` prevents corrective recovery. Do not
retry ambiguous off-chain settlement failures as new charges. The existing
single `settlement_pending` retry with a transaction hash reconciles onchain
settlement only. See the repository's batch-settlement specification for the
wire contract.
