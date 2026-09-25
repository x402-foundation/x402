"""Script hashes use the same parameter ordering and CBOR as TypeScript."""

import pytest
from pycardano import Address, Network, ScriptHash, VerificationKeyHash

from x402.mechanisms.cardano.exact.script.datum import build_script_datum_inline
from x402.mechanisms.cardano.exact.script_address import (
    derive_script_hash_hex,
    script_address_matches,
)

CODE = "4d01000033222220051200120011"


@pytest.mark.parametrize(
    "parameters,expected",
    [
        ({}, "4fff649fb4372ec3c408b6f0468d74e4d319904cde27fd3f00910a52"),
        (
            {"p": {"type": "integer", "value": "42"}},
            "7bfdc59e675e288dc869395143d2ed2d227bd23f0663449c847f6fcc",
        ),
        (
            {"a": {"type": "bytes", "value": "abcd"}, "b": {"type": "boolean", "value": True}},
            "b40bd8907839d77f909bae5b96f38d9a658b93de9e710e7667a99116",
        ),
    ],
)
def test_typescript_parameterized_script_vectors(parameters, expected):
    assert (
        derive_script_hash_hex(
            {"script": {"type": "plutusV3", "code": CODE}, "parameters": parameters}
        )
        == expected
    )


def test_script_hash_and_address():
    extra = {"script": {"type": "plutusV3", "code": CODE}}
    digest = derive_script_hash_hex(extra)
    address = str(Address(ScriptHash(bytes.fromhex(digest)), network=Network.TESTNET))
    assert script_address_matches(extra, address)
    assert script_address_matches({"scriptHash": digest}, address)
    assert not script_address_matches({"scriptHash": "00" * 28}, address)
    key_address = str(Address(VerificationKeyHash(bytes(28)), network=Network.TESTNET))
    assert not script_address_matches(extra, key_address)
    assert not script_address_matches({}, address)
    extra["parameters"] = {"p": {"type": "integer", "value": "42"}}
    assert not script_address_matches(extra, address)


@pytest.mark.parametrize("value", [True, 1.5, "01", "-0", "+1", "1" * 129])
def test_invalid_integer_parameter(value):
    with pytest.raises(ValueError):
        derive_script_hash_hex(
            {
                "script": {"type": "plutusV3", "code": CODE},
                "parameters": {"p": {"type": "integer", "value": value}},
            }
        )


def test_parameter_order_is_significant():
    script = {"type": "plutusV3", "code": CODE}
    params = {"a": {"type": "bytes", "value": "abcd"}, "b": {"type": "boolean", "value": True}}
    assert derive_script_hash_hex(
        {"script": script, "parameters": params}
    ) != derive_script_hash_hex(
        {"script": script, "parameters": dict(reversed(list(params.items())))}
    )


def test_inline_datum():
    assert build_script_datum_inline({}) is None
    assert build_script_datum_inline({"datum": "d87980"}).to_cbor_hex() == "d87980"
    for datum in ["", "ff", "01ff", "gg", "0", 1]:
        with pytest.raises(ValueError):
            build_script_datum_inline({"datum": datum})


def test_canonical_masumi_blueprint_hash():
    from x402.mechanisms.cardano.exact.masumi.blueprint import (
        default_masumi_deployment,
        masumi_escrow_script_hash,
    )

    assert masumi_escrow_script_hash(default_masumi_deployment()) == (
        "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad"
    )


@pytest.mark.parametrize(
    "names,expected",
    [
        (["2", "1"], "f45062161f8fca9e05c7803e6cca8593e78b8b4b65fc942e8cd0b3ab"),
        (["z", "2", "01", "1", "a"], "c655adb9d7e007359fc02b626e7e881372164592bdf46638acb31b73"),
        (
            ["4294967295", "4294967294", "00", "0", "-0", "1", "a"],
            "a590872d1bda0ec7fb2dcb8fef7bf10c66f3bfcc3fd39d274a109653",
        ),
    ],
)
def test_typescript_array_index_parameter_order(names, expected):
    # Vectors generated with the TypeScript deriveScriptHashHex implementation.
    parameters = {
        name: {"type": "integer", "value": str(index + 1)} for index, name in enumerate(names)
    }
    assert (
        derive_script_hash_hex(
            {"script": {"type": "plutusV3", "code": CODE}, "parameters": parameters}
        )
        == expected
    )
