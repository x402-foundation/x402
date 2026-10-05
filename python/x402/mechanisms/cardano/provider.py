"""Bounded Blockfrost and Koios access for Cardano payment signers."""

import base64
import time
from dataclasses import dataclass
from fractions import Fraction
from threading import Lock
from typing import Any

import httpx
from pycardano import (
    Address,
    Asset,
    AssetName,
    ChainContext,
    DatumHash,
    MultiAsset,
    Network,
    ProtocolParameters,
    RawPlutusData,
    ScriptHash,
    TransactionId,
    TransactionInput,
    TransactionOutput,
    UTxO,
    Value,
    VerificationKeyHash,
)

from .constants import get_cardano_network_id
from .limits import DEFAULT_CARDANO_PROVIDER_TIMEOUT_MS
from .types import CardanoSettlementEvidence, CardanoUtxoSnapshot
from .utils import decode_cardano_transaction, parse_utxo_ref, slot_to_posix_ms


@dataclass(frozen=True)
class BlockfrostConfig:
    base_url: str
    project_id: str | None = None


@dataclass(frozen=True)
class KoiosConfig:
    base_url: str
    token: str | None = None


@dataclass(frozen=True)
class CardanoProviderConfig:
    blockfrost: BlockfrostConfig | None = None
    koios: KoiosConfig | None = None
    request_timeout_ms: int = DEFAULT_CARDANO_PROVIDER_TIMEOUT_MS


def _value(amounts: list[dict[str, Any]]) -> Value:
    coin = 0
    assets = MultiAsset()
    for amount in amounts:
        unit, quantity = amount["unit"], int(amount["quantity"])
        if unit == "lovelace":
            coin = quantity
        else:
            policy = ScriptHash(bytes.fromhex(unit[:56]))
            name = AssetName(bytes.fromhex(unit[56:]))
            if policy not in assets:
                assets[policy] = Asset()
            assets[policy][name] = quantity
    return Value(coin, assets)


