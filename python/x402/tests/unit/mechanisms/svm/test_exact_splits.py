"""Tests for multi-payee splits in the exact SVM scheme (scheme_exact_svm.md §5)."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import MessageV0, MessageV1
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm import (
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    ERR_AMOUNT_MISMATCH,
    ERR_FEE_PAYER_TRANSFERRING,
    ERR_INVALID_INSTRUCTION_COUNT,
    ERR_MEMO_MISMATCH,
    ERR_NO_TRANSFER_INSTRUCTION,
    ERR_RECIPIENT_MISMATCH,
    ERR_SIMULATION_FAILED,
    ERR_SPLIT_ATA_CREATION_NOT_AUTHORIZED,
    ERR_SPLIT_AUTHORITY_MISMATCH,
    ERR_SPLIT_COUNT_EXCEEDED,
    ERR_SPLIT_LEG_UNMATCHED,
    ERR_SPLIT_REMAINDER_NOT_POSITIVE,
    ERR_SPLITS_INVALID,
    ERR_UNKNOWN_OPTIONAL_INSTRUCTION,
    MEMO_PROGRAM_ADDRESS,
    SOLANA_DEVNET_CAIP2,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
)
from x402.mechanisms.svm.constants import (
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    ERR_FEE_PAYER_NOT_ISOLATED,
    SYSTEM_PROGRAM_ADDRESS,
)
from x402.mechanisms.svm.exact import (
    ExactSvmClientScheme,
    ExactSvmFacilitatorScheme,
    ExactSvmServerScheme,
)
from x402.mechanisms.svm.exact.splits import (
    SplitCapabilities,
    SplitsError,
    get_split_capabilities,
    parse_payment_legs,
    uses_split_terms,
)
from x402.mechanisms.svm.signers import KeypairSigner
from x402.mechanisms.svm.utils import derive_ata
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo, SupportedKind

BLOCKHASH = "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k"


@dataclass
class Parties:
    payer: Keypair
    fee_payer: Keypair
    merchant: Keypair
    platform: Keypair
    referrer: Keypair


@pytest.fixture
def p() -> Parties:
    return Parties(*(Keypair() for _ in range(5)))


def addr(kp: Keypair) -> str:
    return str(kp.pubkey())


def requirements(p: Parties, **extra: Any) -> PaymentRequirements:
    base: dict[str, Any] = {
        "feePayer": addr(p.fee_payer),
        "recentBlockhash": BLOCKHASH,
        "splits": [
            {"payTo": addr(p.platform), "amount": "40000", "memo": "platform fee"},
            {"payTo": addr(p.referrer), "amount": "10000", "memo": "referral"},
        ],
    }
    base.update(extra)
    return PaymentRequirements(
        scheme="exact",
        network=SOLANA_DEVNET_CAIP2,
        asset=USDC_DEVNET_ADDRESS,
        amount="1050000",
        pay_to=addr(p.merchant),
        max_timeout_seconds=60,
        extra=base,
    )


def payment(req: PaymentRequirements, transaction: str) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(url="https://example.com", description="", mime_type="text/plain"),
        accepted=req,
        payload={"transaction": transaction},
    )


def ata(owner: str | Keypair, program: str = TOKEN_PROGRAM_ADDRESS) -> str:
    owner_str = addr(owner) if isinstance(owner, Keypair) else owner
    return derive_ata(owner_str, USDC_DEVNET_ADDRESS, program)


class MockRpc:
    """RPC stub: the USDC mint, plus a configurable set of existing accounts."""

    def __init__(self, existing: set[str] | None = None, fail_lookups: bool = False):
        self.existing = existing or set()
        self.fail_lookups = fail_lookups

    def get_account_info(self, pubkey: Pubkey) -> Any:
        response = MagicMock()
        if str(pubkey) == USDC_DEVNET_ADDRESS:
            response.value.owner = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
            response.value.data = bytes(44) + bytes([6]) + bytes(37)
            return response
        if self.fail_lookups:
            raise ConnectionError("rpc down")
        response.value = MagicMock() if str(pubkey) in self.existing else None
        return response


def client_payload(
    p: Parties,
    req: PaymentRequirements,
    approve: Any = lambda splits, ctx: True,
    rpc: MockRpc | None = None,
) -> str:
    client = ExactSvmClientScheme(KeypairSigner(p.payer), approve_splits=approve)
    with patch.object(client, "_get_client", return_value=rpc or MockRpc()):
        return client.create_payment_payload(req)["transaction"]


def decoded_instructions(tx_base64: str) -> list[tuple[str, list[str], bytes]]:
    tx = VersionedTransaction.from_bytes(base64.b64decode(tx_base64))
    keys = [str(k) for k in tx.message.account_keys]
    return [
        (keys[ix.program_id_index], [keys[i] for i in ix.accounts], bytes(ix.data))
        for ix in tx.message.instructions
    ]


def transfer(
    p: Parties,
    owner: str | Keypair,
    amount: int,
    *,
    program: str = TOKEN_PROGRAM_ADDRESS,
    authority: Keypair | None = None,
    extra_accounts: list[AccountMeta] | None = None,
) -> Instruction:
    authority = authority or p.payer
    source = derive_ata(addr(authority), USDC_DEVNET_ADDRESS, program)
    return Instruction(
        program_id=Pubkey.from_string(program),
        accounts=[
            AccountMeta(Pubkey.from_string(source), is_signer=False, is_writable=True),
            AccountMeta(
                Pubkey.from_string(USDC_DEVNET_ADDRESS), is_signer=False, is_writable=False
            ),
            AccountMeta(Pubkey.from_string(ata(owner, program)), is_signer=False, is_writable=True),
            AccountMeta(authority.pubkey(), is_signer=True, is_writable=False),
            *(extra_accounts or []),
        ],
        data=bytes([12]) + amount.to_bytes(8, "little") + bytes([6]),
    )


def create_ata(payer: Keypair, owner: Keypair, program: str = TOKEN_PROGRAM_ADDRESS) -> Instruction:
    return Instruction(
        program_id=Pubkey.from_string(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
        accounts=[
            AccountMeta(payer.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(Pubkey.from_string(ata(owner, program)), is_signer=False, is_writable=True),
            AccountMeta(owner.pubkey(), is_signer=False, is_writable=False),
            AccountMeta(
                Pubkey.from_string(USDC_DEVNET_ADDRESS), is_signer=False, is_writable=False
            ),
            AccountMeta(
                Pubkey.from_string(SYSTEM_PROGRAM_ADDRESS), is_signer=False, is_writable=False
            ),
            AccountMeta(Pubkey.from_string(program), is_signer=False, is_writable=False),
        ],
        data=bytes([1]),
    )


def memo(text: str, accounts: list[AccountMeta] | None = None) -> Instruction:
    return Instruction(
        program_id=Pubkey.from_string(MEMO_PROGRAM_ADDRESS),
        accounts=accounts or [],
        data=text.encode("utf-8"),
    )


def build_transaction(
    p: Parties, instructions: list[Instruction], signers: list[Keypair] | None = None
) -> str:
    """Compile and sign a v0 transaction; the fee payer slot stays unsigned."""
    compute_budget = Pubkey.from_string(COMPUTE_BUDGET_PROGRAM_ADDRESS)
    message = MessageV0.try_compile(
        payer=p.fee_payer.pubkey(),
        instructions=[
            Instruction(compute_budget, bytes([2]) + (60_000).to_bytes(4, "little"), []),
            Instruction(compute_budget, bytes([3]) + (1).to_bytes(8, "little"), []),
            *instructions,
        ],
        address_lookup_table_accounts=[],
        recent_blockhash=Hash.from_string(BLOCKHASH),
    )
    signers = signers or [p.payer]
    by_key = {kp.pubkey(): kp for kp in signers}
    message_bytes = bytes([0x80]) + bytes(message)
    signatures = [
        by_key[key].sign_message(message_bytes) if key in by_key else Signature.default()
        for key in message.account_keys[: message.header.num_required_signatures]
    ]
    return base64.b64encode(bytes(VersionedTransaction.populate(message, signatures))).decode()


def standard_legs(p: Parties) -> list[Instruction]:
    return [
        transfer(p, p.merchant, 1_000_000),
        transfer(p, p.platform, 40_000),
        transfer(p, p.referrer, 10_000),
    ]


class MockFacilitatorSigner:
    def __init__(self, fee_payer: str, simulate_error: Exception | None = None):
        self._addresses = [fee_payer]
        self._simulate_error = simulate_error
        self.sent: list[str] = []

    def get_addresses(self) -> list[str]:
        return self._addresses

    def sign_transaction(self, tx_base64: str, fee_payer: str, network: str) -> str:
        return tx_base64

    def simulate_transaction(self, tx_base64: str, network: str) -> None:
        if self._simulate_error:
            raise self._simulate_error

    def send_transaction(self, tx_base64: str, network: str) -> str:
        self.sent.append(tx_base64)
        return "sig"

    def confirm_transaction(self, signature: str, network: str) -> None:
        pass


def facilitator(p: Parties, **options: Any) -> ExactSvmFacilitatorScheme:
    return ExactSvmFacilitatorScheme(MockFacilitatorSigner(addr(p.fee_payer)), **options)


# ---------------------------------------------------------------------------
# Requirements parsing
# ---------------------------------------------------------------------------


class TestParsePaymentLegs:
    def test_puts_the_remainder_on_the_primary_leg_then_splits_in_order(self, p):
        legs = parse_payment_legs(requirements(p))
        assert [(leg.owner, leg.amount, leg.is_primary) for leg in legs] == [
            (addr(p.merchant), 1_000_000, True),
            (addr(p.platform), 40_000, False),
            (addr(p.referrer), 10_000, False),
        ]

    @pytest.mark.parametrize(
        "override",
        [
            {"amount": "040000"},
            {"amount": "0"},
            {"amount": "-1"},
            {"amount": "1.5"},
            {"amount": "1e3"},
            {"amount": 40000},
            {"amount": "18446744073709551616"},
            {"payTo": "not-an-address"},
            {"payTo": "z" * 44},  # base58, but not 32 bytes
            {"payTo": None},
            {"memo": "x" * 567},
            {"memo": "é" * 284},  # 568 UTF-8 bytes
            {"memo": 5},
            {"ataCreationRequired": "yes"},
            {"ataCreationRequired": 1},
        ],
    )
    def test_rejects_an_invalid_split(self, p, override):
        req = requirements(p)
        req.extra["splits"][0] = {**req.extra["splits"][0], **override}
        with pytest.raises(SplitsError) as exc:
            parse_payment_legs(req)
        assert exc.value.reason == ERR_SPLITS_INVALID

    def test_accepts_a_memo_of_exactly_566_bytes_and_u64_max(self, p):
        req = requirements(
            p,
            splits=[{"payTo": addr(p.platform), "amount": "1", "memo": "x" * 566}],
        )
        req.amount = str((1 << 64) - 1)
        legs = parse_payment_legs(req)
        assert legs[0].amount == (1 << 64) - 2

    @pytest.mark.parametrize(
        "extra",
        [
            {"splits": "nope"},
            {"splits": ["nope"]},
            {"ataCreationRequired": 1},
            {"ataCreationRequired": "true"},
        ],
    )
    def test_rejects_malformed_top_level_terms(self, p, extra):
        with pytest.raises(SplitsError) as exc:
            parse_payment_legs(requirements(p, **extra))
        assert exc.value.reason == ERR_SPLITS_INVALID

    def test_rejects_a_split_paying_the_primary_or_another_split(self, p):
        to_primary = requirements(p, splits=[{"payTo": addr(p.merchant), "amount": "1"}])
        duplicate = requirements(
            p,
            splits=[
                {"payTo": addr(p.platform), "amount": "1"},
                {"payTo": addr(p.platform), "amount": "2"},
            ],
        )
        for req in (to_primary, duplicate):
            with pytest.raises(SplitsError) as exc:
                parse_payment_legs(req)
            assert exc.value.reason == ERR_SPLITS_INVALID

    def test_rejects_splits_that_consume_the_whole_amount(self, p):
        req = requirements(p, splits=[{"payTo": addr(p.platform), "amount": "1050000"}])
        with pytest.raises(SplitsError) as exc:
            parse_payment_legs(req)
        assert exc.value.reason == ERR_SPLIT_REMAINDER_NOT_POSITIVE

    def test_rejects_more_than_eight_splits(self, p):
        req = requirements(p, splits=[{"payTo": addr(Keypair()), "amount": "1"} for _ in range(9)])
        with pytest.raises(SplitsError) as exc:
            parse_payment_legs(req)
        assert exc.value.reason == ERR_SPLITS_INVALID

    def test_uses_split_terms(self, p):
        assert uses_split_terms(requirements(p))
        assert not uses_split_terms(requirements(p, splits=[]))
        assert not uses_split_terms(requirements(p, splits=None))
        assert uses_split_terms(requirements(p, splits=[], ataCreationRequired=True))
        # Only the boolean True marks the primary; 1 is not a bool here.
        assert not uses_split_terms(requirements(p, splits=[], ataCreationRequired=1))


class TestGetSplitCapabilities:
    def test_fails_closed_when_the_keys_are_absent_or_malformed(self):
        assert get_split_capabilities(None) == SplitCapabilities(0, False)
        assert get_split_capabilities({}) == SplitCapabilities(0, False)
        assert get_split_capabilities(
            {"maxSplits": "8", "ataCreationSponsored": "true"}
        ) == SplitCapabilities(0, False)
        assert get_split_capabilities(
            {"maxSplits": True, "ataCreationSponsored": 1}
        ) == SplitCapabilities(0, False)
        assert get_split_capabilities({"maxSplits": 3.0}) == SplitCapabilities(0, False)
        assert get_split_capabilities({"maxSplits": -1}) == SplitCapabilities(0, False)

    def test_reads_advertised_capabilities(self):
        assert get_split_capabilities(
            {"maxSplits": 3, "ataCreationSponsored": True}
        ) == SplitCapabilities(3, True)
        assert get_split_capabilities({"maxSplits": 20}) == SplitCapabilities(8, False)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class TestClientWithSplits:
    def test_refuses_splits_without_a_hook_or_when_it_declines(self, p):
        with pytest.raises(ValueError, match="approve_splits"):
            client_payload(p, requirements(p), approve=None)
        with pytest.raises(ValueError, match="not approved"):
            client_payload(p, requirements(p), approve=lambda splits, ctx: False)

    def test_passes_the_splits_and_the_primary_remainder_to_the_hook(self, p):
        calls: list[tuple[Any, Any]] = []

        def approve(splits, ctx):
            calls.append((splits, ctx))
            return True

        req = requirements(p)
        client_payload(p, req, approve=approve)
        assert len(calls) == 1
        splits, ctx = calls[0]
        assert splits == [
            {"payTo": addr(p.platform), "amount": "40000", "memo": "platform fee"},
            {"payTo": addr(p.referrer), "amount": "10000", "memo": "referral"},
        ]
        assert ctx["payTo"] == addr(p.merchant)
        assert ctx["primaryAmount"] == "1000000"
        assert ctx["requirements"] is req

    def test_builds_compute_budget_one_transfer_per_leg_in_order_then_the_memo(self, p):
        ixs = decoded_instructions(client_payload(p, requirements(p)))
        assert [program for program, _, _ in ixs] == [
            COMPUTE_BUDGET_PROGRAM_ADDRESS,
            COMPUTE_BUDGET_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
            MEMO_PROGRAM_ADDRESS,
        ]
        assert [accounts[2] for _, accounts, _ in ixs[2:5]] == [
            ata(p.merchant),
            ata(p.platform),
            ata(p.referrer),
        ]
        assert [int.from_bytes(data[1:9], "little") for _, _, data in ixs[2:5]] == [
            1_000_000,
            40_000,
            10_000,
        ]
        # 20_000 + 2 extra transfers * 15_000
        assert int.from_bytes(ixs[0][2][1:5], "little") == 50_000

    def test_adds_a_fee_payer_funded_create_only_for_marked_recipients_without_an_ata(self, p):
        req = requirements(
            p,
            ataCreationRequired=True,
            splits=[
                {"payTo": addr(p.platform), "amount": "40000", "ataCreationRequired": True},
                {"payTo": addr(p.referrer), "amount": "10000"},
            ],
        )
        tx = client_payload(p, req, rpc=MockRpc(existing={ata(p.merchant)}))
        ixs = decoded_instructions(tx)
        creates = [ix for ix in ixs if ix[0] == ASSOCIATED_TOKEN_PROGRAM_ADDRESS]
        assert len(creates) == 1
        _, accounts, data = creates[0]
        assert data == bytes([1])
        assert accounts == [
            addr(p.fee_payer),
            ata(p.platform),
            addr(p.platform),
            USDC_DEVNET_ADDRESS,
            SYSTEM_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
        ]
        assert ixs[2][0] == ASSOCIATED_TOKEN_PROGRAM_ADDRESS
        # 20_000 + 2 * 15_000 + 1 * 40_000
        assert int.from_bytes(ixs[0][2][1:5], "little") == 90_000

    def test_includes_the_create_when_the_ata_lookup_fails(self, p):
        req = requirements(p, splits=[], ataCreationRequired=True)
        ixs = decoded_instructions(
            client_payload(p, req, approve=None, rpc=MockRpc(fail_lookups=True))
        )
        assert [program for program, _, _ in ixs][2:4] == [
            ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
        ]

    def test_builds_a_single_payee_transfer_unchanged_without_splits(self, p):
        req = requirements(p, splits=[])
        ixs = decoded_instructions(client_payload(p, req, approve=None))
        assert len(ixs) == 4
        assert ixs[2][1][2] == ata(p.merchant)
        assert int.from_bytes(ixs[2][2][1:9], "little") == 1_050_000
        assert int.from_bytes(ixs[0][2][1:5], "little") == 20_000

    def test_rejects_invalid_splits_before_signing(self, p):
        req = requirements(p, splits=[{"payTo": addr(p.platform), "amount": "0"}])
        with pytest.raises(SplitsError):
            client_payload(p, req)


# ---------------------------------------------------------------------------
# Facilitator (Path 1)
# ---------------------------------------------------------------------------


class TestFacilitatorWithSplits:
    def test_advertises_split_capabilities_only_when_configured(self, p):
        assert facilitator(p).get_extra(SOLANA_DEVNET_CAIP2) == {
            "feePayer": addr(p.fee_payer),
            "transactionVersions": [0, 1],
        }
        assert facilitator(p, max_splits=8, ata_creation_sponsored=True).get_extra(
            SOLANA_DEVNET_CAIP2
        ) == {
            "feePayer": addr(p.fee_payer),
            "transactionVersions": [0, 1],
            "maxSplits": 8,
            "ataCreationSponsored": True,
        }

    @pytest.mark.parametrize("max_splits", [9, -1, True, 2.0, "2"])
    def test_rejects_an_out_of_range_max_splits(self, p, max_splits):
        with pytest.raises(ValueError, match="max_splits"):
            facilitator(p, max_splits=max_splits)

    def test_accepts_a_client_built_split_charge(self, p):
        req = requirements(p)
        result = facilitator(p, max_splits=2).verify(payment(req, client_payload(p, req)), req)
        assert result.is_valid, result.invalid_reason
        assert result.payer == addr(p.payer)

    def test_accepts_sponsored_ata_creation_including_the_primary(self, p):
        req = requirements(
            p,
            ataCreationRequired=True,
            splits=[{"payTo": addr(p.platform), "amount": "40000", "ataCreationRequired": True}],
        )
        tx = client_payload(p, req)
        assert (
            sum(ix[0] == ASSOCIATED_TOKEN_PROGRAM_ADDRESS for ix in decoded_instructions(tx)) == 2
        )
        result = facilitator(p, max_splits=1, ata_creation_sponsored=True).verify(
            payment(req, tx), req
        )
        assert result.is_valid, result.invalid_reason

    def test_accepts_a_version_1_charge_with_sponsored_ata_creation(self, p):
        req = requirements(
            p,
            transactionVersions=[0, 1],
            splits=[
                {"payTo": addr(p.platform), "amount": "40000", "ataCreationRequired": True},
                {"payTo": addr(p.referrer), "amount": "10000"},
            ],
        )
        tx = client_payload(p, req)
        assert isinstance(VersionedTransaction.from_bytes(base64.b64decode(tx)).message, MessageV1)
        # Version 1 has no ComputeBudget prefix: one creation, three transfers, memo.
        assert [ix[0] for ix in decoded_instructions(tx)] == [
            ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
            TOKEN_PROGRAM_ADDRESS,
            MEMO_PROGRAM_ADDRESS,
        ]
        result = facilitator(p, max_splits=2, ata_creation_sponsored=True).verify(
            payment(req, tx), req
        )
        assert result.is_valid, result.invalid_reason

    def test_accepts_a_create_for_the_fee_payer_as_recipient(self, p):
        req = requirements(
            p,
            splits=[{"payTo": addr(p.fee_payer), "amount": "40000", "ataCreationRequired": True}],
        )
        result = facilitator(p, max_splits=1, ata_creation_sponsored=True).verify(
            payment(req, client_payload(p, req)), req
        )
        assert result.is_valid, result.invalid_reason

    def test_rejects_splits_beyond_max_splits_and_unadvertised_sponsorship(self, p):
        req = requirements(p)
        tx = client_payload(p, req)
        result = facilitator(p).verify(payment(req, tx), req)
        assert result.invalid_reason == ERR_SPLIT_COUNT_EXCEEDED
        result = facilitator(p, max_splits=1).verify(payment(req, tx), req)
        assert result.invalid_reason == ERR_SPLIT_COUNT_EXCEEDED

        marked = requirements(p, ataCreationRequired=True)
        result = facilitator(p, max_splits=8).verify(
            payment(marked, client_payload(p, marked)), marked
        )
        assert result.invalid_reason == ERR_SPLIT_ATA_CREATION_NOT_AUTHORIZED

    def test_rejects_invalid_split_terms_before_decoding(self, p):
        req = requirements(p, splits=[{"payTo": addr(p.platform), "amount": "1050000"}])
        result = facilitator(p, max_splits=8).verify(payment(req, "not-a-tx"), req)
        assert result.invalid_reason == ERR_SPLIT_REMAINDER_NOT_POSITIVE

    def test_rejects_a_creation_for_a_recipient_the_requirements_did_not_mark(self, p):
        marked = requirements(p, ataCreationRequired=True)
        tx = client_payload(p, marked)
        unmarked = requirements(p)
        result = facilitator(p, max_splits=8, ata_creation_sponsored=True).verify(
            payment(unmarked, tx), unmarked
        )
        assert result.invalid_reason == ERR_SPLIT_ATA_CREATION_NOT_AUTHORIZED

    def test_rejects_a_client_funded_creation(self, p):
        req = requirements(p, ataCreationRequired=True)
        tx = build_transaction(
            p, [create_ata(p.payer, p.merchant), *standard_legs(p), memo("nonce")]
        )
        result = facilitator(p, max_splits=8, ata_creation_sponsored=True).verify(
            payment(req, tx), req
        )
        assert result.invalid_reason == ERR_SPLIT_ATA_CREATION_NOT_AUTHORIZED

    def test_rejects_a_duplicate_creation_for_the_same_owner(self, p):
        req = requirements(p, ataCreationRequired=True)
        create = create_ata(p.fee_payer, p.merchant)
        tx = build_transaction(p, [create, create, *standard_legs(p), memo("nonce")])
        result = facilitator(p, max_splits=8, ata_creation_sponsored=True).verify(
            payment(req, tx), req
        )
        assert result.invalid_reason == ERR_SPLIT_ATA_CREATION_NOT_AUTHORIZED

    def test_rejects_legs_out_of_order_or_with_a_wrong_carve_out(self, p):
        req = requirements(p)
        scheme = facilitator(p, max_splits=8)
        swapped = build_transaction(
            p,
            [
                transfer(p, p.merchant, 1_000_000),
                transfer(p, p.referrer, 10_000),
                transfer(p, p.platform, 40_000),
                memo("nonce"),
            ],
        )
        assert scheme.verify(payment(req, swapped), req).invalid_reason == ERR_RECIPIENT_MISMATCH
        short_split = build_transaction(
            p,
            [
                transfer(p, p.merchant, 1_010_000),
                transfer(p, p.platform, 30_000),
                transfer(p, p.referrer, 10_000),
                memo("nonce"),
            ],
        )
        assert scheme.verify(payment(req, short_split), req).invalid_reason == ERR_AMOUNT_MISMATCH
        overpaid_primary = build_transaction(
            p,
            [
                transfer(p, p.merchant, 1_000_001),
                transfer(p, p.platform, 40_000),
                transfer(p, p.referrer, 10_000),
                memo("nonce"),
            ],
        )
        assert (
            scheme.verify(payment(req, overpaid_primary), req).invalid_reason == ERR_AMOUNT_MISMATCH
        )

    def test_rejects_a_missing_leg_or_too_many_trailing_instructions(self, p):
        req = requirements(p)
        scheme = facilitator(p, max_splits=8)
        missing = build_transaction(
            p, [transfer(p, p.merchant, 1_000_000), transfer(p, p.platform, 40_000)]
        )
        assert (
            scheme.verify(payment(req, missing), req).invalid_reason
            == ERR_INVALID_INSTRUCTION_COUNT
        )
        too_many = build_transaction(p, [*standard_legs(p), *(memo(str(i)) for i in range(5))])
        assert (
            scheme.verify(payment(req, too_many), req).invalid_reason
            == ERR_INVALID_INSTRUCTION_COUNT
        )
        four = build_transaction(p, [*standard_legs(p), *(memo(str(i)) for i in range(4))])
        assert scheme.verify(payment(req, four), req).is_valid

    def test_rejects_an_unknown_optional_instruction(self, p):
        req = requirements(p)
        stranger = Instruction(Pubkey.from_string(SYSTEM_PROGRAM_ADDRESS), b"\x00", [])
        tx = build_transaction(p, [*standard_legs(p), stranger])
        result = facilitator(p, max_splits=8).verify(payment(req, tx), req)
        assert result.invalid_reason == ERR_UNKNOWN_OPTIONAL_INSTRUCTION

    def test_fits_and_verifies_eight_splits_and_refuses_a_charge_over_the_size_limit(self, p):
        recipients = [Keypair() for _ in range(8)]
        eight = requirements(p, splits=[{"payTo": addr(r), "amount": "1000"} for r in recipients])
        tx = client_payload(p, eight)
        result = facilitator(p, max_splits=8, ata_creation_sponsored=True).verify(
            payment(eight, tx), eight
        )
        assert result.is_valid, result.invalid_reason

        with_creates = requirements(
            p,
            ataCreationRequired=True,
            splits=[
                {"payTo": addr(r), "amount": "1000", "ataCreationRequired": True}
                for r in recipients
            ],
        )
        with pytest.raises(ValueError, match="1232-byte limit"):
            client_payload(p, with_creates)

    def test_rejects_a_create_under_a_different_token_program_than_the_transfers(self, p):
        req = requirements(p, ataCreationRequired=True)
        tx = build_transaction(
            p,
            [
                create_ata(p.fee_payer, p.merchant, TOKEN_2022_PROGRAM_ADDRESS),
                *standard_legs(p),
                memo("nonce"),
            ],
        )
        result = facilitator(p, max_splits=8, ata_creation_sponsored=True).verify(
            payment(req, tx), req
        )
        assert result.invalid_reason == ERR_SPLIT_ATA_CREATION_NOT_AUTHORIZED

    def test_rejects_legs_under_different_token_programs(self, p):
        req = requirements(p)
        tx = build_transaction(
            p,
            [
                transfer(p, p.merchant, 1_000_000),
                transfer(p, p.platform, 40_000, program=TOKEN_2022_PROGRAM_ADDRESS),
                transfer(p, p.referrer, 10_000),
            ],
        )
        result = facilitator(p, max_splits=8).verify(payment(req, tx), req)
        assert result.invalid_reason == ERR_SPLIT_LEG_UNMATCHED

    def test_rejects_a_split_transfer_with_trailing_multisig_signer_accounts(self, p):
        req = requirements(p)
        extra_signer = Keypair()
        tx = build_transaction(
            p,
            [
                transfer(p, p.merchant, 1_000_000),
                transfer(
                    p,
                    p.platform,
                    40_000,
                    extra_accounts=[
                        AccountMeta(extra_signer.pubkey(), is_signer=True, is_writable=False)
                    ],
                ),
                transfer(p, p.referrer, 10_000),
                memo("nonce"),
            ],
            signers=[p.payer, extra_signer],
        )
        result = facilitator(p, max_splits=8).verify(payment(req, tx), req)
        assert result.invalid_reason == ERR_NO_TRANSFER_INSTRUCTION

    def test_rejects_legs_signed_by_different_authorities(self, p):
        req = requirements(p)
        other = Keypair()
        tx = build_transaction(
            p,
            [
                transfer(p, p.merchant, 1_000_000),
                transfer(p, p.platform, 40_000, authority=other),
                transfer(p, p.referrer, 10_000),
            ],
            signers=[p.payer, other],
        )
        result = facilitator(p, max_splits=8).verify(payment(req, tx), req)
        assert result.invalid_reason == ERR_SPLIT_AUTHORITY_MISMATCH

    def test_rejects_a_leg_paid_by_the_fee_payer(self, p):
        req = requirements(p)
        tx = build_transaction(
            p,
            [
                transfer(p, p.merchant, 1_000_000, authority=p.fee_payer),
                transfer(p, p.platform, 40_000, authority=p.fee_payer),
                transfer(p, p.referrer, 10_000, authority=p.fee_payer),
            ],
            signers=[p.fee_payer],
        )
        result = facilitator(p, max_splits=8).verify(payment(req, tx), req)
        assert result.invalid_reason == ERR_FEE_PAYER_TRANSFERRING

    def test_rejects_the_fee_payer_in_another_instruction(self, p):
        req = requirements(p)
        tx = build_transaction(
            p,
            [
                *standard_legs(p),
                memo(
                    "nonce",
                    [AccountMeta(p.fee_payer.pubkey(), is_signer=True, is_writable=False)],
                ),
            ],
        )
        result = facilitator(p, max_splits=8).verify(payment(req, tx), req)
        assert result.invalid_reason == ERR_FEE_PAYER_NOT_ISOLATED

    def test_checks_the_on_chain_memo_against_extra_memo(self, p):
        req = requirements(p, memo="order-1")
        scheme = facilitator(p, max_splits=8)
        assert scheme.verify(payment(req, client_payload(p, req)), req).is_valid
        wrong = build_transaction(p, [*standard_legs(p), memo("order-2")])
        assert scheme.verify(payment(req, wrong), req).invalid_reason == ERR_MEMO_MISMATCH

    def test_reports_a_failed_simulation(self, p):
        req = requirements(p)
        scheme = ExactSvmFacilitatorScheme(
            MockFacilitatorSigner(addr(p.fee_payer), RuntimeError("insufficient funds")),
            max_splits=8,
        )
        result = scheme.verify(payment(req, client_payload(p, req)), req)
        assert result.invalid_reason == ERR_SIMULATION_FAILED
        assert "insufficient funds" in (result.invalid_message or "")

    def test_settles_a_split_charge(self, p):
        req = requirements(p)
        signer = MockFacilitatorSigner(addr(p.fee_payer))
        scheme = ExactSvmFacilitatorScheme(signer, max_splits=2)
        result = scheme.settle(payment(req, client_payload(p, req)), req)
        assert result.success, result.error_reason
        assert result.payer == addr(p.payer)
        assert len(signer.sent) == 1


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------


class TestServerWithSplits:
    @staticmethod
    def kind(p: Parties, **extra: Any) -> SupportedKind:
        return SupportedKind(
            x402_version=2,
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            extra={"feePayer": addr(p.fee_payer), **extra},
        )

    def test_refuses_requirements_the_facilitator_does_not_advertise(self, p):
        server = ExactSvmServerScheme()
        with pytest.raises(SplitsError) as exc:
            server.enhance_payment_requirements(requirements(p), self.kind(p), [])
        assert exc.value.reason == ERR_SPLIT_COUNT_EXCEEDED

        with pytest.raises(SplitsError) as exc:
            server.enhance_payment_requirements(
                requirements(p, ataCreationRequired=True), self.kind(p, maxSplits=2), []
            )
        assert exc.value.reason == ERR_SPLIT_ATA_CREATION_NOT_AUTHORIZED

        enhanced = server.enhance_payment_requirements(
            requirements(p), self.kind(p, maxSplits=2), []
        )
        assert enhanced.extra["feePayer"] == addr(p.fee_payer)

    def test_refuses_invalid_split_terms(self, p):
        server = ExactSvmServerScheme()
        req = requirements(p, splits=[{"payTo": addr(p.platform), "amount": "1050000"}])
        with pytest.raises(SplitsError) as exc:
            server.enhance_payment_requirements(req, self.kind(p, maxSplits=8), [])
        assert exc.value.reason == ERR_SPLIT_REMAINDER_NOT_POSITIVE

    def test_leaves_single_payee_requirements_alone(self, p):
        server = ExactSvmServerScheme()
        enhanced = server.enhance_payment_requirements(requirements(p, splits=[]), self.kind(p), [])
        assert enhanced.extra["feePayer"] == addr(p.fee_payer)
