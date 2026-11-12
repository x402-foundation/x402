"""Reference wallet and provider-only signers for exact Cardano payments."""

import base64
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pycardano import (
    Address,
    Asset,
    AssetName,
    MultiAsset,
    ScriptHash,
    TransactionBuilder,
    TransactionOutput,
    Value,
)
from pycardano.utils import min_lovelace_post_alonzo

from ...schemas import PaymentRequirements
from .constants import normalize_cardano_network
from .exact.masumi.constants import (
    MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE,
    MASUMI_MAX_DEADLINE_HORIZON_MS,
)
from .exact.masumi.datum import parse_masumi_lock_datum
from .exact.masumi.lock import build_masumi_lock
from .exact.masumi.schema import is_key_credential_address_on
from .exact.masumi.verify import (
    MasumiAuthorizationOptions,
    verify_masumi_authorization,
    verify_masumi_datum_invariants,
)
from .exact.script.datum import build_script_datum_inline
from .provider import CardanoProvider, CardanoProviderConfig
from .signer import ClientCardanoSignInput
from .types import (
    CardanoProtocolParameters,
    CardanoSettlementEvidence,
    CardanoSubmissionResult,
    CardanoUtxoSnapshot,
    ExactCardanoPayload,
)
from .utils import (
    decode_cardano_transaction,
    decode_cardano_transaction_bytes,
    parse_asset_unit,
    slot_to_posix_ms,
)
from .wallet import derive_wallet


@dataclass
class ClientCardanoSignerConfig:
    """Wallet and Masumi approval configuration for synchronous transaction building.

    Attributes:
        account_index: CIP-1852 account index used with the local mnemonic.
        masumi_buyer_input: Synchronous callback returning buyer-controlled datum fields.
        validate_masumi_registry_claim: Approve the supplied agent, seller, resource
            and price against independently obtained registry information.
        masumi_request_content: Original request content keyed by commitment-part name,
            used to verify parts omitted from the seller's response.
        validate_custom_masumi_deployment: Explicitly approve supplied deployment parameters.
        masumi_max_collateral_lovelace: Maximum additional ADA lock, in lovelace.
        masumi_max_deadline_horizon_ms: Maximum deadline horizon from now, in milliseconds.
    """

    mnemonic: str
    network: str
    provider: CardanoProviderConfig
    account_index: int = 0
    masumi_buyer_input: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    validate_masumi_registry_claim: Callable[[dict[str, Any]], bool] | None = None
    masumi_request_content: dict[str, Any] | None = None
    validate_custom_masumi_deployment: Callable[[dict[str, Any]], bool] | None = None
    masumi_max_collateral_lovelace: int = MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE
    masumi_max_deadline_horizon_ms: int = MASUMI_MAX_DEADLINE_HORIZON_MS


@dataclass
class FacilitatorCardanoSignerConfig:
    """Provider access for synchronous verification and submission.

    The optional mnemonic derives advertised addresses only; the facilitator does
    not sign payments. Set await_confirmation=False to let the scheme manage polling.
    validate_phase1_transaction must raise on any complete ledger phase-1 rejection;
    script evaluation alone does not satisfy that callback's contract.
    """

    network: str
    provider: CardanoProviderConfig
    mnemonic: str | None = None
    account_index: int = 0
    await_confirmation: bool = True
    validate_phase1_transaction: Callable[[str, str], None] | None = None


