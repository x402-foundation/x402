"""Tests for EVM gas sponsoring extension signing."""

try:
    from eth_account import Account
except ImportError:
    import pytest

    pytest.skip("EVM client requires eth_account", allow_module_level=True)

from x402.extensions.eip2612_gas_sponsoring import EIP2612_GAS_SPONSORING_KEY
from x402.extensions.erc20_approval_gas_sponsoring import ERC20_APPROVAL_GAS_SPONSORING_KEY
from x402.mechanisms.evm.constants import PERMIT2_ADDRESS
from x402.mechanisms.evm.gas_sponsoring import try_sign_gas_sponsoring_extensions
from x402.mechanisms.evm.signer import _reset_sponsoring_warnings
from x402.mechanisms.evm.signers import EthAccountSigner
from x402.schemas import PaymentRequirements

ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
BOTH = {EIP2612_GAS_SPONSORING_KEY: {}, ERC20_APPROVAL_GAS_SPONSORING_KEY: {}}


class _ReadSigner(EthAccountSigner):
    """Reads `allowance` as the given value, or raises when it is an exception."""

    def __init__(self, allowance: int | Exception):
        super().__init__(Account.create())
        self.allowance = allowance
        self.allowance_reads: list[tuple] = []

    def read_contract(self, address: str, abi: list, function_name: str, *args: object) -> int:
        if function_name == "nonces":
            return 3
        self.allowance_reads.append((address, *args))
        if isinstance(self.allowance, Exception):
            raise self.allowance
        return self.allowance


class _ReadTxSigner(_ReadSigner):
    def sign_transaction(self, tx: dict) -> str:
        return "0x02ab"

    def get_transaction_count(self, address: str) -> int:
        return 0


def _requirements(*, name: str | None = "USDC", version: str | None = "2") -> PaymentRequirements:
    extra: dict = {"assetTransferMethod": "permit2"}
    if name is not None:
        extra["name"] = name
    if version is not None:
        extra["version"] = version
    return PaymentRequirements(
        scheme="exact",
        network="eip155:84532",
        amount="1000",
        asset=ASSET,
        pay_to="0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        max_timeout_seconds=60,
        extra=extra,
    )


def test_signs_eip2612_permit_when_allowance_is_insufficient():
    signer = _ReadTxSigner(allowance=999)

    ext = try_sign_gas_sponsoring_extensions(
        signer, _requirements(), {"permit2Authorization": {"deadline": "1700000060"}}, BOTH
    )

    info = ext[EIP2612_GAS_SPONSORING_KEY]["info"]
    assert list(ext) == [EIP2612_GAS_SPONSORING_KEY]
    assert info["from"] == signer.address
    assert info["spender"] == PERMIT2_ADDRESS
    assert info["amount"] == "1000"
    assert info["nonce"] == "3"
    assert info["deadline"] == "1700000060"
    assert signer.allowance_reads == [(ASSET, signer.address, PERMIT2_ADDRESS)]


def test_skips_both_extensions_when_allowance_is_sufficient():
    signer = _ReadTxSigner(allowance=1000)

    ext = try_sign_gas_sponsoring_extensions(signer, _requirements(), {}, BOTH)

    assert ext is None
    assert len(signer.allowance_reads) == 2


def test_skips_extensions_the_server_does_not_advertise():
    signer = _ReadTxSigner(allowance=0)

    ext = try_sign_gas_sponsoring_extensions(signer, _requirements(name=None), {}, BOTH)
    none_advertised = try_sign_gas_sponsoring_extensions(signer, _requirements(), {}, {"other": {}})

    assert list(ext) == [ERC20_APPROVAL_GAS_SPONSORING_KEY]
    assert none_advertised is None
    assert signer.allowance_reads == [(ASSET, signer.address, PERMIT2_ADDRESS)]


def test_signs_when_allowance_read_fails():
    signer = _ReadSigner(allowance=RuntimeError("rpc down"))

    ext = try_sign_gas_sponsoring_extensions(
        signer, _requirements(), {}, {EIP2612_GAS_SPONSORING_KEY: {}}
    )

    assert EIP2612_GAS_SPONSORING_KEY in ext


def test_falls_back_to_erc20_approval_without_token_name_and_version():
    signer = _ReadTxSigner(allowance=0)

    ext = try_sign_gas_sponsoring_extensions(
        signer, _requirements(name=None, version=None), {}, BOTH
    )

    info = ext[ERC20_APPROVAL_GAS_SPONSORING_KEY]["info"]
    assert list(ext) == [ERC20_APPROVAL_GAS_SPONSORING_KEY]
    assert info["from"] == signer.address
    assert info["asset"] == ASSET
    assert info["spender"] == PERMIT2_ADDRESS
    assert info["signedTransaction"] == "0x02ab"


def test_skips_erc20_approval_when_signer_cannot_sign_transactions():
    ext = try_sign_gas_sponsoring_extensions(
        _ReadSigner(allowance=0),
        _requirements(name=None, version=None),
        {},
        {ERC20_APPROVAL_GAS_SPONSORING_KEY: {}},
    )

    assert ext is None


def test_warns_once_when_signer_cannot_read(caplog):
    _reset_sponsoring_warnings()

    with caplog.at_level("WARNING", logger="x402.mechanisms.evm.signer"):
        ext = try_sign_gas_sponsoring_extensions(
            EthAccountSigner(Account.create()),
            _requirements(),
            {},
            {EIP2612_GAS_SPONSORING_KEY: {}},
        )

    assert ext is None
    assert ["cannot read the chain" in r.getMessage() for r in caplog.records] == [True]
