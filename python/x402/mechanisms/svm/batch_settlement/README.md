# SVM batch settlement

SVM `batch-settlement` deposits SPL tokens into an escrow channel once, then
uses signed cumulative vouchers for paid requests. A resource server retains
accepted vouchers and redeems them through a facilitator outside the request path.
This implements the [SVM scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_svm.md).

```sh
pip install 'x402[svm,requests,httpx]'
```

## Client

```python
import os

from x402 import x402ClientSync
from x402.http.clients import x402_requests
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.batch_settlement import (
    BatchSvmClientConfig,
    register_batch_svm_client,
)

client = x402ClientSync().set_spend_controls({"max_amount_per_payment": "$0.10"})
register_batch_svm_client(
    client,
    KeypairSigner.from_base58(os.environ["SVM_PRIVATE_KEY"]),
    config=BatchSvmClientConfig(rpc_url=os.environ["SVM_RPC_URL"]),
)
with x402_requests(client) as session:
    for _ in range(3):
        response = session.get(os.environ["RESOURCE_URL"])
        response.raise_for_status()
        print(response.text)
```

The first request carries a partially signed `open` transaction. Later requests
carry vouchers, or a `top_up` transaction when more escrow is needed. The
facilitator pays SOL fees and rent. The payer needs the token balance; the payer,
receiver, and program treasury token accounts must already be usable.

The registration helper installs the scheme's payment-selection policy. When
registering manually, also call `client.register_policy(scheme.payment_policy)`.
The same scheme works with `x402Client` and the existing async HTTP transport;
its RPC/signing methods follow the SDK's synchronous SVM mechanism interface.
Those calls can block the event loop, and one scheme serializes channel state
changes under a lock. Applications needing concurrent RPC work should run the
synchronous client in worker threads; this scheme does not provide async RPC.

### Operator-signed metering

An operator-signed channel lets the server sign vouchers for actual usage after
a request. The operator can claim **the entire channel deposit**. Trust must be
granted out of band; a `402` cannot grant it. For a known operator:

```python
from x402.mechanisms.svm.batch_settlement import BatchServerSignedChannelsPolicy

config = BatchSvmClientConfig(
    server_signed_channels_policy=BatchServerSignedChannelsPolicy(
        allowed_operators=[os.environ["TRUSTED_OPERATOR"]],
        max_deposit="$1",
    ),
)
```

Each request uses an expiring, payer-signed proof bound to its channel, operator,
request ID, and price ceiling. Responses contain the operator's signed cumulative
receipt. Untrusted operator accepts fall back to a client-signed alternative when
one is offered. Custom tokens use `ServerSignedChannelsAsset` entries with atomic
`max_deposit` limits.

### Recovery and refunds

`BatchSvmClientConfig.channel_storage` accepts a `BatchClientChannelStorage`
adapter. Persist the whole record atomically, including unresolved payments.
The default is process-local memory. Keep one client per wallet/channel store;
sharing storage among independent client processes requires external serialization.

A missing response or `settlement_pending` retains the exact pending payment;
it does not create a second charge. A consumed server-mode request ID is not an
HTTP response-replay mechanism: recover the authoritative response through your
application (for example, the payment-identifier extension), then pass it to
`client.handle_payment_response`. Until reconciled, that channel stays pending.
Discovery can reconstruct channel escrow
from the chain, but cannot reconstruct an unclaimed offchain voucher. Corrective
402 responses require a valid signed voucher or a fresh onchain read before the
client changes its cumulative balance.
Invalid successful offchain receipts restore the last confirmed allocation.
Invalid funding receipts remain pending because confirming escrow alone cannot
prove whether the accompanying request was charged.

Keep the scheme instance to refund a channel:

```python
from x402.mechanisms.svm.batch_settlement import BatchSvmClientScheme

scheme = BatchSvmClientScheme(signer, config)
client.register("solana:*", scheme).register_policy(scheme.payment_policy)
# After paid requests, using the same scheme:
result = scheme.refund(resource_url)
```

Refunds close the whole channel. If the receiver binding is unavailable, the
client can submit a payer-signed `request_close`, then wait for the advertised
grace period. `create_refund_payload(requirements, with_transaction=True)` is
available for custom transports. Automatic HTTP refunds use `httpx`.
For remote facilitators, allow time for on-chain confirmation with a plain fetch:

```python
import httpx

result = scheme.refund(
    resource_url,
    fetch=lambda url, headers: httpx.get(url, headers=headers, timeout=30.0),
)
```

A timeout leaves the transaction outcome unknown; check the channel on-chain
before retrying.

## Resource server

```python
from x402 import x402ResourceServerSync
from x402.mechanisms.svm.batch_settlement import BatchSvmServerScheme, BatchSvmServerConfig

scheme = BatchSvmServerScheme(
    BatchSvmServerConfig(
        receiver_authorizer=receiver_signer,
        # operator=operator_signer,  # Enables metered server-signed routes.
        store=channel_store,
        operation_store=operation_store,
    )
)
server = x402ResourceServerSync(facilitator_client).register("solana:*", scheme)
server.initialize()
```

