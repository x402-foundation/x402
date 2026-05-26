"""TVM client implementation for the Exact payment scheme (V2)."""

from __future__ import annotations

import base64
import time
from typing import Any

from ....schemas import PaymentRequirements
from ..codecs.common import normalize_address
from ..codecs.jetton import build_jetton_transfer_body
from ..codecs.w5 import build_w5_signed_body, get_w5_seqno
from ..constants import (
    DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT,
    DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    DEFAULT_TONCENTER_TIMEOUT_SECONDS,
    DEFAULT_TVM_EMULATION_ADDRESS,
    DEFAULT_TVM_EMULATION_RELAY_AMOUNT,
    DEFAULT_TVM_EMULATION_SEQNO,
    DEFAULT_TVM_EMULATION_WALLET_ID,
    DEFAULT_TVM_INNER_GAS_BUFFER,
    SCHEME_EXACT,
    SEND_MODE_IGNORE_ERRORS,
    SEND_MODE_PAY_FEES_SEPARATELY,
    SUPPORTED_NETWORKS,
    TVM_PROVIDER_TONCENTER,
    W5_EXTERNAL_SIGNED_OPCODE,
    W5_INTERNAL_SIGNED_OPCODE,
)
from ..provider import TvmProviderClient, create_tvm_provider_client
from ..signer import ClientTvmSigner
from ..trace_utils import (
    parse_trace_transactions,
    trace_transaction_compute_fees,
    trace_transaction_fwd_fees,
    trace_transaction_storage_fees,
    transaction_succeeded,
)
from ..types import ExactTvmPayload

try:
    from pytoniq.contract.contract import Contract
    from pytoniq_core import Address, Cell
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages. Install with: pip install x402[tvm]"
    ) from e


