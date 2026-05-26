"""Unit tests for batch-settlement constants.

Mirrors go/mechanisms/evm/batch-settlement/constants_test.go.

The wire prefix and EIP-712 type strings are part of the cross-SDK contract;
renaming any of them silently breaks compatibility with the TS and Go SDKs
and with cdp-facilitator's substring-based error classifier.
"""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement import constants as C  # noqa: N812
    from x402.mechanisms.evm.batch_settlement import errors as E  # noqa: N812
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


class TestSchemeIdentifier:
    def test_scheme_identifier_matches_wire(self):
        assert C.SCHEME_BATCH_SETTLEMENT == "batch-settlement"


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
        # Checksum addresses contain at least one uppercase letter for any
        # address that has both letters and digits; here we just verify the
        # format and that to_checksum_address normalised it.
        from eth_utils import to_checksum_address

        assert address == to_checksum_address(address)


class TestWithdrawDelayBounds:
    def test_min_delay(self):
        assert C.MIN_WITHDRAW_DELAY == 900

    def test_max_delay(self):
        assert C.MAX_WITHDRAW_DELAY == 2_592_000

    def test_min_lt_max(self):
        assert C.MIN_WITHDRAW_DELAY < C.MAX_WITHDRAW_DELAY


class TestEip712Domain:
    def test_domain_name_and_version(self):
        assert C.BATCH_SETTLEMENT_DOMAIN_NAME == "x402 Batch Settlement"
        assert C.BATCH_SETTLEMENT_DOMAIN_VERSION == "1"


class TestChannelConfigType:
    def test_type_string_matches_solidity(self):
        # The struct order is part of the EIP-712 hash; any change breaks
        # channelId computation across SDKs.
        assert C.CHANNEL_CONFIG_TYPE_STRING == (
            "ChannelConfig(address payer,address payerAuthorizer,"
            "address receiver,address receiverAuthorizer,address token,"
            "uint40 withdrawDelay,bytes32 salt)"
        )

    def test_typehash_is_keccak_of_type_string(self):
        from eth_utils import keccak

        assert C.CHANNEL_CONFIG_TYPEHASH == keccak(text=C.CHANNEL_CONFIG_TYPE_STRING)

    def test_types_dict_shape(self):
        fields = C.CHANNEL_CONFIG_TYPES["ChannelConfig"]
        assert [f["name"] for f in fields] == [
            "payer",
            "payerAuthorizer",
            "receiver",
            "receiverAuthorizer",
            "token",
            "withdrawDelay",
            "salt",
        ]


class TestVoucherTypes:
    def test_shape(self):
        v = C.VOUCHER_TYPES["Voucher"]
        assert len(v) == 2
        assert v[0] == {"name": "channelId", "type": "bytes32"}
        assert v[1] == {"name": "maxClaimableAmount", "type": "uint128"}


class TestRefundTypes:
    def test_shape(self):
        r = C.REFUND_TYPES["Refund"]
        assert len(r) == 3
        assert [(f["name"], f["type"]) for f in r] == [
            ("channelId", "bytes32"),
            ("nonce", "uint256"),
            ("amount", "uint128"),
        ]


class TestClaimBatchTypes:
    def test_batch_wraps_array(self):
        cb = C.CLAIM_BATCH_TYPES["ClaimBatch"]
        assert len(cb) == 1
        assert cb[0]["type"] == "ClaimEntry[]"

    def test_entry_has_three_fields(self):
        ce = C.CLAIM_BATCH_TYPES["ClaimEntry"]
        assert [(f["name"], f["type"]) for f in ce] == [
            ("channelId", "bytes32"),
            ("maxClaimableAmount", "uint128"),
            ("totalClaimed", "uint128"),
        ]


class TestReceiveAuthorizationTypes:
    def test_shape(self):
        r = C.RECEIVE_AUTHORIZATION_TYPES["ReceiveWithAuthorization"]
        assert len(r) == 6
        assert [f["name"] for f in r] == [
            "from",
            "to",
            "value",
            "validAfter",
            "validBefore",
            "nonce",
        ]


class TestPermit2WitnessTypes:
    def test_top_level_struct(self):
        p = C.BATCH_PERMIT2_WITNESS_TYPES["PermitWitnessTransferFrom"]
        assert [f["name"] for f in p] == [
            "permitted",
            "spender",
            "nonce",
            "deadline",
            "witness",
        ]

    def test_witness_is_channel_id(self):
        w = C.BATCH_PERMIT2_WITNESS_TYPES["DepositWitness"]
        assert w == [{"name": "channelId", "type": "bytes32"}]

    def test_token_permissions_shape(self):
        tp = C.BATCH_PERMIT2_WITNESS_TYPES["TokenPermissions"]
        assert tp == [
            {"name": "token", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ]


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

    def test_values_match_wire(self):
        assert C.PAYLOAD_TYPE_DEPOSIT == "deposit"
        assert C.PAYLOAD_TYPE_VOUCHER == "voucher"
        assert C.PAYLOAD_TYPE_REFUND == "refund"
        assert C.PAYLOAD_TYPE_CLAIM == "claim"
        assert C.PAYLOAD_TYPE_SETTLE == "settle"


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
        ],
    )
    def test_documented_codes_present(self, code: str):
        assert code.startswith(self.WIRE_PREFIX)


class TestDefaultIntervals:
    def test_claim_interval(self):
        assert C.DEFAULT_CLAIM_INTERVAL_SECS == 60

    def test_settle_interval(self):
        assert C.DEFAULT_SETTLE_INTERVAL_SECS == 120

    def test_refund_interval(self):
        assert C.DEFAULT_REFUND_INTERVAL_SECS == 180

    def test_max_claims_per_batch(self):
        assert C.DEFAULT_MAX_CLAIMS_PER_BATCH == 100

    def test_onchain_state_ttl_ms(self):
        assert C.DEFAULT_ONCHAIN_STATE_TTL_MS == 60_000