class PyCardanoClientSigner:
    """Build and sign complete transactions without broadcasting them."""

    def __init__(
        self, config: ClientCardanoSignerConfig, *, provider: CardanoProvider | None = None
    ):
        self.config = config
        self._wallet = derive_wallet(config.mnemonic, config.network, config.account_index)
        self._provider = provider or CardanoProvider(config.provider, config.network)

    def get_address(self) -> str:
        return self._wallet.address

    def close(self) -> None:
        self._provider.close()

    def build_and_sign_payment_transaction(
        self, input: ClientCardanoSignInput
    ) -> ExactCardanoPayload:
        config = self.config
        if normalize_cardano_network(input.network) != normalize_cardano_network(config.network):
            raise ValueError("Cardano signer network does not match payment network")
        extra = input.extra or {}
        method = extra.get("assetTransferMethod", "default")
        masumi = method == "masumi"
        buyer_return = None
        if masumi:
            requirements = PaymentRequirements(
                scheme="exact",
                network=input.network,
                pay_to=input.pay_to,
                asset=input.asset,
                amount=input.amount,
                max_timeout_seconds=input.max_timeout_seconds,
                extra=extra,
            )
            result = verify_masumi_authorization(
                extra,
                requirements,
                MasumiAuthorizationOptions(
                    validate_registry_claim=config.validate_masumi_registry_claim,
                    resource=input.resource,
                    validate_custom_deployment=config.validate_custom_masumi_deployment,
                    local_commitment_content=config.masumi_request_content,
                    require_all_part_content=True,
                    max_deadline_horizon_ms=config.masumi_max_deadline_horizon_ms,
                ),
            )
            if not result.ok:
                raise ValueError(
                    f"Masumi seller authorization failed: {result.reason} ({result.detail or ''})"
                )
            now = int(time.time() * 1000)
            pay_by = int(extra["terms"]["payByTime"])
            if (
                type(input.max_timeout_seconds) is not int
                or input.max_timeout_seconds <= 0
                or not now < pay_by <= now + input.max_timeout_seconds * 1000
            ):
                raise ValueError("Masumi payByTime is expired or exceeds maxTimeoutSeconds")
            buyer_input = config.masumi_buyer_input(extra) if config.masumi_buyer_input else {}
            if "buyerReturnAddress" in buyer_input:
                buyer_return = buyer_input["buyerReturnAddress"]
                if not is_key_credential_address_on(buyer_return, input.network):
                    raise ValueError(
                        "Masumi buyer return address must be a key-credential address on network"
                    )
        datum = build_script_datum_inline(extra) if method == "script" else None
        utxos = self._provider.utxos(self._wallet.address)
        if not utxos:
            raise ValueError("Funding wallet has no UTxOs available for the payment")
        nonce_utxo = utxos[0]
        amount = int(input.amount)
        is_lovelace = input.asset == "lovelace"
        value = Value(amount if is_lovelace else 0)
        if not is_lovelace:
            policy, name = parse_asset_unit(input.asset)
            value.multi_asset = MultiAsset(
                {ScriptHash(bytes.fromhex(policy)): Asset({AssetName(bytes.fromhex(name)): amount})}
            )
        if masumi:
            lock = build_masumi_lock(
                extra,
                str(nonce_utxo.output.address),
                input.asset,
                amount,
                self._provider.protocol_param.coins_per_utxo_byte,
                buyer_return,
            )
            view = parse_masumi_lock_datum(lock.datum)
            if view is None:
                raise ValueError("Masumi client preflight could not decode the lock datum")
            invariants = verify_masumi_datum_invariants(view, input.pay_to)
            if not invariants.ok:
                raise ValueError(
                    f"Masumi client preflight failed: {invariants.reason} ({invariants.detail})"
                )
            if lock.collateral_lovelace > config.masumi_max_collateral_lovelace:
                raise ValueError("Masumi collateral exceeds the configured maximum")
            value.coin, datum = lock.locked_lovelace, lock.datum
        output = TransactionOutput(
            Address.from_primitive(input.pay_to), value, datum=datum, post_alonzo=datum is not None
        )
        if not masumi and (not is_lovelace or datum is not None):
            output.amount.coin = max(
                output.amount.coin, min_lovelace_post_alonzo(output, self._provider)
            )
        elif not masumi and output.amount.coin < min_lovelace_post_alonzo(output, self._provider):
            raise ValueError("Cardano ADA amount is below the minimum UTxO value")
        ttl_ms = (
            int(extra["terms"]["payByTime"])
            if masumi
            else int(time.time() * 1000) + input.max_timeout_seconds * 1000
        )
        ttl_slot = (ttl_ms - slot_to_posix_ms(input.network, 0)) // 1000
        builder = TransactionBuilder(self._provider, ttl=ttl_slot)
        builder.add_input(nonce_utxo)
        builder.potential_inputs.extend(utxos[1:])
        builder.add_output(output)
        signed = builder.build_and_sign(
            [self._wallet.payment_key], change_address=Address.from_primitive(self._wallet.address)
        )
        if masumi and int(extra["terms"]["payByTime"]) <= int(time.time() * 1000):
            raise ValueError("Masumi payByTime expired before signing completed")
        return ExactCardanoPayload(
            base64.b64encode(signed.to_cbor()).decode(),
            f"{nonce_utxo.input.transaction_id}#{nonce_utxo.input.index}",
        )