class ExactTvmScheme:
    """TVM client implementation for the Exact payment scheme (V2)."""

    scheme = SCHEME_EXACT

    def __init__(self, signer: ClientTvmSigner) -> None:
        self._signer = signer
        self._clients: dict[str, TvmProviderClient] = {}

    def close(self) -> None:
        """Close any cached provider clients owned by this scheme."""
        for client in self._clients.values():
            client.close()
        self._clients.clear()

    def create_payment_payload(
        self,
        requirements: PaymentRequirements,
    ) -> dict[str, Any]:
        """Create a signed TON exact payment payload."""
        network = str(requirements.network)
        if network not in SUPPORTED_NETWORKS:
            raise ValueError(f"Unsupported TVM network: {network}")
        if network != self._signer.network:
            raise ValueError(
                f"Signer network {self._signer.network} does not match requirements network {network}"
            )
        if requirements.extra.get("areFeesSponsored") is not True:
            raise ValueError("Exact TVM scheme requires extra.areFeesSponsored to be true")

        client = self._get_client(network)
        payer = normalize_address(self._signer.address)
        asset = normalize_address(requirements.asset)
        source_wallet = client.get_jetton_wallet(asset, payer)

        account = client.get_account_state(payer)
        include_state_init = not account.is_active
        seqno = get_w5_seqno(account)
        valid_until = int(time.time()) + (
            requirements.max_timeout_seconds - 5
            if requirements.max_timeout_seconds > 10
            else (requirements.max_timeout_seconds + 1) // 2
        )
        transfer_body = self._build_transfer_body(requirements)
        required_inner = self._estimate_required_inner_value(
            client=client,
            source_wallet=source_wallet,
            requirements=requirements,
            seqno=seqno,
            valid_until=valid_until,
            transfer_body=transfer_body,
            include_state_init=include_state_init,
        )

        signed_body = self._build_signed_body(
            source_wallet=source_wallet,
            transfer_body=transfer_body,
            seqno=seqno,
            valid_until=valid_until,
            attached_amount=required_inner,
        )
        settlement_boc = self._build_settlement_boc(payer, signed_body, include_state_init)

        return ExactTvmPayload(
            settlement_boc=settlement_boc,
            asset=asset,
        ).to_dict()

    def _get_client(self, network: str) -> TvmProviderClient:
        if network not in self._clients:
            self._clients[network] = create_tvm_provider_client(
                network,
                provider=getattr(self._signer, "provider", TVM_PROVIDER_TONCENTER),
                api_key=getattr(self._signer, "api_key", None),
                base_url=getattr(self._signer, "provider_base_url", None),
                timeout=float(
                    getattr(
                        self._signer,
                        "provider_timeout_seconds",
                        DEFAULT_TONCENTER_TIMEOUT_SECONDS,
                    )
                ),
            )
        return self._clients[network]

    def _build_w5_signed_body(
        self,
        *,
        out_message: Cell,
        seqno: int,
        valid_until: int,
        opcode: int = W5_INTERNAL_SIGNED_OPCODE,
        send_mode: int = SEND_MODE_PAY_FEES_SEPARATELY,
        wallet_id: int | None = None,
    ) -> Cell:
        return build_w5_signed_body(
            out_message=out_message,
            seqno=seqno,
            valid_until=valid_until,
            sign_message=self._signer.sign_message,
            wallet_id=self._signer.wallet_id if wallet_id is None else wallet_id,
            opcode=opcode,
            send_mode=send_mode,
        )

    def _build_signed_body(
        self,
        *,
        source_wallet: str,
        transfer_body: Cell,
        seqno: int,
        valid_until: int,
        attached_amount: int,
        opcode: int = W5_INTERNAL_SIGNED_OPCODE,
        send_mode: int = SEND_MODE_PAY_FEES_SEPARATELY,
        wallet_id: int | None = None,
    ) -> Cell:
        out_msg = Contract.create_internal_msg(
            src=None,
            dest=Address(source_wallet),
            bounce=True,
            value=attached_amount,
            body=transfer_body,
        ).serialize()
        return self._build_w5_signed_body(
            out_message=out_msg,
            seqno=seqno,
            valid_until=valid_until,
            opcode=opcode,
            send_mode=send_mode,
            wallet_id=wallet_id,
        )

    def _build_settlement_boc(self, payer: str, body: Cell, include_state_init: bool) -> str:
        message = Contract.create_internal_msg(
            src=None,
            dest=Address(payer),
            bounce=True,
            value=0,
            state_init=self._signer.state_init if include_state_init else None,
            body=body,
        )
        return base64.b64encode(message.serialize().to_boc()).decode("utf-8")

    def _build_transfer_body(self, requirements: PaymentRequirements) -> Cell:
        return build_jetton_transfer_body(requirements)

    def _estimate_required_inner_value(
        self,
        *,
        client: TvmProviderClient,
        source_wallet: str,
        requirements: PaymentRequirements,
        seqno: int,
        valid_until: int,
        transfer_body: Cell,
        include_state_init: bool,
    ) -> int:
        forward_ton_amount = int(requirements.extra.get("forwardTonAmount", 0))
        provisional_value = DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT + forward_ton_amount
        payer_body = self._build_signed_body(
            source_wallet=source_wallet,
            transfer_body=transfer_body,
            seqno=seqno,
            valid_until=valid_until,
            attached_amount=provisional_value,
        )
        relay_message = Contract.create_internal_msg(
            src=None,
            dest=Address(self._signer.address),
            bounce=True,
            value=DEFAULT_TVM_EMULATION_RELAY_AMOUNT,
            state_init=self._signer.state_init if include_state_init else None,
            body=payer_body,
        ).serialize()
        external_body = self._build_w5_signed_body(
            out_message=relay_message,
            seqno=DEFAULT_TVM_EMULATION_SEQNO,
            valid_until=valid_until,
            opcode=W5_EXTERNAL_SIGNED_OPCODE,
            send_mode=SEND_MODE_PAY_FEES_SEPARATELY + SEND_MODE_IGNORE_ERRORS,
            wallet_id=DEFAULT_TVM_EMULATION_WALLET_ID,
        )
        external_message = Contract.create_external_msg(
            dest=Address(DEFAULT_TVM_EMULATION_ADDRESS),
            body=external_body,
        )
        trace = client.emulate_trace(
            external_message.serialize().to_boc(),
            ignore_chksig=True,
            timeout=float(
                getattr(
                    self._signer,
                    "provider_emulation_timeout_seconds",
                    DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
                )
            ),
        )
        transactions = parse_trace_transactions(trace)

        source_wallet_tx = None
        for transaction in transactions:
            if normalize_address(transaction["account"]) != normalize_address(source_wallet):
                continue
            if not transaction_succeeded(transaction):
                continue
            in_msg = transaction.get("in_msg") or {}
            if in_msg.get("decoded_opcode") == "jetton_transfer" and normalize_address(
                in_msg["source"]
            ) == normalize_address(self._signer.address):
                source_wallet_tx = transaction
                break
        if source_wallet_tx is None:
            raise ValueError("Trace does not contain the expected source jetton wallet transaction")

        receiver_wallet_tx = None
        for transaction in transactions:
            if not transaction_succeeded(transaction):
                continue
            in_msg = transaction.get("in_msg") or {}
            if in_msg.get("decoded_opcode") == "jetton_internal_transfer" and normalize_address(
                in_msg["source"]
            ) == normalize_address(source_wallet):
                receiver_wallet_tx = transaction
                break
        if receiver_wallet_tx is None:
            raise ValueError(
                "Trace does not contain the expected destination jetton wallet transaction"
            )

        forward_fees = trace_transaction_fwd_fees(
            source_wallet_tx,
            expected_count=2 if forward_ton_amount > 0 else 1,
        )
        compute_fee_source = trace_transaction_compute_fees(source_wallet_tx)
        compute_fee_destination = trace_transaction_compute_fees(receiver_wallet_tx)
        storage_fees_source = trace_transaction_storage_fees(source_wallet_tx)

        return (
            DEFAULT_TVM_INNER_GAS_BUFFER
            + forward_fees
            + compute_fee_source
            + compute_fee_destination
            + forward_ton_amount
            + storage_fees_source
        )
