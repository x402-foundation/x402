import base64
from typing import NamedTuple
from unittest.mock import MagicMock, patch

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm import (
    ERR_AMOUNT_INSUFFICIENT,
    ERR_MINT_MISMATCH,
    ERR_RECIPIENT_ATA_MISSING,
    ERR_RECIPIENT_ATA_WRONG_PROGRAM_OWNER,
    ERR_RECIPIENT_MISMATCH,
    ERR_SIMULATION_FAILED,
    ERR_TRANSACTION_DECODE_FAILED,
    SOLANA_DEVNET_CAIP2,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    derive_ata,
)
from x402.mechanisms.svm.exact import ExactSvmClientScheme, ExactSvmFacilitatorScheme
from x402.mechanisms.svm.signers import KeypairSigner
from x402.schemas import PaymentPayload, PaymentRequirements

SIMULATION_MESSAGE = "Transaction simulation failed: InvalidAccountData"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
PAYMENT_AMOUNT = "100000"
FIXED_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"
SIGN_FAILURE = "fee payer refused to sign"
READ_FAILURE = "Account read unavailable"


class ExactPayment(NamedTuple):
    token_program: str
    payload: PaymentPayload
    requirements: PaymentRequirements
    destination: str
    payer: str
    fee_payer: str


class _RecordingSigner:
    def __init__(self, fee_payer: str) -> None:
        self._fee_payer = fee_payer
        self.calls: list[tuple[object, ...]] = []
        self.simulate_error: BaseException | None = RuntimeError(SIMULATION_MESSAGE)
        self.sign_error: BaseException | None = None

    def get_addresses(self) -> list[str]:
        return [self._fee_payer]

    def sign_transaction(self, tx_base64: str, fee_payer: str, network: str) -> str:
        self.calls.append(("sign_transaction", tx_base64, fee_payer, network))
        if self.sign_error is not None:
            raise self.sign_error
        return tx_base64

    def simulate_transaction(self, tx_base64: str, network: str) -> None:
        self.calls.append(("simulate_transaction", tx_base64, network))
        if self.simulate_error is not None:
            raise self.simulate_error

    def send_transaction(self, tx_base64: str, network: str) -> str:
        self.calls.append(("send_transaction", tx_base64, network))
        return "unexpected-signature"

    def confirm_transaction(self, signature: str, network: str) -> None:
        self.calls.append(("confirm_transaction", signature, network))


class _AccountInfoSigner(_RecordingSigner):
    def __init__(self, fee_payer: str, owner: str | None) -> None:
        super().__init__(fee_payer)
        self._owner = owner
        self.account_error: BaseException | None = None

    def get_account_info(self, address: str, network: str) -> str | None:
        self.calls.append(("get_account_info", address, network))
        if self.account_error is not None:
            raise self.account_error
        return self._owner


def _mock_mint_rpc(token_program: str) -> MagicMock:
    mock_client = MagicMock()
    blockhash_response = MagicMock()
    blockhash_response.value.blockhash = Hash.from_string(FIXED_BLOCKHASH)
    mock_client.get_latest_blockhash.return_value = blockhash_response
    account_info = MagicMock()
    account_info.value.owner = Pubkey.from_string(token_program)
    account_info.value.data = bytes(44) + bytes([6]) + bytes(37)
    mock_client.get_account_info.return_value = account_info
    return mock_client


def _calls(signer: _RecordingSigner, name: str) -> list[tuple[object, ...]]:
    return [entry for entry in signer.calls if entry[0] == name]


def _assert_no_broadcast(signer: _RecordingSigner) -> None:
    assert _calls(signer, "send_transaction") == []
    assert _calls(signer, "confirm_transaction") == []


def _other_token_program(token_program: str) -> str:
    if token_program == TOKEN_PROGRAM_ADDRESS:
        return TOKEN_2022_PROGRAM_ADDRESS
    return TOKEN_PROGRAM_ADDRESS


def _missing_message(destination: str) -> str:
    return (
        f"{SIMULATION_MESSAGE}; recipient ATA {destination} was not found during diagnostic lookup"
    )


def _wrong_owner_message(destination: str, owner: str, token_program: str) -> str:
    return (
        f"{SIMULATION_MESSAGE}; recipient ATA {destination} has program "
        f"owner {owner}, expected {token_program}"
    )


