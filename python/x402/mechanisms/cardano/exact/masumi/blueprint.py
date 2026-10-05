"""Canonical Masumi deployment and parameterized escrow addresses."""

from functools import lru_cache
from hashlib import blake2b
from typing import Any

from pycardano import Address, Network, RawPlutusData, ScriptHash

from ...constants import CARDANO_PREVIEW_CAIP2, get_cardano_network_id, normalize_cardano_network
from ...limits import MAX_MASUMI_SCRIPT_HASH_CACHE_ENTRIES
from ..script.flat import apply_data_parameters
from .blueprint_code import MASUMI_VESTED_PAY_COMPILED_CODE

MASUMI_BLUEPRINT_DIGEST = "6249de17bb87c5246106af6b0f33de22b44ca24b9c1445fa36d10eb8b583dec7"
MASUMI_VALIDATOR_TITLE = "vested_pay.vested_pay.spend"
MASUMI_DATUM_SCHEMA_VERSION = "masumi.vested_pay.v2"
_DEFAULT_ADMIN_KEYS = (
    "fc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75",
    "7f78161369549d8e2b138fee724c9fa606d6107a66720bdb4c48ada6",
    "89eef9ea84e0ee7fe4921fa93eb2873ff6e34473f751d5d52cb75aa6",
)


def default_masumi_deployment() -> dict[str, Any]:
    return {
        "requiredAdmins": "2",
        "adminVkeys": list(_DEFAULT_ADMIN_KEYS),
        "cooldownPeriod": "420000",
    }


def resolve_masumi_deployment(
    network: str, declared: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    if declared is not None:
        return declared
    return (
        None
        if normalize_cardano_network(network) == CARDANO_PREVIEW_CAIP2
        else default_masumi_deployment()
    )


@lru_cache(maxsize=MAX_MASUMI_SCRIPT_HASH_CACHE_ENTRIES)
def _script_hash(required: str, admins: tuple[str, ...], cooldown: str) -> str:
    parameters = [
        {"int": int(required)},
        {"list": [{"bytes": key} for key in admins]},
        {"int": int(cooldown)},
    ]
    applied = apply_data_parameters(
        bytes.fromhex(MASUMI_VESTED_PAY_COMPILED_CODE),
        [RawPlutusData.from_dict(p).to_cbor() for p in parameters],
    )
    return blake2b(b"\x03" + applied, digest_size=28).hexdigest()


def masumi_escrow_script_hash(deployment: dict[str, Any]) -> str:
    from .schema import validate_deployment

    validate_deployment(deployment)
    return _script_hash(
        deployment["requiredAdmins"], tuple(deployment["adminVkeys"]), deployment["cooldownPeriod"]
    )


def masumi_escrow_address(network: str, deployment: dict[str, Any] | None = None) -> str:
    digest = masumi_escrow_script_hash(
        deployment if deployment is not None else default_masumi_deployment()
    )
    return str(
        Address(ScriptHash(bytes.fromhex(digest)), network=Network(get_cardano_network_id(network)))
    )
