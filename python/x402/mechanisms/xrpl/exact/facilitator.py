"""XRPL facilitator for the exact payment scheme."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from ....schemas import (
    Network,
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    VerifyResponse,
)
from .. import ledger
from ..constants import (
    ASSET_XRP,
    ERR_AMOUNT_MISMATCH,
    ERR_AMOUNT_XRP,
    ERR_ASSET_MISMATCH,
    ERR_ASSET_TRANSFER_METHOD,
    ERR_DELEGATE_NOT_ALLOWED,
    ERR_DELIVERMIN_NOT_ALLOWED,
    ERR_DESTINATION_MISMATCH,
    ERR_DESTINATION_TAG_MALFORMED,
    ERR_DESTINATION_TAG_MISMATCH,
    ERR_DUPLICATE_SETTLEMENT,
    ERR_EXPIRED,
    ERR_FEE_MISSING,
    ERR_FEE_TOO_HIGH,
    ERR_FEES_SPONSORED_UNSUPPORTED,
    ERR_INVALID_NETWORK,
    ERR_INVOICE_ID_MISMATCH,
    ERR_INVOICE_MISMATCH,
    ERR_INVOICE_MISSING,
    ERR_IOU_AMOUNT,
    ERR_IOU_CURRENCY_MISMATCH,
    ERR_IOU_ISSUER_MISMATCH,
    ERR_IOU_ISSUER_MISSING,
    ERR_IOU_VALUE_MISMATCH,
    ERR_LAST_LEDGER_SEQUENCE_MISSING,
    ERR_LAST_LEDGER_SEQUENCE_TOO_LARGE,
    ERR_MASTER_KEY_DISABLED,
    ERR_MAX_TIMEOUT_INVALID,
    ERR_MAX_TIMEOUT_MISMATCH,
    ERR_MAX_TIMEOUT_TOO_LARGE,
    ERR_MEMOS_NOT_ALLOWED,
    ERR_MULTISIG_NOT_SUPPORTED,
    ERR_NETWORK_ID_FOR_STANDARD_NETWORK,
    ERR_NETWORK_ID_MISMATCH,
    ERR_NETWORK_MISMATCH,
    ERR_PARTIAL_PAYMENT_NOT_ALLOWED,
    ERR_PATHS_NOT_ALLOWED,
    ERR_PAY_TO_MISMATCH,
    ERR_PAYLOAD,
    ERR_PAYLOAD_AMOUNT_MISMATCH,
    ERR_PAYLOAD_BLOB,
    ERR_PAYLOAD_DESTINATION_TAG_MISMATCH,
    ERR_PAYLOAD_IOU_ISSUER_MISMATCH,
    ERR_SENDMAX_IOU_MISMATCH,
    ERR_SENDMAX_NOT_ALLOWED,
    ERR_SENDMAX_REQUIRED,
    ERR_SENDMAX_TOO_LOW,
    ERR_SEQUENCE_MISSING,
    ERR_SEQUENCE_MUST_BE_ZERO,
    ERR_SEQUENCE_NOT_CURRENT,
    ERR_SIGNATURE,
    ERR_SIGNER_NOT_AUTHORIZED,
    ERR_SIGNING_PUB_KEY,
    ERR_SIMULATION_FAILED,
    ERR_TICKET_NOT_AVAILABLE,
    ERR_TICKET_SEQUENCE_MISSING,
    ERR_TICKET_SEQUENCE_NOT_ALLOWED,
    ERR_TRANSACTION_FAILED,
    ERR_TRANSACTION_NOT_VALIDATED,
    ERR_TRANSACTION_TYPE,
    ERR_UNSUPPORTED_SCHEME,
    ERR_VERIFICATION_ERROR,
    ERR_VERIFICATION_FAILED,
    ERR_X402_VERSION,
    SCHEME_EXACT,
    STANDARD_NETWORK_ID_CEILING,
    TF_PARTIAL_PAYMENT,
    XRPL_CAIP_FAMILY,
)
from ..settlement_cache import (
    DEFAULT_SETTLEMENT_TTL_SECONDS,
    SettlementCache,
    SettlementCacheLike,
)
from ..types import (
    ExactXrplPayload,
    XrplFacilitatorOptions,
    resolve_asset_transfer_method,
)
from ..utils import (
    decode_signed_transaction_blob,
    get_max_last_ledger_sequence,
    get_signed_transaction_hash,
    invoice_id_to_invoice_id_field,
    is_canonical_signing_pub_key,
    is_classic_address,
    is_destination_tag,
    is_issued_currency_amount,
    is_issued_currency_value,
    is_xrpl_network,
    normalize_currency_code,
    parse_drops,
    parse_xrpl_network_id,
    verify_signed_blob,
)

try:
    from xrpl.core import keypairs
except ModuleNotFoundError as e:  # pragma: no cover
    if (e.name or "").split(".")[0] != "xrpl":
        raise
    raise ImportError(
        "XRPL mechanism requires xrpl-py. Install with: pip install x402[xrpl]"
    ) from e


def _invalid(reason: str, payer: str = "", message: str | None = None) -> VerifyResponse:
    """Build an invalid verification response.

    Args:
        reason: Machine-readable reason code.
        payer: Payer address when known.
        message: Human-readable detail, for reasons that would otherwise say
            only that something unexpected happened.

    Returns:
        The verification response.
    """
    return VerifyResponse(
        is_valid=False, invalid_reason=reason, invalid_message=message, payer=payer
    )


def _failed(
    reason: str,
    network: str,
    payer: str = "",
    transaction: str = "",
    message: str | None = None,
) -> SettleResponse:
    """Build a failed settlement response.

    Args:
        reason: Machine-readable reason code.
        network: Network identifier.
        payer: Payer address when known.
        transaction: Transaction hash when one exists.
        message: Human-readable detail, for reasons that would otherwise say
            only that something unexpected happened.

    Returns:
        The settlement response.
    """
    return SettleResponse(
        success=False,
        error_reason=reason,
        error_message=message,
        payer=payer,
        transaction=transaction,
        network=network,
    )


class ExactXrplScheme:
    """Verifies and settles exact payments on XRPL networks.

    The facilitator never signs and never holds funds: the payer signs a
    ``Payment`` transaction, and that transaction carries its own fee. The
    facilitator's job is to prove the blob matches the requirements and relay it.

    **The node is the trust anchor.** Every ledger read is believed, so a node
    that invents a regular key or misreports a simulation can make ``verify``
    pass; settlement is the backstop, and a deployment that releases a resource
    on ``verify`` alone inherits its node's honesty. The transaction id is the
    exception: it is a function of the signed blob, so it is computed rather
    than believed.

    **The default duplicate-settlement guard is per-process.** A horizontally
    scaled facilitator must pass a ``settlement_cache`` backed by a shared
    atomic store — anything satisfying
    :class:`~x402.mechanisms.xrpl.settlement_cache.SettlementCacheLike` — or
    duplicates routed to different replicas each pass their local check.
    """

    scheme = SCHEME_EXACT
    caip_family = XRPL_CAIP_FAMILY

    def __init__(
        self,
        options: XrplFacilitatorOptions | None = None,
        settlement_cache: SettlementCacheLike | None = None,
    ) -> None:
        """Create the scheme.

        Args:
            options: Facilitator configuration and ledger overrides.
            settlement_cache: Shared duplicate-settlement guard; anything
                satisfying :class:`SettlementCacheLike`, so a scaled
                deployment can pass a shared-store implementation. A private
                in-process :class:`SettlementCache` is created when omitted.
        """
        self.options = options or XrplFacilitatorOptions()
        # Explicit None test: a falsy-but-real guard (empty ``__len__``) must not be discarded.
        self.settlement_cache: SettlementCacheLike = (
            SettlementCache() if settlement_cache is None else settlement_cache
        )

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """Return capability metadata advertised for this scheme.

        Args:
            network: Target network.

        Returns:
            Extra advertisement fields.
        """
        # The payer funds the transaction fee inside the signed blob, so the
        # facilitator never sponsors fees.
        return {"areFeesSponsored": False}

    def get_signers(self, network: Network) -> list[str]:
        """Return facilitator signer addresses.

        Always empty: the scheme relays a payer-signed transaction, so the
        facilitator holds no keys.

        Args:
            network: Target network.

        Returns:
            An empty list.
        """
        return []

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: Any = None,
    ) -> VerifyResponse:
        """Verify a signed payment against its requirements.

        Args:
            payload: Payment payload.
            requirements: Requirements to verify against.
            context: Unused facilitator context.

        Returns:
            A verification response; failures carry a machine-readable reason.
        """
        payer = ""
        try:
            envelope_error = self._verify_envelope(payload, requirements)
            if envelope_error:
                return _invalid(envelope_error)

            method, method_error = resolve_asset_transfer_method(
                payload.accepted.extra, requirements.extra
            )
            if method_error:
                return _invalid(method_error)
            if method is None:  # pragma: no cover - resolution always sets one
                # Checked, not asserted: under -O an assert would silently pick
                # a transfer method the payload never agreed to.
                return _invalid(ERR_ASSET_TRANSFER_METHOD)

            try:
                exact_payload = ExactXrplPayload.from_dict(payload.payload or {})
            except ValueError:
                return _invalid(ERR_PAYLOAD)

            try:
                tx = decode_signed_transaction_blob(exact_payload.signed_tx_blob)
            except ValueError:
                return _invalid(ERR_PAYLOAD_BLOB)

            # Before the signing-key check: a multisigned or delegated
            # transaction has no single SigningPubKey and would otherwise be
            # reported as a malformed key.
            if tx.get("Signers") is not None:
                return _invalid(ERR_MULTISIG_NOT_SUPPORTED)
            if tx.get("Delegate") is not None:
                return _invalid(ERR_DELEGATE_NOT_ALLOWED)

            if not is_canonical_signing_pub_key(tx.get("SigningPubKey")):
                return _invalid(ERR_SIGNING_PUB_KEY)
            if not verify_signed_blob(exact_payload.signed_tx_blob):
                return _invalid(ERR_SIGNATURE)
            if tx.get("TransactionType") != "Payment":
                return _invalid(ERR_TRANSACTION_TYPE)

            # A blob with no usable Account is bad client input, not a
            # facilitator fault, so it must not raise into the catch-all.
            account = tx.get("Account")
            if not is_classic_address(account):
                return _invalid(ERR_PAYLOAD_BLOB)
            payer = account

            structure_error = self._verify_structure(tx, requirements)
            if structure_error:
                return _invalid(structure_error, payer)

            sequencing_error = self._verify_sequencing(tx, method, payer, requirements)
            if sequencing_error:
                return _invalid(sequencing_error, payer)

            authorization_error = self._verify_signing_authority(tx, payer, requirements)
            if authorization_error:
                return _invalid(authorization_error, payer)

            simulation_error = self._verify_simulation(exact_payload.signed_tx_blob, requirements)
            if simulation_error:
                return _invalid(simulation_error, payer)

            return VerifyResponse(is_valid=True, payer=payer)
        except Exception as error:
            # The reason stays stable for callers to match on; the detail goes
            # in the message.
            return _invalid(ERR_VERIFICATION_ERROR, payer, str(error))

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: Any = None,
    ) -> SettleResponse:
        """Verify then submit a signed payment.

        Args:
            payload: Payment payload.
            requirements: Requirements to settle against.
            context: Unused facilitator context.

        Returns:
            A settlement response.
        """
        network = payload.accepted.network
        payer = ""
        tx_hash = ""
        try:
            verification = self.verify(payload, requirements, context)
            if not verification.is_valid:
                return _failed(
                    verification.invalid_reason or ERR_VERIFICATION_FAILED,
                    network,
                    verification.payer or "",
                    message=verification.invalid_message,
                )

            payer = verification.payer or ""
            exact_payload = ExactXrplPayload.from_dict(payload.payload or {})
            tx_hash = get_signed_transaction_hash(exact_payload.signed_tx_blob)

            # Submission is idempotent on the transaction hash, so without this
            # guard concurrent settles all report success while one payment
            # lands. Retained past the transaction's landable window.
            ttl = float(requirements.max_timeout_seconds or 0) + DEFAULT_SETTLEMENT_TTL_SECONDS
            if self.settlement_cache.is_duplicate(tx_hash, ttl):
                return _failed(ERR_DUPLICATE_SETTLEMENT, network, payer, tx_hash)

            submit = self.options.submit_signed_transaction or (
                lambda blob, net: ledger.submit_signed_transaction(
                    blob, net, self.options.rpc_url_by_network
                )
            )
            result = submit(exact_payload.signed_tx_blob, requirements.network)
            # The transaction id is derivable from the blob, so a transport
            # that contradicts it is faulty or lying, and its verdict on the
            # payment cannot be trusted either.
            if result.hash and result.hash.upper() != tx_hash:
                return _failed(f"{ERR_TRANSACTION_FAILED}: hash_mismatch", network, payer, tx_hash)
            # Distinct from a validated failure: an unvalidated transaction may
            # still land, so it is neither settled nor definitively refused.
            if not result.validated:
                return _failed(
                    f"{ERR_TRANSACTION_NOT_VALIDATED}: {result.result_code}",
                    network,
                    payer,
                    tx_hash,
                )
            if result.result_code != "tesSUCCESS":
                return _failed(
                    f"{ERR_TRANSACTION_FAILED}: {result.result_code}",
                    network,
                    payer,
                    tx_hash,
                )
            return SettleResponse(
                success=True,
                transaction=tx_hash,
                network=network,
                payer=payer,
            )
        except Exception as error:
            # The reason stays stable for callers to match on; the detail,
            # payer and transaction id are what let an operator tell a node
            # outage from a ledger rejection.
            return _failed(ERR_TRANSACTION_FAILED, network, payer, tx_hash, message=str(error))

    # ---------------- verification steps ----------------

    def _verify_envelope(
        self, payload: PaymentPayload, requirements: PaymentRequirements
    ) -> str | None:
        """Check protocol version, scheme and network agreement.

        Args:
            payload: Payment payload.
            requirements: Payment requirements.

        Returns:
            A reason code, or None when valid.
        """
        if payload.x402_version != 2:
            return ERR_X402_VERSION
        if payload.accepted.scheme != SCHEME_EXACT or requirements.scheme != SCHEME_EXACT:
            return ERR_UNSUPPORTED_SCHEME
        if not is_xrpl_network(requirements.network) or not is_xrpl_network(
            payload.accepted.network
        ):
            return ERR_INVALID_NETWORK
        if payload.accepted.network != requirements.network:
            return ERR_NETWORK_MISMATCH

        # The payload restates the terms it is paying; otherwise a client
        # could agree to terms the server never offered.
        if payload.accepted.asset != requirements.asset:
            return ERR_ASSET_MISMATCH
        if payload.accepted.amount != requirements.amount:
            return ERR_AMOUNT_MISMATCH
        if payload.accepted.pay_to != requirements.pay_to:
            return ERR_PAY_TO_MISMATCH
        if payload.accepted.max_timeout_seconds != requirements.max_timeout_seconds:
            return ERR_MAX_TIMEOUT_MISMATCH
        # The expiry window and the duplicate guard's retention both derive
        # from this value, so it must not be unbounded.
        timeout = requirements.max_timeout_seconds
        if timeout < 0:
            return ERR_MAX_TIMEOUT_INVALID
        if timeout > self.options.max_timeout_seconds:
            return ERR_MAX_TIMEOUT_TOO_LARGE

        accepted_extra = payload.accepted.extra or {}
        required_extra = requirements.extra or {}

        # The payer funds the fee, so sponsorship must be explicitly false on
        # both sides, not merely absent, because the TypeScript client
        # refuses requirements that omit it and the two implementations must
        # agree about the same requirements.
        if (
            required_extra.get("areFeesSponsored") is not False
            or accepted_extra.get("areFeesSponsored") is not False
        ):
            return ERR_FEES_SPONSORED_UNSUPPORTED

        if accepted_extra.get("invoiceId") != required_extra.get("invoiceId"):
            return ERR_INVOICE_MISMATCH
        if accepted_extra.get("destinationTag") != required_extra.get("destinationTag"):
            return ERR_DESTINATION_TAG_MISMATCH

        # An issued currency is identified by currency *and* issuer, so
        # requirements naming one without the other are unsatisfiable. XRP
        # payments have no issuer, so a stray key there is left alone, as the
        # TypeScript facilitator does.
        if requirements.asset != ASSET_XRP:
            if not is_classic_address(required_extra.get("issuer")) or not is_classic_address(
                accepted_extra.get("issuer")
            ):
                return ERR_IOU_ISSUER_MISSING
            if accepted_extra.get("issuer") != required_extra.get("issuer"):
                return ERR_IOU_ISSUER_MISMATCH
        return None

    def _verify_structure(
        self, tx: dict[str, Any], requirements: PaymentRequirements
    ) -> str | None:
        """Check destination, network binding, amount, invoice and safety flags.

        Args:
            tx: Decoded transaction.
            requirements: Payment requirements.

        Returns:
            A reason code, or None when valid.
        """
        if tx.get("Destination") != requirements.pay_to:
            return ERR_DESTINATION_MISMATCH

        # Hosted accounts route to a customer by destination tag; a mistagged
        # payment reaches the institution but credits the wrong party.
        required_tag = (requirements.extra or {}).get("destinationTag")
        if required_tag is not None:
            # A tag no transaction can carry would reject every payment while
            # blaming the payer for the server's malformed requirements.
            if not is_destination_tag(required_tag):
                return ERR_DESTINATION_TAG_MALFORMED
            if tx.get("DestinationTag") != required_tag:
                return ERR_PAYLOAD_DESTINATION_TAG_MISMATCH

        network_error = self._verify_network_binding(tx, requirements.network)
        if network_error:
            return network_error

        amount_error = self._verify_amount(tx, requirements)
        if amount_error:
            return amount_error

        # In the TypeScript facilitator's order: a real DeliverMin transaction
        # also carries tfPartialPayment, and both implementations must answer
        # that compound with the same reason code.
        # Paths allow cross-currency delivery of something other than the
        # required asset.
        if tx.get("Paths") is not None:
            return ERR_PATHS_NOT_ALLOWED
        if tx.get("DeliverMin") is not None:
            return ERR_DELIVERMIN_NOT_ALLOWED
        # A partial payment can deliver less than Amount and still succeed.
        # Flags is UInt32 in the binary format, so a decoded blob can only
        # carry an int here.
        flags = tx.get("Flags", 0)
        if flags & TF_PARTIAL_PAYMENT:
            return ERR_PARTIAL_PAYMENT_NOT_ALLOWED
        # Memos are unbounded payer-controlled data; InvoiceID is the binding
        # mechanism.
        if tx.get("Memos") is not None:
            return ERR_MEMOS_NOT_ALLOWED

        invoice_error = self._verify_invoice_binding(tx, requirements)
        if invoice_error:
            return invoice_error

        fee = parse_drops(tx.get("Fee"))
        if fee is None:
            return ERR_FEE_MISSING
        max_fee = parse_drops(self.options.max_fee_drops)
        if max_fee is None:
            # A facilitator misconfiguration, not a payment fault: raising here
            # reports it under the facilitator-error code with the detail.
            raise ValueError(f"max_fee_drops is not a drops amount: {self.options.max_fee_drops!r}")
        if fee > max_fee:
            return ERR_FEE_TOO_HIGH

        return self._verify_expiry(tx, requirements)

    def _verify_network_binding(self, tx: dict[str, Any], network: Network) -> str | None:
        """Check the signed NetworkID against the target network.

        Standard networks omit the field; a transaction that carries one for a
        standard network could be replayed on another.

        Args:
            tx: Decoded transaction.
            network: CAIP-2 network identifier.

        Returns:
            A reason code, or None when valid.
        """
        network_id = parse_xrpl_network_id(network)
        signed_network_id = tx.get("NetworkID")
        if network_id <= STANDARD_NETWORK_ID_CEILING:
            if signed_network_id is not None:
                return ERR_NETWORK_ID_FOR_STANDARD_NETWORK
        elif signed_network_id != network_id:
            return ERR_NETWORK_ID_MISMATCH
        return None

    def _verify_amount(self, tx: dict[str, Any], requirements: PaymentRequirements) -> str | None:
        """Check the delivered amount matches the requirement exactly.

        Args:
            tx: Decoded transaction.
            requirements: Payment requirements.

        Returns:
            A reason code, or None when valid.
        """
        # The spec resolves the amount as DeliverMax, else Amount, rejecting
        # both at once. DeliverMax is a JSON-API alias with no binary-format
        # field, so a decoded blob can only carry Amount.
        amount = tx.get("Amount")

        if requirements.asset == ASSET_XRP:
            if is_issued_currency_amount(amount):
                return ERR_AMOUNT_XRP
            required = parse_drops(requirements.amount)
            if required is None:
                # No payment can satisfy this; blaming the payload would hide
                # the requirements author's fault.
                raise ValueError(
                    f"requirements.amount is not a drops amount: {requirements.amount!r}"
                )
            paid = parse_drops(amount)
            if paid is None or paid != required:
                return ERR_PAYLOAD_AMOUNT_MISMATCH
            # SendMax has no legitimate role in an XRP-to-XRP payment.
            if tx.get("SendMax") is not None:
                return ERR_SENDMAX_NOT_ALLOWED
            return None

        if not is_issued_currency_amount(amount):
            return ERR_IOU_AMOUNT
        # Compared as the ledger spells them: the codec normalises the hex
        # form of a standard code back to the ISO code on decode.
        required_currency = normalize_currency_code(requirements.asset)
        if required_currency is None:
            raise ValueError(
                f"requirements.asset is not a usable currency code: {requirements.asset!r}"
            )
        if amount["currency"] != required_currency:
            return ERR_IOU_CURRENCY_MISMATCH
        issuer = (requirements.extra or {}).get("issuer")
        if not issuer or amount["issuer"] != issuer:
            return ERR_PAYLOAD_IOU_ISSUER_MISMATCH

        # Decimal, not string, comparison: the ledger serialises "1.50" as
        # "1.5".
        required_value = _decimal(requirements.amount)
        if required_value is None:
            raise ValueError(
                f"requirements.amount is not an issued-currency value: {requirements.amount!r}"
            )
        paid_value = _decimal(amount["value"])
        if paid_value is None or paid_value != required_value:
            return ERR_IOU_VALUE_MISMATCH

        # SendMax is mandatory for issued currencies. It may exceed Amount --
        # that is how issuer transfer fees are paid, but it must match the
        # currency and issuer.
        send_max = tx.get("SendMax")
        if not is_issued_currency_amount(send_max):
            return ERR_SENDMAX_REQUIRED
        if send_max["currency"] != amount["currency"] or send_max["issuer"] != amount["issuer"]:
            return ERR_SENDMAX_IOU_MISMATCH
        send_max_value = _decimal(send_max["value"])
        if send_max_value is None or send_max_value < paid_value:
            return ERR_SENDMAX_TOO_LOW
        return None

    def _verify_invoice_binding(
        self, tx: dict[str, Any], requirements: PaymentRequirements
    ) -> str | None:
        """Check the transaction commits to the required invoice.

        Args:
            tx: Decoded transaction.
            requirements: Payment requirements.

        Returns:
            A reason code, or None when valid.
        """
        invoice_id = (requirements.extra or {}).get("invoiceId")
        if invoice_id is None:
            return None
        if not isinstance(invoice_id, str) or invoice_id == "":
            return ERR_INVOICE_MISSING
        if tx.get("InvoiceID") is None:
            return ERR_INVOICE_MISSING
        expected = invoice_id_to_invoice_id_field(invoice_id)
        if str(tx["InvoiceID"]).upper() != expected:
            return ERR_INVOICE_ID_MISMATCH
        return None

    def _verify_expiry(self, tx: dict[str, Any], requirements: PaymentRequirements) -> str | None:
        """Check the transaction expires within the allowed window.

        Args:
            tx: Decoded transaction.
            requirements: Payment requirements.

        Returns:
            A reason code, or None when valid.
        """
        last_ledger = tx.get("LastLedgerSequence")
        if not isinstance(last_ledger, int):
            return ERR_LAST_LEDGER_SEQUENCE_MISSING

        get_index = self.options.get_current_ledger_index or (
            lambda net: ledger.get_current_ledger_index(net, self.options.rpc_url_by_network)
        )
        current = get_index(requirements.network)
        if last_ledger <= current:
            return ERR_EXPIRED

        # The timeout bounds how far ahead the expiry may sit, so a signed
        # blob cannot stay replayable long after the request it paid for.
        if last_ledger > get_max_last_ledger_sequence(current, requirements.max_timeout_seconds):
            return ERR_LAST_LEDGER_SEQUENCE_TOO_LARGE
        return None

    def _verify_sequencing(
        self,
        tx: dict[str, Any],
        method: str,
        payer: str,
        requirements: PaymentRequirements,
    ) -> str | None:
        """Check the sequencing fields match the agreed transfer method.

        Args:
            tx: Decoded transaction.
            method: Resolved asset transfer method.
            payer: Payer classic address.
            requirements: Payment requirements.

        Returns:
            A reason code, or None when valid.
        """
        sequence = tx.get("Sequence")
        ticket_sequence = tx.get("TicketSequence")

        if method == "ticketSequence":
            if sequence != 0:
                return ERR_SEQUENCE_MUST_BE_ZERO
            if not isinstance(ticket_sequence, int) or ticket_sequence <= 0:
                return ERR_TICKET_SEQUENCE_MISSING
            available = self.options.is_ticket_available or (
                lambda account, ticket, net: ledger.is_ticket_available(
                    account, ticket, net, self.options.rpc_url_by_network
                )
            )
            if not available(payer, ticket_sequence, requirements.network):
                return ERR_TICKET_NOT_AVAILABLE
            return None

        if ticket_sequence is not None:
            return ERR_TICKET_SEQUENCE_NOT_ALLOWED
        if not isinstance(sequence, int) or sequence <= 0:
            return ERR_SEQUENCE_MISSING
        get_sequence = self.options.get_account_sequence or (
            lambda account, net: ledger.get_account_sequence(
                account, net, self.options.rpc_url_by_network
            )
        )
        if sequence != get_sequence(payer, requirements.network):
            return ERR_SEQUENCE_NOT_CURRENT
        return None

    def _verify_simulation(
        self, signed_tx_blob: str, requirements: PaymentRequirements
    ) -> str | None:
        """Dry-run the transaction before accepting it.

        Static checks cannot see whether the payer can actually pay. Without
        simulation a resource server does the work it is being paid for, then
        discovers at settlement that the account was unfunded or the trust line
        missing.

        Args:
            signed_tx_blob: Hex-encoded signed transaction.
            requirements: Payment requirements.

        Returns:
            A reason code, or None when the transaction would succeed.
        """
        simulate = self.options.simulate_signed_transaction or (
            lambda blob, net: ledger.simulate_signed_transaction(
                blob, net, self.options.rpc_url_by_network
            )
        )
        engine_result = simulate(signed_tx_blob, requirements.network)
        if engine_result != "tesSUCCESS":
            return f"{ERR_SIMULATION_FAILED}: {engine_result}"
        return None

    def _verify_signing_authority(
        self, tx: dict[str, Any], payer: str, requirements: PaymentRequirements
    ) -> str | None:
        """Check the signing key is currently authorised on the payer's account.

        A valid signature only proves the blob was signed by the holder of the
        embedded key. It does not prove that key still controls the account: a
        regular key may have been rotated, or the master key disabled.

        Args:
            tx: Decoded transaction.
            payer: Payer classic address.
            requirements: Payment requirements.

        Returns:
            A reason code, or None when valid.
        """
        get_authorization = self.options.get_account_authorization or (
            lambda account, net: ledger.get_account_authorization(
                account, net, self.options.rpc_url_by_network
            )
        )
        authorization = get_authorization(payer, requirements.network)
        signing_address = keypairs.derive_classic_address(tx["SigningPubKey"])

        # In rippled's order: regular key first, then the master key unless
        # disabled. Accounts predating fixMasterKeyAsRegularKey can hold their
        # own address as RegularKey, and checking the master key first would
        # refuse a payment the ledger accepts.
        if authorization.regular_key and signing_address == authorization.regular_key:
            return None
        if signing_address == payer:
            if authorization.is_master_key_disabled:
                return ERR_MASTER_KEY_DISABLED
            return None
        return ERR_SIGNER_NOT_AUTHORIZED


def _decimal(value: Any) -> Decimal | None:
    """Parse an issued-currency value as an exact decimal.

    Args:
        value: Candidate value.

    Returns:
        The parsed decimal, or None when malformed.
    """
    if not is_issued_currency_value(value):
        return None
    return Decimal(value)