Use `scheme="batch-settlement"` in route requirements. Verification reserves
capacity before the handler; settlement commits the charge afterward. A metered
route supplies its actual amount to settlement, bounded by the verified ceiling.
A route can pin `extra.voucherSigner="client"` even when an operator is configured.
Without a local receiver signer, startup requires the facilitator to advertise a
receiver authorizer for authenticated delegated closes.
Set `extra.minDeposit` as a string: `"5000000"` means atomic token units, while
`"$5"` means five dollars of the default asset. Numeric values are rejected.

`ChannelStore.update` must be an atomic read-modify-write across workers.
`BatchOperationStore` must retain consumed request IDs even after cancellation.
The memory implementations are single-process references. Production stores must
retain accepted vouchers, charges, reservations, and replay state across restarts.
If bookkeeping fails after an onchain settlement succeeds, the server logs the
transaction and blocks further charges on that channel. Deposit and close
reservations remain exclusive across their deadline until explicitly resolved.
Reconcile the durable accounting state before restarting; restarting alone does
not recover an unrecorded charge. Missing optional close snapshots stop new
payments while the channel manager reconciles the final watermark.

Server crash recovery is application-managed. Keep the original payment,
requirements, and settlement outcome in a durable request log. Reconcile escrow
with the merchant's accepted voucher ledger, then use `ChannelStore.update` to
restore the accounting state and remove only resolved reservations; retain
consumed request IDs in `BatchOperationStore`. Restart affected server instances
after that repair to clear their local failure guards. A reservation deadline
alone does not prove that a transaction failed. There is no automatic server
reservation recovery worker in this implementation.

Redeem regularly using the enhanced requirements for those channels:

```python
manager = scheme.create_channel_manager(facilitator_client, enhanced_requirements)
manager.start(interval_seconds=30)
# On shutdown:
manager.stop(flush=True)
```

Alternatively call `manager.redeem()` from a worker. It claims up to four channels
per batch, distributes earned funds, and reconciles confirmed payout watermarks.
It seals closing channels with their latest accepted voucher during the grace
period. Use a synchronous facilitator client for this worker.
Create one manager for each distinct set of channel requirements, including a
separate manager for client-signed and server-signed routes. They may share a
store: each manager filters channels by network, asset, receiver, fee payer,
receiver authorizer, token program, and voucher signer/operator.

## Facilitator

```python
from x402.mechanisms.svm.batch_settlement import (
    BatchFacilitatorKeypairSigner,
    BatchSvmFacilitatorConfig,
    BatchSvmFacilitatorScheme,
    BatchSvmRentCleanupManager,
)

scheme = BatchSvmFacilitatorScheme(
    BatchFacilitatorKeypairSigner(fee_payer_keypair, rpc_url=rpc_url),
    BatchSvmFacilitatorConfig(
        channel_storage=channel_storage,
        pending_settlement_store=pending_store,
    ),
)
facilitator.register([network], scheme)
cleanup = BatchSvmRentCleanupManager(scheme, network)
cleanup.discover()  # At startup and periodically.
cleanup.cleanup()  # Run periodically; bounded work per pass.
```

The facilitator validates complete client transactions before co-signing and
simulates setup plus close/distribution readiness. It persists signed bytes and
channel reservations before broadcast. Unknown outcomes remain pending until
confirmed or proven expired; retries reconcile the recorded transaction.

Custom signers must implement
`get_account_info_with_context(address, network, *, min_context_slot=None)`,
returning `{"context_slot": slot, "account": account_or_none}` and honoring
`min_context_slot`, including for absent accounts. Construction rejects signers
without this method; the bundled signer already implements it. Missing or stale
context after confirmation keeps the outcome pending until a fresh read arrives.

Configure an explicit binding store or history reader. `MemoryPaymentChannelStorage`
and `MemoryBatchPendingSettlementStore` are suitable for development; replace
them with durable, atomic adapters for production. History lookup must be explicitly
configured and retain each channel's open transaction. Delegated closes additionally
require `BatchDelegatedReceiverAuth.resolve_caller_identity`; caller identity is
never inferred from unauthenticated payment fields.

Idle closes are disabled by default. Setting `max_idle_secs` advertises that
window and allows cleanup at the current onchain watermark after it expires.
Unclaimed vouchers are forfeited at close, so servers must redeem well before
both the idle window and forced-close deadline. Discovery starts a fresh idle
clock. Missing recipient metadata is reported instead of guessing a destination;
already-distributed channels can still have their rent reclaimed.

`on_distribution_confirmed`, when configured, must be idempotent by transaction
signature: durable outcome storage may fail after the callback has run.
