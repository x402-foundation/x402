"""Default ledger access for the XRPL mechanism.

JSON-RPC over HTTP rather than a WebSocket: the scheme's ledger reads are
independent request/response calls, and an HTTP client pools connections
instead of opening and tearing down a socket per call.

Every function here is replaceable through :class:`XrplFacilitatorOptions`, so a
deployment can supply its own transport, cache or node pool without the scheme
knowing.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import functools
import time
from collections.abc import Callable
from typing import Any, ParamSpec, TypeVar

from .constants import DEFAULT_RPC_URLS, MAX_ACCOUNT_TICKETS
from .types import XrplAccountAuthorization, XrplSettlementResult
from .utils import (
    ALLOWED_NON_SIGNING_FIELDS,
    decode_signed_transaction_blob,
    get_signed_transaction_hash,
)

try:
    from xrpl.clients import JsonRpcClient
    from xrpl.core import binarycodec
    from xrpl.models.requests import AccountInfo, AccountObjects, Ledger, Simulate, SubmitOnly, Tx
    from xrpl.models.requests.account_objects import AccountObjectType
    from xrpl.models.transactions import TicketCreate
    from xrpl.transaction import autofill_and_sign
except ModuleNotFoundError as e:  # pragma: no cover - exercised only without the extra
    if (e.name or "").split(".")[0] != "xrpl":
        raise
    raise ImportError(
        "XRPL mechanism requires xrpl-py. Install with: pip install x402[xrpl]"
    ) from e

# lsfDisableMaster: the account's master key pair has been disabled.
LSF_DISABLE_MASTER = 0x00100000

# Unlocked on purpose: the worst concurrent outcome is a duplicate client for
# one endpoint, which is harmless.
_CLIENTS: dict[str, JsonRpcClient] = {}

_P = ParamSpec("_P")
_T = TypeVar("_T")


def _loop_safe(func: Callable[_P, _T]) -> Callable[_P, _T]:
    """Make a sync ledger call safe to invoke on an event-loop thread.

    xrpl-py's sync client is an ``asyncio.run`` wrapper, so calling it on a
    thread that already runs an event loop (an async facilitator or client
    invoking this sync scheme inline) raises ``RuntimeError`` and every
    ledger read fails. The call is offloaded to its own thread in that case;
    it still blocks the caller, as any sync call invoked inline does.

    The executor is deliberately per-call, not shared: a module-level pool
    inherited across ``fork()`` holds dead worker threads and a stale idle
    count, so the first offloaded call in a pre-fork worker queues onto a
    pool that will never run it and hangs without an exception. Thread
    startup is microseconds against a ledger RPC.
    """

    @functools.wraps(func)
    def wrapper(*args: _P.args, **kwargs: _P.kwargs) -> _T:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return func(*args, **kwargs)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(func, *args, **kwargs).result()

    return wrapper


def resolve_rpc_url(network: str, rpc_url_by_network: dict[str, str] | None = None) -> str:
    """Resolve the JSON-RPC endpoint for a network.

    Args:
        network: CAIP-2 network identifier.
        rpc_url_by_network: Optional per-network endpoint overrides.

    Returns:
        The JSON-RPC URL to use.

    Raises:
        ValueError: If the network has no known endpoint.
    """
    if rpc_url_by_network and network in rpc_url_by_network:
        return rpc_url_by_network[network]
    url = DEFAULT_RPC_URLS.get(network)
    if url is None:
        raise ValueError(f"No JSON-RPC endpoint known for network: {network}")
    return url


def get_client(network: str, rpc_url_by_network: dict[str, str] | None = None) -> JsonRpcClient:
    """Return a client for a network, reusing one per endpoint.

    Args:
        network: CAIP-2 network identifier.
        rpc_url_by_network: Optional per-network endpoint overrides.

    Returns:
        A JSON-RPC client bound to the endpoint.
    """
    url = resolve_rpc_url(network, rpc_url_by_network)
    client = _CLIENTS.get(url)
    if client is None:
        client = JsonRpcClient(url)
        _CLIENTS[url] = client
    return client


def _result(client: JsonRpcClient, request: Any) -> dict[str, Any]:
    """Send a request and return its result payload.

    Args:
        client: JSON-RPC client.
        request: Request model.

    Returns:
        The result mapping.

    Raises:
        RuntimeError: If the node reports failure.
    """
    response = client.request(request)
    if not response.is_successful():
        raise RuntimeError(f"XRPL request failed: {response.result}")
    return response.result


@_loop_safe
def get_current_ledger_index(network: str, rpc_url_by_network: dict[str, str] | None = None) -> int:
    """Read the latest validated ledger index.

    Args:
        network: CAIP-2 network identifier.
        rpc_url_by_network: Optional endpoint overrides.

    Returns:
        The validated ledger index.
    """
    result = _result(get_client(network, rpc_url_by_network), Ledger(ledger_index="validated"))
    index = result.get("ledger_index")
    if index is None:
        index = result.get("ledger", {}).get("ledger_index")
    return int(index)


@_loop_safe
def get_account_sequence(
    account: str, network: str, rpc_url_by_network: dict[str, str] | None = None
) -> int:
    """Read an account's current sequence number.

    Args:
        account: Classic address.
        network: CAIP-2 network identifier.
        rpc_url_by_network: Optional endpoint overrides.

    Returns:
        The account's sequence.
    """
    result = _result(
        get_client(network, rpc_url_by_network),
        AccountInfo(account=account, ledger_index="validated"),
    )
    return int(result["account_data"]["Sequence"])


@_loop_safe
def get_account_authorization(
    account: str, network: str, rpc_url_by_network: dict[str, str] | None = None
) -> XrplAccountAuthorization:
    """Read an account's configured signing authority.

    Args:
        account: Classic address.
        network: CAIP-2 network identifier.
        rpc_url_by_network: Optional endpoint overrides.

    Returns:
        The account's regular key and master-key state.
    """
    result = _result(
        get_client(network, rpc_url_by_network),
        AccountInfo(account=account, ledger_index="validated"),
    )
    data = result["account_data"]
    return XrplAccountAuthorization(
        regular_key=data.get("RegularKey"),
        is_master_key_disabled=bool(int(data.get("Flags", 0)) & LSF_DISABLE_MASTER),
    )


def _account_ticket_sequences(
    account: str, network: str, rpc_url_by_network: dict[str, str] | None
) -> list[int]:
    """Read every unspent ticket sequence an account holds.

    Args:
        account: Classic address.
        network: CAIP-2 network identifier.
        rpc_url_by_network: Optional endpoint overrides.

    Returns:
        The account's ticket sequences.
    """
    client = get_client(network, rpc_url_by_network)
    marker: Any = None
    sequences: list[int] = []
    # Every honest answer fits in 250 pages (the ledger's own ticket limit);
    # a node that repeats a marker must not be able to hang the walk.
    for _ in range(MAX_ACCOUNT_TICKETS):
        request = AccountObjects(
            account=account,
            type=AccountObjectType.TICKET,
            ledger_index="validated",
            marker=marker,
        )
        result = _result(client, request)
        for obj in result.get("account_objects", []):
            if obj.get("LedgerEntryType") == "Ticket" and isinstance(
                obj.get("TicketSequence"), int
            ):
                sequences.append(obj["TicketSequence"])
        marker = result.get("marker")
        if marker is None:
            break
    return sequences


@_loop_safe
def is_ticket_available(
    account: str,
    ticket_sequence: int,
    network: str,
    rpc_url_by_network: dict[str, str] | None = None,
) -> bool:
    """Report whether a ticket is still unspent on the ledger.

    Args:
        account: Classic address.
        ticket_sequence: Ticket sequence to look for.
        network: CAIP-2 network identifier.
        rpc_url_by_network: Optional endpoint overrides.

    Returns:
        Whether the ticket exists.
    """
    return ticket_sequence in _account_ticket_sequences(account, network, rpc_url_by_network)


@_loop_safe
def submit_signed_transaction(
    signed_tx_blob: str,
    network: str,
    rpc_url_by_network: dict[str, str] | None = None,
    timeout_seconds: float = 30.0,
    poll_interval_seconds: float = 1.0,
) -> XrplSettlementResult:
    """Submit a signed transaction and wait for a validated result.

    Submission returns a *provisional* engine result, and the transaction can
    still fail to validate, so the scheme polls ``tx`` until the ledger says
    it did, rather than releasing a paid resource for a payment that may never
    land.

    Args:
        signed_tx_blob: Hex-encoded signed transaction.
        network: CAIP-2 network identifier.
        rpc_url_by_network: Optional endpoint overrides.
        timeout_seconds: How long to wait for validation.
        poll_interval_seconds: Delay between polls.

    Returns:
        The settlement outcome. ``validated`` is False if the wait timed out.
    """
    client = get_client(network, rpc_url_by_network)
    # fail_hard stops rippled retrying a transaction this call reports as
    # unvalidated, which could otherwise land later, charging the payer for
    # a resource the server already refused to release.
    submission = _result(client, SubmitOnly(tx_blob=signed_tx_blob, fail_hard=True))
    engine_result = submission.get("engine_result", "")
    # The hash is a function of the blob, so it is computed rather than read
    # back from the node.
    tx_hash = get_signed_transaction_hash(signed_tx_blob)

    # A transaction the network refused outright will never validate.
    if not engine_result.startswith(("tes", "ter", "tec")):
        return XrplSettlementResult(hash=tx_hash, validated=False, result_code=engine_result)

    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            found = _result(client, Tx(transaction=tx_hash))
        except RuntimeError:
            # Not yet visible to this node.
            time.sleep(poll_interval_seconds)
            continue
        if found.get("validated"):
            meta = found.get("meta") or found.get("metaData") or {}
            code = meta.get("TransactionResult", "") if isinstance(meta, dict) else ""
            return XrplSettlementResult(hash=tx_hash, validated=True, result_code=code)
        time.sleep(poll_interval_seconds)

    return XrplSettlementResult(hash=tx_hash, validated=False, result_code=engine_result)


@_loop_safe
def get_available_ticket_sequence(
    account: str, network: str, rpc_url_by_network: dict[str, str] | None = None
) -> int | None:
    """Return the lowest unspent ticket sequence for an account.

    Args:
        account: Classic address.
        network: CAIP-2 network identifier.
        rpc_url_by_network: Optional endpoint overrides.

    Returns:
        The lowest available ticket sequence, or None when the account holds none.
    """
    tickets = _account_ticket_sequences(account, network, rpc_url_by_network)
    return min(tickets) if tickets else None


@_loop_safe
def simulate_signed_transaction(
    signed_tx_blob: str, network: str, rpc_url_by_network: dict[str, str] | None = None
) -> str:
    """Dry-run a signed transaction and return its engine result.

    Simulation catches conditions no static check can see: an unfunded
    payer, a missing trust line, a frozen balance. It cannot catch
    authorisation problems, because signature fields are stripped before
    simulating; that is what the signing-authority check is for.

    Args:
        signed_tx_blob: Hex-encoded signed transaction.
        network: CAIP-2 network identifier.
        rpc_url_by_network: Optional endpoint overrides.

    Returns:
        The engine result code, for example ``tesSUCCESS``.

    Raises:
        ValueError: If the blob cannot be decoded.
    """
    # The simulate command rejects a signed transaction outright
    # (`transactionSigned`). Every field that decides the outcome survives the
    # strip, and the signature is verified separately.
    unsigned = decode_signed_transaction_blob(signed_tx_blob)
    for field in ALLOWED_NON_SIGNING_FIELDS:
        unsigned.pop(field, None)
    unsigned["SigningPubKey"] = ""

    result = _result(
        get_client(network, rpc_url_by_network),
        Simulate(tx_blob=binarycodec.encode(unsigned)),
    )
    return str(result.get("engine_result", ""))


@_loop_safe
def create_tickets(
    wallet: Any,
    network: str,
    ticket_count: int = 1,
    rpc_url_by_network: dict[str, str] | None = None,
    timeout_seconds: float = 30.0,
) -> list[int]:
    """Create tickets and return the sequences the ledger assigned.

    The scheme requires a client using ``ticketSequence`` to hold a ticket
    before signing. Each outstanding ticket locks owner reserve until it is
    spent, and an account may hold at most 250.

    Args:
        wallet: Signing wallet for the ticket owner.
        network: CAIP-2 network identifier.
        ticket_count: How many tickets to create.
        rpc_url_by_network: Optional endpoint overrides.
        timeout_seconds: How long to wait for validation.

    Returns:
        Created ticket sequences, ascending.

    Raises:
        ValueError: If ``ticket_count`` is outside 1..250.
        RuntimeError: If the TicketCreate does not validate successfully.
    """
    if not 1 <= ticket_count <= MAX_ACCOUNT_TICKETS:
        raise ValueError(f"ticket_count must be between 1 and {MAX_ACCOUNT_TICKETS}")

    # Submission cannot be faked usefully (a stub node would only confirm
    # what it was told to say), so this path is covered by the live testnet
    # suite, and the metadata parsing is a separate function with unit tests.
    client = get_client(network, rpc_url_by_network)  # pragma: no cover - live suite
    signed = autofill_and_sign(  # pragma: no cover - live suite
        TicketCreate(account=wallet.address, ticket_count=ticket_count), client, wallet
    )
    result = submit_signed_transaction(  # pragma: no cover - live suite
        binarycodec.encode(signed.to_xrpl()),
        network,
        rpc_url_by_network,
        timeout_seconds=timeout_seconds,
    )
    if not result.validated or result.result_code != "tesSUCCESS":  # pragma: no cover - live suite
        raise RuntimeError(f"TicketCreate did not settle: {result.result_code}")

    found = _result(client, Tx(transaction=result.hash))  # pragma: no cover - live suite
    return created_ticket_sequences(  # pragma: no cover - live suite
        found.get("meta") or found.get("metaData") or {}
    )


def created_ticket_sequences(meta: Any) -> list[int]:
    """Extract the ticket sequences a validated TicketCreate produced.

    The ledger assigns the sequences, so they are read from the transaction's
    metadata rather than predicted from the account's state.

    Args:
        meta: Validated transaction metadata.

    Returns:
        Created ticket sequences, ascending.
    """
    if not isinstance(meta, dict):
        return []
    created = []
    for node in meta.get("AffectedNodes", []):
        if not isinstance(node, dict):
            continue
        entry = node.get("CreatedNode") or {}
        if entry.get("LedgerEntryType") != "Ticket":
            continue
        sequence = (entry.get("NewFields") or {}).get("TicketSequence")
        if isinstance(sequence, int):
            created.append(sequence)
    return sorted(created)
