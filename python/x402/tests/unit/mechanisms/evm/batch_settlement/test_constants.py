"""Unit tests for batch-settlement constants.

Mirrors go/mechanisms/evm/batch-settlement/constants_test.go.

Checksums, the withdraw-delay ordering, the typehash derivation, unique
payload discriminators, and the error-code prefix are behavior. EIP-712
field order is checked by encoding each struct back to its type string.
"""

from __future__ import annotations

import pytest

try:
    from eth_utils import keccak, to_checksum_address

    from x402.mechanisms.evm.batch_settlement import constants as C  # noqa: N812
    from x402.mechanisms.evm.batch_settlement import errors as E  # noqa: N812
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


class TestContractAddresses:
    @pytest.mark.parametrize(
        "address",
        [
            C.BATCH_SETTLEMENT_ADDRESS,
            C.ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
            C.PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
        ],
    )
    def test_address_is_checksum_hex(self, address: str):
        assert address.startswith("0x")
        assert len(address) == 42
        assert address == to_checksum_address(address)


class TestWithdrawDelayBounds:
    def test_min_lt_max(self):
        assert C.MIN_WITHDRAW_DELAY < C.MAX_WITHDRAW_DELAY


def _eip712_type_string(primary: str, fields: list[dict[str, str]]) -> str:
    body = ",".join(f"{field['type']} {field['name']}" for field in fields)
    return f"{primary}({body})"


class TestChannelConfigType:
    def test_typehash_is_keccak_of_type_string(self):
        assert C.CHANNEL_CONFIG_TYPEHASH == keccak(text=C.CHANNEL_CONFIG_TYPE_STRING)

    def test_types_dict_shape(self):
        fields = C.CHANNEL_CONFIG_TYPES["ChannelConfig"]
        encoded = _eip712_type_string("ChannelConfig", fields)
        assert encoded == C.CHANNEL_CONFIG_TYPE_STRING
        assert C.CHANNEL_CONFIG_TYPEHASH == keccak(text=encoded)


class TestVoucherTypes:
    def test_shape(self):
        encoded = _eip712_type_string("Voucher", C.VOUCHER_TYPES["Voucher"])
        assert encoded == "Voucher(bytes32 channelId,uint128 maxClaimableAmount)"
        assert (
            keccak(text=encoded).hex()
            == "1e1bd6ff84c3e0d9029a292b212e039c0ca97ec497c55191a4a5874294609a69"
        )


class TestRefundTypes:
    def test_shape(self):
        encoded = _eip712_type_string("Refund", C.REFUND_TYPES["Refund"])
        assert encoded == "Refund(bytes32 channelId,uint256 nonce,uint128 amount)"


class TestClaimBatchTypes:
    def test_batch_wraps_array(self):
        cb = C.CLAIM_BATCH_TYPES["ClaimBatch"]
        assert len(cb) == 1
        assert cb[0] == {"name": "claims", "type": "ClaimEntry[]"}

    def test_entry_has_three_fields(self):
        encoded = _eip712_type_string("ClaimEntry", C.CLAIM_BATCH_TYPES["ClaimEntry"])
        assert encoded == (
            "ClaimEntry(bytes32 channelId,uint128 maxClaimableAmount,uint128 totalClaimed)"
        )


class TestReceiveAuthorizationTypes:
    def test_shape(self):
        encoded = _eip712_type_string(
            "ReceiveWithAuthorization",
            C.RECEIVE_AUTHORIZATION_TYPES["ReceiveWithAuthorization"],
        )
        assert encoded == (
            "ReceiveWithAuthorization(address from,address to,uint256 value,"
            "uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        )


class TestPermit2WitnessTypes:
    def test_top_level_struct(self):
        names = [
            field["name"] for field in C.BATCH_PERMIT2_WITNESS_TYPES["PermitWitnessTransferFrom"]
        ]
        assert names == ["permitted", "spender", "nonce", "deadline", "witness"]
        witness = C.BATCH_PERMIT2_WITNESS_TYPES["PermitWitnessTransferFrom"][-1]
        assert witness["type"] == "DepositWitness"

    def test_witness_is_channel_id(self):
        encoded = _eip712_type_string(
            "DepositWitness", C.BATCH_PERMIT2_WITNESS_TYPES["DepositWitness"]
        )
        assert encoded == "DepositWitness(bytes32 channelId)"

    def test_token_permissions_shape(self):
        encoded = _eip712_type_string(
            "TokenPermissions",
            C.BATCH_PERMIT2_WITNESS_TYPES["TokenPermissions"],
        )
        assert encoded == "TokenPermissions(address token,uint256 amount)"


class TestPayloadTypeDiscriminators:
    def test_unique_values(self):
        values = {
            C.PAYLOAD_TYPE_DEPOSIT,
            C.PAYLOAD_TYPE_VOUCHER,
            C.PAYLOAD_TYPE_REFUND,
            C.PAYLOAD_TYPE_CLAIM,
            C.PAYLOAD_TYPE_SETTLE,
        }
        assert len(values) == 5


class TestErrorCodes:
    """Pin the canonical wire prefix for every error code."""

    WIRE_PREFIX = "invalid_batch_settlement_evm_"

    def test_all_err_constants_share_prefix(self):
        for name in dir(E):
            if not name.startswith("ERR_"):
                continue
            value = getattr(E, name)
            assert isinstance(value, str), name
            assert value.startswith(self.WIRE_PREFIX), (name, value)

    @pytest.mark.parametrize(
        "code",
        [
            E.ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
            E.ERR_CUMULATIVE_AMOUNT_MISMATCH,
            E.ERR_CHANNEL_BUSY,
            E.ERR_MISSING_CHANNEL,
            E.ERR_CHARGE_EXCEEDS_SIGNED_CUMULATIVE,
            E.ERR_REFUND_NO_BALANCE,
            E.ERR_REFUND_AMOUNT_INVALID,
            E.ERR_DEPOSIT_BELOW_MIN_DEPOSIT,
        ],
    )
    def test_documented_codes_present(self, code: str):
        assert code.startswith(self.WIRE_PREFIX)