@pytest.fixture(
    params=[TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS],
    ids=["spl-token", "token-2022"],
)
def exact_payment(request: pytest.FixtureRequest) -> ExactPayment:
    token_program = request.param
    payer_keypair = Keypair()
    fee_payer = Keypair()
    recipient = Keypair()
    mint = Keypair()
    requirements = PaymentRequirements(
        scheme="exact",
        network=SOLANA_DEVNET_CAIP2,
        asset=str(mint.pubkey()),
        amount=PAYMENT_AMOUNT,
        pay_to=str(recipient.pubkey()),
        max_timeout_seconds=3600,
        extra={"feePayer": str(fee_payer.pubkey())},
    )
    client = ExactSvmClientScheme(KeypairSigner(payer_keypair))
    with patch.object(client, "_get_client", return_value=_mock_mint_rpc(token_program)):
        inner = client.create_payment_payload(requirements)
    transaction = inner["transaction"]
    assert isinstance(transaction, str)
    tx = VersionedTransaction.from_bytes(base64.b64decode(transaction))
    transfer_accounts = list(tx.message.instructions[2].accounts)
    destination = str(list(tx.message.account_keys)[transfer_accounts[2]])
    assert destination == derive_ata(str(recipient.pubkey()), str(mint.pubkey()), token_program)
    payload = PaymentPayload(x402_version=2, accepted=requirements, payload=inner)
    return ExactPayment(
        token_program=token_program,
        payload=payload,
        requirements=requirements,
        destination=destination,
        payer=str(payer_keypair.pubkey()),
        fee_payer=str(fee_payer.pubkey()),
    )


def _scheme(signer: _RecordingSigner) -> ExactSvmFacilitatorScheme:
    return ExactSvmFacilitatorScheme(signer)


@pytest.mark.parametrize("state", ["missing", "system program", "other token program"])
def test_diagnoses_recipient_ata_only_after_failed_simulation(
    exact_payment: ExactPayment, state: str
) -> None:
    if state == "missing":
        owner = None
        reason = ERR_RECIPIENT_ATA_MISSING
        message = _missing_message(exact_payment.destination)
    elif state == "system program":
        owner = SYSTEM_PROGRAM
        reason = ERR_RECIPIENT_ATA_WRONG_PROGRAM_OWNER
        message = _wrong_owner_message(
            exact_payment.destination, owner, exact_payment.token_program
        )
    elif state == "other token program":
        owner = _other_token_program(exact_payment.token_program)
        reason = ERR_RECIPIENT_ATA_WRONG_PROGRAM_OWNER
        message = _wrong_owner_message(
            exact_payment.destination, owner, exact_payment.token_program
        )
    else:
        raise AssertionError(state)

    signer = _AccountInfoSigner(exact_payment.fee_payer, owner)
    result = _scheme(signer).verify(exact_payment.payload, exact_payment.requirements)

    assert result.is_valid is False
    assert result.invalid_reason == reason
    assert result.invalid_message == message
    assert result.payer == exact_payment.payer
    names = [entry[0] for entry in signer.calls]
    assert names.index("simulate_transaction") < names.index("get_account_info")
    assert _calls(signer, "get_account_info") == [
        ("get_account_info", exact_payment.destination, SOLANA_DEVNET_CAIP2)
    ]
    _assert_no_broadcast(signer)


@pytest.mark.parametrize(
    "state",
    ["correct owner", "read error", "inconclusive owner", "no getter"],
)
def test_preserves_simulation_failure(exact_payment: ExactPayment, state: str) -> None:
    if state == "no getter":
        signer: _RecordingSigner = _RecordingSigner(exact_payment.fee_payer)
    elif state == "correct owner":
        signer = _AccountInfoSigner(exact_payment.fee_payer, exact_payment.token_program)
    elif state == "inconclusive owner":
        signer = _AccountInfoSigner(exact_payment.fee_payer, "")
    elif state == "read error":
        signer = _AccountInfoSigner(exact_payment.fee_payer, exact_payment.token_program)
        signer.account_error = RuntimeError(READ_FAILURE)
    else:
        raise AssertionError(state)

    result = _scheme(signer).verify(exact_payment.payload, exact_payment.requirements)

    assert result.is_valid is False
    assert result.invalid_reason == ERR_SIMULATION_FAILED
    assert result.invalid_message == SIMULATION_MESSAGE
    assert result.payer == exact_payment.payer
    assert READ_FAILURE not in result.invalid_message
    if state == "no getter":
        assert _calls(signer, "get_account_info") == []
    else:
        names = [entry[0] for entry in signer.calls]
        assert names.index("simulate_transaction") < names.index("get_account_info")
        assert _calls(signer, "get_account_info") == [
            ("get_account_info", exact_payment.destination, SOLANA_DEVNET_CAIP2)
        ]
    _assert_no_broadcast(signer)


def test_successful_simulation_does_not_read_the_account(exact_payment: ExactPayment) -> None:
    signer = _AccountInfoSigner(exact_payment.fee_payer, None)
    signer.simulate_error = None

    result = _scheme(signer).verify(exact_payment.payload, exact_payment.requirements)

    assert result.is_valid is True
    assert result.payer == exact_payment.payer
    assert _calls(signer, "sign_transaction") == [
        (
            "sign_transaction",
            exact_payment.payload.payload["transaction"],
            exact_payment.fee_payer,
            SOLANA_DEVNET_CAIP2,
        )
    ]
    assert _calls(signer, "get_account_info") == []
    _assert_no_broadcast(signer)