class CardanoProvider(ChainContext):  # type: ignore[misc]  # PyCardano does not ship py.typed.
    """Provider-only chain context; construction performs no network requests."""

    def __init__(
        self, config: CardanoProviderConfig, network: str, *, client: httpx.Client | None = None
    ):
        timeout = config.request_timeout_ms
        if type(timeout) is not int or not 1 <= timeout <= 120_000:
            raise ValueError(
                "Cardano provider request_timeout_ms must be an integer from 1 to 120000"
            )
        if (config.blockfrost is None) == (config.koios is None):
            raise ValueError("Choose exactly one Cardano provider")
        self.config = config
        self.network_name = network
        self._network = Network(get_cardano_network_id(network))
        self._client = client or httpx.Client(timeout=timeout / 1000)
        self._owns_client = client is None
        self._parameters: tuple[float, ProtocolParameters] | None = None
        self._parameter_lock = Lock()

    @property
    def network(self) -> Network:
        return self._network

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _request(
        self,
        path: str,
        *,
        body: Any = None,
        data: bytes | None = None,
        missing_ok: bool = False,
        deadline: float | None = None,
    ) -> Any:
        config = self.config.blockfrost or self.config.koios
        assert config is not None
        headers = {}
        if self.config.blockfrost and self.config.blockfrost.project_id:
            headers["project_id"] = self.config.blockfrost.project_id
        if self.config.koios and self.config.koios.token:
            headers["Authorization"] = f"Bearer {self.config.koios.token}"
        if data is not None:
            headers["Content-Type"] = "application/cbor"
        timeout = self.config.request_timeout_ms / 1000
        if deadline is not None:
            timeout = min(timeout, deadline - time.monotonic())
            if timeout <= 0:
                raise TimeoutError("Cardano provider operation timed out")
        response = self._client.request(
            "POST" if body is not None or data is not None else "GET",
            config.base_url.rstrip("/") + path,
            headers=headers,
            json=body,
            content=data,
            timeout=timeout,
        )
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("Cardano provider operation timed out")
        if missing_ok and response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()

    @property
    def last_block_slot(self) -> int:
        # The reference signer uses the network's slot clock, not a lagging provider tip.
        return (int(time.time() * 1000) - slot_to_posix_ms(self.network_name, 0)) // 1000

    @property
    def epoch(self) -> int:
        if self.config.blockfrost:
            return int(self._request("/epochs/latest")["epoch"])
        return int(self._request("/tip")[0]["epoch_no"])

    @property
    def protocol_param(self) -> ProtocolParameters:
        with self._parameter_lock:
            if self._parameters is not None and time.monotonic() - self._parameters[0] <= 600:
                return self._parameters[1]
            if self.config.blockfrost:
                raw = self._request("/epochs/latest/parameters")
            else:
                raw = self._request("/epoch_params?limit=1&order=epoch_no.desc")[0]
                raw = {
                    **raw,
                    **{
                        target: raw[source]
                        for target, source in {
                            "max_block_header_size": "max_bh_size",
                            "protocol_major_ver": "protocol_major",
                            "protocol_minor_ver": "protocol_minor",
                            "a0": "influence",
                            "rho": "monetary_expand_rate",
                            "tau": "treasury_growth_rate",
                            "decentralisation_param": "decentralisation",
                            "min_utxo": "min_utxo_value",
                        }.items()
                    },
                }
            parameters = self._protocol_parameters(raw)
            self._parameters = (time.monotonic(), parameters)
            return parameters

    @staticmethod
    def _protocol_parameters(raw: dict[str, Any]) -> ProtocolParameters:
        fields = {
            "min_fee_constant": "min_fee_b",
            "min_fee_coefficient": "min_fee_a",
            "max_block_size": "max_block_size",
            "max_tx_size": "max_tx_size",
            "max_block_header_size": "max_block_header_size",
            "key_deposit": "key_deposit",
            "pool_deposit": "pool_deposit",
            "protocol_major_version": "protocol_major_ver",
            "protocol_minor_version": "protocol_minor_ver",
            "min_pool_cost": "min_pool_cost",
            "max_tx_ex_mem": "max_tx_ex_mem",
            "max_tx_ex_steps": "max_tx_ex_steps",
            "max_block_ex_mem": "max_block_ex_mem",
            "max_block_ex_steps": "max_block_ex_steps",
            "max_val_size": "max_val_size",
            "collateral_percent": "collateral_percent",
            "max_collateral_inputs": "max_collateral_inputs",
        }
        values: dict[str, Any] = {target: int(raw[source]) for target, source in fields.items()}
        for target, source in {
            "pool_influence": "a0",
            "monetary_expansion": "rho",
            "treasury_expansion": "tau",
            "price_mem": "price_mem",
            "price_step": "price_step",
        }.items():
            values[target] = Fraction(str(raw[source]))
        values.update(
            decentralization_param=Fraction(str(raw.get("decentralisation_param") or 0)),
            extra_entropy=raw.get("extra_entropy") or "neutral",
            min_utxo=int(raw.get("min_utxo") or 0),
            coins_per_utxo_word=int(raw.get("coins_per_utxo_word") or 34482),
            coins_per_utxo_byte=int(raw.get("coins_per_utxo_size") or raw["coins_per_utxo_byte"]),
            cost_models=raw.get("cost_models", {}),
            maximum_reference_scripts_size={"bytes": 200000},
            min_fee_reference_scripts={
                "base": float(raw.get("min_fee_ref_script_cost_per_byte") or 0),
                "range": 200000,
                "multiplier": 1,
            },
        )
        return ProtocolParameters(**values)

    def _output(self, raw: dict[str, Any]) -> TransactionOutput:
        output = TransactionOutput(Address.from_primitive(raw["address"]), _value(raw["amount"]))
        if raw.get("inline_datum"):
            output.datum = RawPlutusData.from_cbor(raw["inline_datum"])
            output.post_alonzo = True
        elif raw.get("data_hash"):
            output.datum_hash = DatumHash(bytes.fromhex(raw["data_hash"]))
        # Reference-script inputs need their full script to account for its fee.
        # Do not select them as ordinary wallet funding inputs.
        return output

    def _utxo_rows(self, address: str, deadline: float) -> list[dict[str, Any]]:
        if self.config.koios:
            records = self._request(
                "/address_info", body={"_addresses": [address]}, deadline=deadline
            )
            rows = [
                self._koios_output(row, address)
                for record in records
                for row in record.get("utxo_set", [])
            ]
        else:
            rows = []
            page = 1
            while True:
                batch = (
                    self._request(
                        f"/addresses/{address}/utxos?count=100&page={page}",
                        missing_ok=True,
                        deadline=deadline,
                    )
                    or []
                )
                rows.extend(batch)
                if len(batch) < 100:
                    break
                page += 1
        return rows

    def _utxos(self, address: str) -> list[UTxO]:
        deadline = time.monotonic() + self.config.request_timeout_ms / 1000
        return [
            UTxO(
                TransactionInput(
                    TransactionId(bytes.fromhex(row["tx_hash"])), int(row["output_index"])
                ),
                self._output({**row, "address": row.get("address", address)}),
            )
            for row in self._utxo_rows(address, deadline)
            if not row.get("reference_script_hash")
        ]

    @staticmethod
    def _koios_output(raw: dict[str, Any], address: str | None = None) -> dict[str, Any]:
        payment = raw.get("payment_addr")
        full_address = (
            raw.get("address")
            or (payment.get("bech32") if isinstance(payment, dict) else payment)
            or address
        )
        datum = raw.get("inline_datum")
        return {
            "address": full_address,
            "tx_hash": raw["tx_hash"],
            "output_index": raw["tx_index"],
            "amount": [{"unit": "lovelace", "quantity": raw["value"]}]
            + [
                {"unit": asset["policy_id"] + asset["asset_name"], "quantity": asset["quantity"]}
                for asset in raw.get("asset_list", [])
            ],
            "data_hash": raw.get("datum_hash"),
            "inline_datum": datum.get("bytes") if isinstance(datum, dict) else datum,
            "reference_script_hash": (raw.get("reference_script") or {}).get("hash"),
        }

    def get_utxo(self, reference: str) -> CardanoUtxoSnapshot:
        deadline = time.monotonic() + self.config.request_timeout_ms / 1000
        tx_hash, index = parse_utxo_ref(reference)
        if self.config.blockfrost:
            transaction = self._request(f"/txs/{tx_hash}/utxos", missing_ok=True, deadline=deadline)
            rows = (transaction or {}).get("outputs", [])
            row = next((row for row in rows if row.get("output_index") == index), None)
        else:
            rows = self._request(
                "/tx_info",
                body={"_tx_hashes": [tx_hash], "_assets": True, "_scripts": True},
                deadline=deadline,
            )
            outputs = rows[0].get("outputs", []) if rows else []
            row = next(
                (
                    self._koios_output({**item, "tx_hash": tx_hash})
                    for item in outputs
                    if item.get("tx_index") == index
                ),
                None,
            )
        if row is None:
            return CardanoUtxoSnapshot(False)
        address = row["address"]
        credential = Address.from_primitive(address).payment_part
        key_hash = credential.payload.hex() if isinstance(credential, VerificationKeyHash) else None
        if "consumed_by_tx" in row:
            exists = not bool(row["consumed_by_tx"])
        else:
            exists = any(
                utxo["tx_hash"] == tx_hash and int(utxo["output_index"]) == index
                for utxo in self._utxo_rows(address, deadline)
            )
        if not exists:
            return CardanoUtxoSnapshot(False, address=address, payment_key_hash=key_hash)
        value = _value(row["amount"])
        assets = {
            f"{policy.payload.hex()}.{name.payload.hex()}": quantity
            for policy, names in value.multi_asset.items()
            for name, quantity in names.items()
        }
        return CardanoUtxoSnapshot(True, address, value.coin, assets, key_hash)

    def get_transaction_evidence(
        self, tx_hash: str, *, deadline: float | None = None
    ) -> CardanoSettlementEvidence:
        if deadline is None:
            deadline = time.monotonic() + self.config.request_timeout_ms / 1000
        if self.config.koios:
            rows = self._request("/tx_cbor", body={"_tx_hashes": [tx_hash]}, deadline=deadline)
            for row in rows:
                if row.get("tx_hash") != tx_hash or not row.get("block_hash"):
                    continue
                # Inclusion alone also covers failed Plutus transactions. Check the
                # ledger's validity flag in its stored transaction before accepting it.
                decoded = decode_cardano_transaction(
                    base64.b64encode(bytes.fromhex(row["cbor"])).decode()
                )
                if decoded.tx_hash == tx_hash and decoded.is_valid:
                    return CardanoSettlementEvidence("confirmed", 0)
            return CardanoSettlementEvidence("unknown", -2)
        tx = self._request(f"/txs/{tx_hash}", missing_ok=True, deadline=deadline)
        if tx is None or tx.get("valid_contract") is False:
            return CardanoSettlementEvidence("unknown", -2)
        tip = self._request("/blocks/latest", missing_ok=True, deadline=deadline)
        height, tip_height = tx.get("block_height"), (tip or {}).get("height")
        depth = (
            max(0, int(tip_height) - int(height))
            if height is not None and tip_height is not None
            else 0
        )
        return CardanoSettlementEvidence("confirmed", depth)

    def submit_tx_cbor(self, cbor: bytes | str) -> str:
        raw = bytes.fromhex(cbor) if isinstance(cbor, str) else cbor
        result = self._request("/tx/submit" if self.config.blockfrost else "/submittx", data=raw)
        if not isinstance(result, str):
            raise ValueError("Cardano provider returned an invalid transaction hash")
        return result

    def wait_for_confirmation(self, tx_hash: str) -> None:
        deadline = time.monotonic() + self.config.request_timeout_ms / 1000
        while True:
            if self.get_transaction_evidence(tx_hash, deadline=deadline).status == "confirmed":
                return
            if time.monotonic() + 1 >= deadline:
                raise TimeoutError("Cardano provider awaitTx timed out")
            time.sleep(1)

    def evaluate_transaction(self, raw: bytes) -> None:
        if self.config.blockfrost:
            result = self._request("/utils/txs/evaluate", data=raw)
        else:
            result = self._request(
                "/ogmios",
                body={
                    "jsonrpc": "2.0",
                    "method": "evaluateTransaction",
                    "params": {"transaction": {"cbor": raw.hex()}},
                },
            )
        if "error" in result or "EvaluationFailure" in result.get("result", {}):
            raise ValueError("Cardano transaction evaluation failed")
