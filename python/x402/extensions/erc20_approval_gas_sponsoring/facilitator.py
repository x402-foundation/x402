"""Facilitator-side extraction and validation for ERC-20 Approval Gas Sponsoring."""

from __future__ import annotations

import re

from ...mechanisms.evm.constants import PERMIT2_ADDRESS
from ...schemas import PaymentPayload
from .types import ERC20_APPROVAL_GAS_SPONSORING_KEY, Erc20ApprovalGasSponsoringInfo

_HEX_ADDRESS = re.compile(r"^0x[a-fA-F0-9]{40}$")
_DECIMAL_STRING = re.compile(r"^[0-9]+$")
_HEX_STRING = re.compile(r"^0x[a-fA-F0-9]+$")
_VERSION_STRING = re.compile(r"^[0-9]+(\.[0-9]+)*$")

# ERC-20 approve(address,uint256) selector
_APPROVE_SELECTOR = "095ea7b3"


def extract_erc20_approval_gas_sponsoring_info(
    payload: PaymentPayload,
) -> Erc20ApprovalGasSponsoringInfo | None:
    """Extract ERC-20 approval gas sponsoring info from a payment payload.

    Returns None if the extension is not present or malformed.
    """
    extensions = payload.extensions
    if not extensions:
        return None

    ext_data = extensions.get(ERC20_APPROVAL_GAS_SPONSORING_KEY)
    if not isinstance(ext_data, dict):
        return None

    info = ext_data.get("info")
    if not isinstance(info, dict):
        return None

    required = ["from", "asset", "spender", "amount", "signedTransaction"]
    if not all(isinstance(info.get(k), str) for k in required):
        return None

    return Erc20ApprovalGasSponsoringInfo.from_dict(info)


def validate_erc20_approval_gas_sponsoring_info(
    info: Erc20ApprovalGasSponsoringInfo,
) -> bool:
    """Validate info fields against the JSON Schema patterns."""
    return (
        bool(_HEX_ADDRESS.match(info.from_address))
        and bool(_HEX_ADDRESS.match(info.asset))
        and bool(_HEX_ADDRESS.match(info.spender))
        and bool(_DECIMAL_STRING.match(info.amount))
        and bool(_HEX_STRING.match(info.signed_transaction))
        and bool(_VERSION_STRING.match(info.version))
    )


def validate_erc20_approval_for_payment(
    info: Erc20ApprovalGasSponsoringInfo,
    payer: str,
    token_address: str,
) -> tuple[str, str]:
    """Validate ERC-20 approval extension data for a specific payment.

    Returns ("", "") if valid, or (reason, message) on failure.
    Performs schema validation, address matching, and signed tx decoding.
    """
    if not validate_erc20_approval_gas_sponsoring_info(info):
        return "invalid_erc20_approval_extension_format", "format validation failed"

    if info.from_address.lower() != payer.lower():
        return "erc20_approval_from_mismatch", "from does not match payer"

    if info.asset.lower() != token_address.lower():
        return "erc20_approval_asset_mismatch", "asset does not match token"

    if info.spender.lower() != PERMIT2_ADDRESS.lower():
        return "erc20_approval_spender_not_permit2", "spender is not Permit2"

    # Decode and validate the signed transaction
    try:
        reason, msg = _validate_signed_approval_tx(info.signed_transaction, payer, token_address)
        if reason:
            return reason, msg
    except Exception as e:
        return "erc20_approval_tx_parse_failed", str(e)[:200]

    return "", ""


def _validate_signed_approval_tx(
    signed_tx_hex: str,
    payer: str,
    token_address: str,
) -> tuple[str, str]:
    """Decode and validate a signed ERC-20 approve transaction.

    Checks: target address, function selector, spender in calldata,
    and recovered signer.
    """
    try:
        from eth_account import Account
    except ImportError:
        return "erc20_approval_tx_validation_unavailable", "eth_account not installed"

    tx_bytes = bytes.fromhex(signed_tx_hex[2:] if signed_tx_hex.startswith("0x") else signed_tx_hex)

    try:
        recovered = Account.recover_transaction(signed_tx_hex)
    except Exception:
        return "erc20_approval_tx_invalid_signature", "failed to recover signer"

    if recovered.lower() != payer.lower():
        return "erc20_approval_tx_signer_mismatch", "recovered signer does not match payer"

    try:
        from eth_account.typed_transactions import TypedTransaction
        from hexbytes import HexBytes

        tx_obj = TypedTransaction.from_bytes(HexBytes(tx_bytes))
        tx_dict = tx_obj.transaction.dictionary

        to_addr = tx_dict.get("to", b"")
        if isinstance(to_addr, bytes):
            to_addr = "0x" + to_addr.hex()
        to_addr = str(to_addr)

        if to_addr.lower() != token_address.lower():
            return "erc20_approval_tx_wrong_target", "tx target is not the token"

        data = tx_dict.get("data", b"")
        if isinstance(data, bytes):
            data_hex = data.hex()
        else:
            data_hex = str(data)

        if not data_hex.startswith(_APPROVE_SELECTOR):
            return "erc20_approval_tx_wrong_selector", "not an approve() call"

        # Decode spender from calldata (bytes 4..36 = 32-byte padded address)
        if len(data_hex) < 72:
            return "erc20_approval_tx_invalid_calldata", "calldata too short"

        spender_hex = "0x" + data_hex[32:72]
        if spender_hex.lower() != PERMIT2_ADDRESS.lower():
            return "erc20_approval_tx_wrong_spender", "approve spender is not Permit2"

    except ImportError:
        return "erc20_approval_tx_validation_unavailable", "typed transaction parsing not available"
    except Exception as e:
        return "erc20_approval_tx_parse_failed", str(e)[:200]

    return "", ""
