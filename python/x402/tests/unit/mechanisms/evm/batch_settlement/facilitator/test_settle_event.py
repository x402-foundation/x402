"""Settled-event decode must work with the exported FacilitatorWeb3Signer."""

from __future__ import annotations

import pytest

try:
    from eth_abi import encode
    from eth_utils import event_abi_to_log_topic, to_checksum_address
    from hexbytes import HexBytes

    from x402.mechanisms.evm.batch_settlement.abi import BATCH_SETTLEMENT_ABI
    from x402.mechanisms.evm.batch_settlement.constants import BATCH_SETTLEMENT_ADDRESS
    from x402.mechanisms.evm.batch_settlement.facilitator.settle import _parse_settled_amount
    from x402.mechanisms.evm.signers import FacilitatorWeb3Signer
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


_ANVIL_KEY = "0x" + "11" * 32


def _addr_topic(addr: str) -> HexBytes:
    return HexBytes("0x" + addr[2:].lower().rjust(64, "0"))


def test_parse_settled_amount_with_facilitator_web3_signer():
    signer = FacilitatorWeb3Signer(private_key=_ANVIL_KEY, rpc_url="http://127.0.0.1:9")
    assert signer.web3 is signer._w3

    contract_addr = to_checksum_address(BATCH_SETTLEMENT_ADDRESS)
    receiver = to_checksum_address("0x" + "33" * 20)
    token = to_checksum_address("0x" + "55" * 20)
    amount = 999

    settled_abi = next(item for item in BATCH_SETTLEMENT_ABI if item.get("name") == "Settled")
    log = {
        "address": contract_addr,
        "topics": [
            HexBytes(event_abi_to_log_topic(settled_abi)),
            _addr_topic(receiver),
            _addr_topic(token),
            _addr_topic(signer.address),
        ],
        "data": "0x" + encode(["uint128"], [amount]).hex(),
        "logIndex": 0,
        "transactionIndex": 0,
        "transactionHash": HexBytes("0x" + "ab" * 32),
        "blockHash": HexBytes("0x" + "cd" * 32),
        "blockNumber": 1,
    }

    class _Receipt:
        logs = [log]

    assert _parse_settled_amount(signer, _Receipt(), contract_addr, receiver, token) == "999"