def test_sign_failure_stays_generic_and_does_not_read(exact_payment: ExactPayment) -> None:
    signer = _AccountInfoSigner(exact_payment.fee_payer, None)
    signer.sign_error = RuntimeError(SIGN_FAILURE)

    result = _scheme(signer).verify(exact_payment.payload, exact_payment.requirements)

    assert result.is_valid is False
    assert result.invalid_reason == ERR_SIMULATION_FAILED
    assert result.invalid_message == SIGN_FAILURE
    assert result.payer == exact_payment.payer
    assert _calls(signer, "simulate_transaction") == []
    assert _calls(signer, "get_account_info") == []
    _assert_no_broadcast(signer)


def test_amount_above_payment_is_not_diagnosed(exact_payment: ExactPayment) -> None:
    signer = _AccountInfoSigner(exact_payment.fee_payer, None)
    requirements = exact_payment.requirements.model_copy(update={"amount": "100001"})

    result = _scheme(signer).verify(exact_payment.payload, requirements)

    assert result.is_valid is False
    assert result.invalid_reason == ERR_AMOUNT_INSUFFICIENT
    assert _calls(signer, "simulate_transaction") == []
    assert _calls(signer, "get_account_info") == []
    _assert_no_broadcast(signer)


def test_mint_mismatch_is_not_diagnosed(exact_payment: ExactPayment) -> None:
    signer = _AccountInfoSigner(exact_payment.fee_payer, None)
    requirements = exact_payment.requirements.model_copy(update={"asset": exact_payment.fee_payer})

    result = _scheme(signer).verify(exact_payment.payload, requirements)

    assert result.is_valid is False
    assert result.invalid_reason == ERR_MINT_MISMATCH
    assert _calls(signer, "simulate_transaction") == []
    assert _calls(signer, "get_account_info") == []
    _assert_no_broadcast(signer)


def test_recipient_mismatch_is_not_diagnosed(exact_payment: ExactPayment) -> None:
    signer = _AccountInfoSigner(exact_payment.fee_payer, None)
    requirements = exact_payment.requirements.model_copy(update={"pay_to": str(Keypair().pubkey())})

    result = _scheme(signer).verify(exact_payment.payload, requirements)

    assert result.is_valid is False
    assert result.invalid_reason == ERR_RECIPIENT_MISMATCH
    assert _calls(signer, "simulate_transaction") == []
    assert _calls(signer, "get_account_info") == []
    _assert_no_broadcast(signer)


def test_undecodable_payload_is_not_diagnosed(exact_payment: ExactPayment) -> None:
    signer = _AccountInfoSigner(exact_payment.fee_payer, None)
    payload = exact_payment.payload.model_copy(
        update={"payload": {"transaction": "invalid-base64"}}
    )

    result = _scheme(signer).verify(payload, exact_payment.requirements)

    assert result.is_valid is False
    assert result.invalid_reason == ERR_TRANSACTION_DECODE_FAILED
    assert _calls(signer, "simulate_transaction") == []
    assert _calls(signer, "get_account_info") == []
    _assert_no_broadcast(signer)


@pytest.mark.parametrize("state", ["missing", "system program"])
def test_settle_includes_the_verify_message(exact_payment: ExactPayment, state: str) -> None:
    if state == "missing":
        owner = None
        reason = ERR_RECIPIENT_ATA_MISSING
        message = _missing_message(exact_payment.destination)
    elif state == "system program":
        owner = SYSTEM_PROGRAM
        reason = ERR_RECIPIENT_ATA_WRONG_PROGRAM_OWNER
        message = _wrong_owner_message(
            exact_payment.destination, owner, exact_payment.token_program
        )
    else:
        raise AssertionError(state)

    signer = _AccountInfoSigner(exact_payment.fee_payer, owner)
    result = _scheme(signer).settle(exact_payment.payload, exact_payment.requirements)

    assert result.success is False
    assert result.error_reason == reason
    assert result.error_message == message
    assert result.transaction == ""
    assert result.payer == exact_payment.payer
    assert _calls(signer, "get_account_info") == [
        ("get_account_info", exact_payment.destination, SOLANA_DEVNET_CAIP2)
    ]
    _assert_no_broadcast(signer)


def test_settle_correct_owner_keeps_the_simulation_message(
    exact_payment: ExactPayment,
) -> None:
    signer = _AccountInfoSigner(exact_payment.fee_payer, exact_payment.token_program)

    result = _scheme(signer).settle(exact_payment.payload, exact_payment.requirements)

    assert result.success is False
    assert result.error_reason == ERR_SIMULATION_FAILED
    assert result.error_message == SIMULATION_MESSAGE
    assert result.transaction == ""
    _assert_no_broadcast(signer)


def test_settle_mint_mismatch_has_no_error_message(exact_payment: ExactPayment) -> None:
    signer = _AccountInfoSigner(exact_payment.fee_payer, None)
    requirements = exact_payment.requirements.model_copy(update={"asset": exact_payment.fee_payer})

    result = _scheme(signer).settle(exact_payment.payload, requirements)

    assert result.success is False
    assert result.error_reason == ERR_MINT_MISMATCH
    assert result.error_message is None
    assert result.transaction == ""
    assert _calls(signer, "simulate_transaction") == []
    assert _calls(signer, "get_account_info") == []
    _assert_no_broadcast(signer)