class ProviderCardanoFacilitatorSigner:
    """Submit buyer-signed bytes and resolve their chain state without a wallet."""

    def __init__(
        self, config: FacilitatorCardanoSignerConfig, *, provider: CardanoProvider | None = None
    ):
        if config.provider.koios and config.await_confirmation is False:
            raise ValueError("await_confirmation=False requires a Blockfrost provider")
        self.config = config
        self._provider = provider or CardanoProvider(config.provider, config.network)
        self._addresses = (
            [derive_wallet(config.mnemonic, config.network, config.account_index).address]
            if config.mnemonic
            else []
        )
        self.max_l1_confirmations = 20 if config.provider.blockfrost else 0
        self.get_transaction_evidence = self._get_transaction_evidence
        # Optional validation hooks must be absent when they are not configured.
        if config.validate_phase1_transaction:
            self.validate_phase1_transaction = self._validate_phase1_transaction

    def _assert_network(self, network: str) -> None:
        if normalize_cardano_network(network) != normalize_cardano_network(self.config.network):
            raise ValueError("Cardano signer network does not match requested network")

    def close(self) -> None:
        self._provider.close()

    def get_addresses(self) -> list[str]:
        return list(self._addresses)

    def get_utxo(self, reference: str, network: str) -> CardanoUtxoSnapshot:
        self._assert_network(network)
        return self._provider.get_utxo(reference)

    def get_current_slot(self, network: str) -> int:
        self._assert_network(network)
        return self._provider.last_block_slot

    def _get_transaction_evidence(self, tx_hash: str, network: str) -> CardanoSettlementEvidence:
        self._assert_network(network)
        return self._provider.get_transaction_evidence(tx_hash)

    def _validate_phase1_transaction(self, transaction: str, network: str) -> None:
        self._assert_network(network)
        assert self.config.validate_phase1_transaction is not None
        self.config.validate_phase1_transaction(transaction, network)

    def get_protocol_parameters(self, network: str) -> CardanoProtocolParameters:
        self._assert_network(network)
        parameters = self._provider.protocol_param
        return CardanoProtocolParameters(
            parameters.coins_per_utxo_byte,
            parameters.min_fee_coefficient,
            parameters.min_fee_constant,
        )

    def submit_transaction(self, transaction: str, network: str) -> CardanoSubmissionResult:
        self._assert_network(network)
        tx_hash = self._provider.submit_tx_cbor(decode_cardano_transaction_bytes(transaction))
        if self.config.await_confirmation is False:
            return CardanoSubmissionResult(tx_hash, "mempool")
        try:
            self._provider.wait_for_confirmation(tx_hash)
        except Exception:
            return CardanoSubmissionResult(tx_hash, "mempool")
        return CardanoSubmissionResult(tx_hash, "confirmed")

    def wait_for_confirmation(self, tx_hash: str, network: str) -> None:
        self._assert_network(network)
        self._provider.wait_for_confirmation(tx_hash)

    def evaluate_transaction(self, transaction: str, network: str) -> None:
        self._assert_network(network)
        decoded = decode_cardano_transaction(transaction)
        if decoded.redeemer_count:
            self._provider.evaluate_transaction(decode_cardano_transaction_bytes(transaction))


def to_client_cardano_signer(config: ClientCardanoSignerConfig) -> PyCardanoClientSigner:
    return PyCardanoClientSigner(config)


def to_facilitator_cardano_signer(
    config: FacilitatorCardanoSignerConfig,
) -> ProviderCardanoFacilitatorSigner:
    return ProviderCardanoFacilitatorSigner(config)
