"""RPC-backed facilitator signer for canonical SVM payment channels."""

from __future__ import annotations

import base64
import json
import time
from typing import Any

from solana.rpc.commitment import Confirmed, Finalized
from solana.rpc.types import MemcmpOpts
from solders.account_decoder import UiAccountEncoding
from solders.commitment_config import CommitmentLevel
from solders.hash import Hash
from solders.message import from_bytes_versioned
from solders.pubkey import Pubkey
from solders.rpc.config import RpcAccountInfoConfig, RpcContextConfig
from solders.rpc.requests import GetAccountInfo, IsBlockhashValid
from solders.rpc.responses import GetAccountInfoResp, IsBlockhashValidResp
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from ..signers import FacilitatorKeypairSigner


class BatchFacilitatorKeypairSigner(FacilitatorKeypairSigner):
    """Existing keypair signer plus confirmed account and transaction reads."""

    def get_account_info(
        self, address: str, network: str, *, min_context_slot: int | None = None
    ) -> dict[str, Any] | None:
        return self.get_account_info_with_context(
            address, network, min_context_slot=min_context_slot
        )["account"]

    def get_account_info_with_context(
        self, address: str, network: str, *, min_context_slot: int | None = None
    ) -> dict[str, Any]:
        """Preserve the RPC context even when the account is absent."""
        config = RpcAccountInfoConfig(
            encoding=UiAccountEncoding.Base64,
            commitment=CommitmentLevel.Confirmed,
            min_context_slot=min_context_slot,
        )
        response = self._get_client(network)._provider.make_request(
            GetAccountInfo(Pubkey.from_string(address), config), GetAccountInfoResp
        )
        if min_context_slot is not None and response.context.slot < min_context_slot:
            raise RuntimeError("RPC account context precedes the confirmed transaction")
        return {
            "context_slot": response.context.slot,
            "account": {
                "data": bytes(response.value.data),
                "owner": str(response.value.owner),
                "executable": response.value.executable,
                "context_slot": response.context.slot,
            }
            if response.value is not None
            else None,
        }

    def get_latest_blockhash(self, network: str) -> dict[str, Any]:
        response = self._get_client(network).get_latest_blockhash(commitment=Confirmed)
        value = response.value
        return {
            "blockhash": str(value.blockhash),
            "last_valid_block_height": value.last_valid_block_height,
            "context_slot": response.context.slot,
        }

    def get_slot(self, network: str) -> int:
        return self._get_client(network).get_slot(commitment=Finalized).value

    def get_block_height(self, network: str) -> int:
        return self._get_client(network).get_block_height(commitment=Finalized).value

    def is_blockhash_valid(
        self, blockhash: str, network: str, *, min_context_slot: int | None = None
    ) -> bool:
        config = RpcContextConfig(
            commitment=CommitmentLevel.Finalized,
            min_context_slot=min_context_slot,
        )
        response = self._get_client(network)._provider.make_request(
            IsBlockhashValid(Hash.from_string(blockhash), config),
            IsBlockhashValidResp,
        )
        if min_context_slot is not None and response.context.slot < min_context_slot:
            raise RuntimeError("RPC validity context precedes the successful simulation")
        return response.value

    def get_signature_status(self, signature: str, network: str) -> dict[str, Any] | None:
        response = self._get_client(network).get_signature_statuses(
            [Signature.from_string(signature)], search_transaction_history=True
        )
        value = json.loads(response.to_json())["result"]["value"][0]
        if value is None:
            return None
        return {
            "err": value["err"],
            "confirmation_status": value.get("confirmationStatus"),
            "slot": value["slot"],
        }

    def get_transaction(self, signature: str, network: str) -> dict[str, Any] | None:
        response = self._get_client(network).get_transaction(
            Signature.from_string(signature),
            encoding="json",
            commitment=Confirmed,
            max_supported_transaction_version=0,
        )
        return json.loads(response.to_json())["result"]

    def get_program_accounts(
        self, program_id: str, network: str, *, filters: list[Any]
    ) -> list[dict[str, Any]]:
        normalized = []
        for entry in filters:
            if isinstance(entry, dict):
                if "dataSize" in entry:
                    normalized.append(entry["dataSize"])
                else:
                    value = entry["memcmp"]
                    if value.get("encoding", "base58") != "base58":
                        raise ValueError("channel scans require base58 memcmp filters")
                    normalized.append(MemcmpOpts(offset=value["offset"], bytes=value["bytes"]))
            else:
                normalized.append(entry)
        rows = (
            self._get_client(network)
            .get_program_accounts(
                Pubkey.from_string(program_id),
                commitment=Confirmed,
                encoding="base64",
                filters=normalized,
            )
            .value
        )
        return [
            {
                "pubkey": str(row.pubkey),
                "account": {
                    "data": bytes(row.account.data),
                    "owner": str(row.account.owner),
                    "executable": row.account.executable,
                },
            }
            for row in rows
        ]

    def get_balance(self, address: str, network: str) -> int:
        return (
            self._get_client(network)
            .get_balance(Pubkey.from_string(address), commitment=Confirmed)
            .value
        )

    def get_fee_for_message(self, message_base64: str, network: str) -> int | None:
        message = from_bytes_versioned(base64.b64decode(message_base64, validate=True))
        return self._get_client(network).get_fee_for_message(message, commitment=Confirmed).value

    def get_minimum_balance_for_rent_exemption(self, size: int, network: str) -> int:
        return (
            self._get_client(network)
            .get_minimum_balance_for_rent_exemption(size, commitment=Confirmed)
            .value
        )

    def simulate_transaction(self, tx_base64: str, network: str, *, sig_verify: bool = True) -> int:
        transaction = VersionedTransaction.from_bytes(base64.b64decode(tx_base64, validate=True))
        result = self._get_client(network).simulate_transaction(
            transaction,
            sig_verify=sig_verify,
            commitment=Confirmed,
        )
        if result.value.err is not None:
            raise RuntimeError(f"Simulation failed: {result.value.err}")
        return result.context.slot

    def confirm_transaction(self, signature: str, network: str, timeout_seconds: int = 30) -> int:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            status = self.get_signature_status(signature, network)
            if status is not None:
                if status["err"] is not None:
                    raise RuntimeError(f"Transaction failed: {status['err']}")
                if status["confirmation_status"] in ("confirmed", "finalized"):
                    return status["slot"]
            time.sleep(0.5)
        raise RuntimeError("Transaction confirmation timeout")
