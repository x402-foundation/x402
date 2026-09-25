# Bitcoin Lightning (`lnbtc`)

The `exact` mechanism implements the accepted [BOLT11 upfront scheme](../../../../specs/schemes/exact/scheme_exact_lnbtc.md) for Bitcoin mainnet and testnet. Install its optional dependencies with `pip install 'x402[lightning]'`.

Use Python 3.10–3.13 for the Lightning extra. Its BOLT11 dependency uses `coincurve`, whose current release cannot build on Python 3.14 ([upstream issue](https://github.com/ofek/coincurve/issues/219)). The all-extras CI job uses Python 3.13 so it exercises Lightning as well as the other mechanisms.

A receiver issues a fresh invoice bound to the requested operation. A payer adapter pays it and returns the preimage. The facilitator validates that proof locally, then atomically records its payment hash before the protected handler runs. Settlement does not move funds: the Lightning payment has already completed. The `upfront` flow does not call `/verify` and does not promise a refund if the handler fails.

## Adapters and registration

Implement `LightningReceiver.create_invoice` and `LightningPayer.pay_invoice` using your Lightning node or wallet. The receiver must support a BOLT11 description hash and fresh payment hash on every call. The payer must report the exact invoice, payment hash, invoice amount in millisatoshis, status and preimage. Wallets that cannot return the preimage are unsupported. No particular node or hosted provider is included.

```python
from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync
from x402.mechanisms.lnbtc import MAINNET, SQLiteReplayStore
from x402.mechanisms.lnbtc.exact.client import ExactLnbtcScheme as LightningClient
from x402.mechanisms.lnbtc.exact.facilitator import ExactLnbtcScheme as LightningFacilitator
from x402.mechanisms.lnbtc.exact.server import ExactLnbtcScheme as LightningServer

# payer and receiver implement the adapter protocols. Each binding callback
# independently captures the current actual request; see the rules below.
client = x402ClientSync().register(MAINNET, LightningClient(payer, client_binding))
client.set_spend_controls(
    {
        "allowed_assets": [
            {
                "network": MAINNET,
                "asset": "BTC",
                "max_amount_per_payment": "25000",  # 25 sats, in millisatoshis
            }
        ],
    }
)
facilitator = x402FacilitatorSync().register(
    [MAINNET],
    LightningFacilitator(SQLiteReplayStore("lightning-replay.sqlite3")),
)
server = x402ResourceServerSync(facilitator).register(
    MAINNET,
    LightningServer(receiver, server_binding, allow_invoice=issuance_allowed),
)
server.initialize()
```

Use a compressed lowercase node public key as `payTo`. Prices can be explicit `AssetAmount(asset="BTC", amount="25000")` or qualified strings such as `"25 sats"`. Bare numbers and fiat strings require a registered conversion parser. Do not disable spend controls merely to permit BTC; configure an atomic BTC cap as above. A payer adapter should also enforce routing-fee limits.

The same synchronous mechanism adapters can be registered with the asynchronous SDK. Blocking node adapters should have their own bounded timeouts; do not perform unbounded network work on an event loop.

## Binding the actual request

Supply a callback returning a `RequestBinding` to both the client and resource-server mechanisms. These callbacks must independently read the outgoing request or current incoming request. Never derive the binding from the payment challenge, echoed payload, cached requirements, or a shared mutable last-request variable. Use framework request locals or a request-scoped `ContextVar` when an SDK instance handles concurrent requests.

For HTTP, call `http_request_binding(method, url, public_origin=..., body=raw_bytes, headers=..., bound_headers=...)`:

- Preserve method case, percent escapes, query order and raw content bytes after transfer decoding but before decompression or JSON parsing. A retry must preserve those bytes.
- Validate the public origin against trusted configuration. Trust forwarding headers only from configured proxies. Framework URL reconstruction must preserve the exact public target URI; otherwise reject the operation.
- Configure a sorted, lowercase list of **every** header affecting operation, content interpretation or account selection, even when absent. This often includes `authorization`, `content-type`, `cookie` and `range`. Exclude `payment-signature`. Supply repeated fields in received order. Empty and absent values differ.
- Emit `PaymentRequired.resource.url` equal to the bound URL. The registered client hook checks that envelope before paying, and the server hook checks the actual request and payload URL before settlement.

For MCP, call `mcp_request_binding(configured_server_uri, actual_tools_call_params, resource_url=configured_tool_resource, bound_metadata=...)`:

- Bind the intended server URI, actual tool name, original arguments and every metadata value affecting the operation or account. Configure the server independently of the challenge. Associate the resource URL with the actual tool in server configuration.
- Pass the actual parsed `tools/call` parameters before defaults or transformations. The transport must reject duplicate JSON member names before creating a dictionary; that information is lost after normal parsing. JCS rejects non-finite numbers, unsafe integers and invalid Unicode.
- Omitted arguments and `{}` must mean the same operation. `null` is invalid for arguments or `_meta`. Exclude `progressToken` and `x402/payment`; neither may change the purchased operation. Bound metadata distinguishes absent and `null`.

Reject operations whose authorization or behavior depends on context outside the binding, such as an account chosen only by TLS credentials or MCP session state. Binding an account identifier does not authorize the caller to use that account. Apply the application's normal permission checks.

The SDK core does not expose raw request bytes to a scheme. These callbacks are mandatory integration points, not automatic transport capture. The tests demonstrate the core HTTP and MCP bindings and a Flask middleware roundtrip; they do not certify every framework's URL or body reconstruction.

## Replay storage and operations

`SQLiteReplayStore` requires a persistent file and keeps consumed keys indefinitely. All facilitator instances accepting a receiver's invoices must share one atomic, restart-durable store. Use a `ReplayStore` implementation backed by a shared transactional database for multiple hosts; separate SQLite files do not protect against cross-instance replay. Preserve the store across deploys and restores. If pruning entries, retain them until at least invoice creation + expiry + clock skew + one hour.

Store failures return `settlement_failed`; duplicate consumption returns `duplicate_settlement`. Both deny access. The facilitator verifies the preimage without contacting a receiver and omits payer identity. Do not log preimages or payment-signature headers.

Restrict invoice creation to trusted resource-server code and protect the receiver signing key. Use `allow_invoice` to rate-limit or authorize issuance before node access. Never solve issuance load by reusing an invoice. Client and facilitator clocks default to a 60-second skew allowance; settlement accepts the boundary at invoice expiry plus skew, while a client will not start paying an expired invoice.

## Validation

From `python/x402`, run `uv run pytest tests/unit/mechanisms/lnbtc`. Tests use local signed invoices and the specification's published proof, with no node connection or real payment. They cover request mutations, payer failures, fresh concurrent challenges, durable replay rejection, and settlement before an HTTP handler. Real node interoperability remains an integration responsibility.
