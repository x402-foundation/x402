"""EVM client implementation for the Upto payment scheme."""

from __future__ import annotations

from typing import Any

from ....schemas import PaymentRequirements
from ..constants import (
    ERC20_ALLOWANCE_ABI,
    PERMIT2_ADDRESS,
    SCHEME_UPTO,
    UPTO_PERMIT2_WITNESS_TYPES,
    X402_UPTO_PERMIT2_PROXY_ADDRESS,
)
from ..signer import (
    ClientEvmSigner,
    ClientEvmSignerWithReadContract,
    ClientEvmSignerWithSignTransaction,
)
from ..types import (
    ExactPermit2TokenPermissions,
    TypedDataField,
    UptoPermit2Authorization,
    UptoPermit2Payload,
    UptoPermit2Witness,
)
from ..utils import (
    create_permit2_nonce,
    get_evm_chain_id,
    normalize_address,
)


def _wrap_if_local_account(signer: Any) -> ClientEvmSigner:
    """Auto-wrap eth_account LocalAccount in EthAccountSigner if needed."""
    try:
        from eth_account.signers.local import LocalAccount

        if isinstance(signer, LocalAccount):
            from ..signers import EthAccountSigner

            return EthAccountSigner(signer)
    except ImportError:
        pass
    return signer


class UptoEvmScheme:
    """EVM client implementation for the Upto payment scheme.

    Always uses Permit2 with an upto-specific witness that includes a facilitator field.

    Attributes:
        scheme: The scheme identifier ("upto").
    """

    scheme = SCHEME_UPTO

    def __init__(self, signer: ClientEvmSigner):
        self._signer = _wrap_if_local_account(signer)

    def create_payment_payload(
        self,
        requirements: PaymentRequirements,
        extensions: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create signed upto Permit2 payment payload.

        Requires requirements.extra to contain 'facilitatorAddress'.
        """
        result = _create_upto_permit2_payload(self._signer, requirements)

        if extensions:
            ext_data = self._try_sign_extensions(requirements, result, extensions)
            if ext_data:
                result["__extensions"] = ext_data

        return result

    def _try_sign_extensions(
        self,
        requirements: PaymentRequirements,
        result: dict[str, Any],
        extensions: dict[str, Any],
    ) -> dict[str, Any] | None:
        eip2612_ext = self._try_sign_eip2612(requirements, result, extensions)
        if eip2612_ext:
            return eip2612_ext

        erc20_ext = self._try_sign_erc20_approval(requirements, extensions)
        if erc20_ext:
            return erc20_ext

        return None

    def _try_sign_eip2612(
        self,
        requirements: PaymentRequirements,
        result: dict[str, Any],
        extensions: dict[str, Any],
    ) -> dict[str, Any] | None:
        from ....extensions.eip2612_gas_sponsoring import EIP2612_GAS_SPONSORING_KEY
        from ....extensions.eip2612_gas_sponsoring.client import sign_eip2612_permit

        if EIP2612_GAS_SPONSORING_KEY not in extensions:
            return None

        if not isinstance(self._signer, ClientEvmSignerWithReadContract):
            return None

        extra = requirements.extra or {}
        token_name = extra.get("name")
        token_version = extra.get("version")
        if not token_name or not token_version:
            return None

        chain_id = get_evm_chain_id(str(requirements.network))
        token_address = normalize_address(requirements.asset)

        try:
            allowance = self._signer.read_contract(
                token_address,
                ERC20_ALLOWANCE_ABI,
                "allowance",
                self._signer.address,
                PERMIT2_ADDRESS,
            )
            if int(allowance) >= int(requirements.amount):
                return None
        except Exception:
            pass

        permit2_auth = result.get("permit2Authorization", {})
        deadline = permit2_auth.get("deadline", "")
        if not deadline:
            import time

            deadline = str(int(time.time()) + (requirements.max_timeout_seconds or 3600))

        info = sign_eip2612_permit(
            self._signer,
            token_address,
            token_name,
            token_version,
            chain_id,
            deadline,
            requirements.amount,
        )

        return {EIP2612_GAS_SPONSORING_KEY: {"info": info.to_dict()}}

    def _try_sign_erc20_approval(
        self,
        requirements: PaymentRequirements,
        extensions: dict[str, Any],
    ) -> dict[str, Any] | None:
        from ....extensions.erc20_approval_gas_sponsoring import (
            ERC20_APPROVAL_GAS_SPONSORING_KEY,
        )
        from ....extensions.erc20_approval_gas_sponsoring.client import (
            sign_erc20_approval_transaction,
        )

        if ERC20_APPROVAL_GAS_SPONSORING_KEY not in extensions:
            return None

        if not isinstance(self._signer, ClientEvmSignerWithSignTransaction):
            return None

        chain_id = get_evm_chain_id(str(requirements.network))
        token_address = normalize_address(requirements.asset)

        if isinstance(self._signer, ClientEvmSignerWithReadContract):
            try:
                allowance = self._signer.read_contract(
                    token_address,
                    ERC20_ALLOWANCE_ABI,
                    "allowance",
                    self._signer.address,
                    PERMIT2_ADDRESS,
                )
                if int(allowance) >= int(requirements.amount):
                    return None
            except Exception:
                pass

        info = sign_erc20_approval_transaction(
            self._signer,
            token_address,
            chain_id,
        )

        return {ERC20_APPROVAL_GAS_SPONSORING_KEY: {"info": info.to_dict()}}


def _create_upto_permit2_payload(
    signer: ClientEvmSigner,
    requirements: PaymentRequirements,
) -> dict[str, Any]:
    """Create a signed upto Permit2 PermitWitnessTransferFrom payload."""
    import time

    extra = requirements.extra or {}
    facilitator_address = extra.get("facilitatorAddress")
    if not facilitator_address:
        raise ValueError(
            "upto scheme requires facilitatorAddress in paymentRequirements.extra. "
            "Ensure the server is configured with an upto facilitator that provides getExtra()."
        )

    now = int(time.time())
    nonce = create_permit2_nonce()
    valid_after = str(now - 600)
    deadline = str(now + (requirements.max_timeout_seconds or 3600))
    if int(deadline) <= int(valid_after):
        raise ValueError(
            f"Invalid time window: deadline ({deadline}) must be after validAfter ({valid_after}). "
            f"Check that max_timeout_seconds ({requirements.max_timeout_seconds}) is positive."
        )

    permit2_authorization = UptoPermit2Authorization(
        from_address=signer.address,
        permitted=ExactPermit2TokenPermissions(
            token=normalize_address(requirements.asset),
            amount=requirements.amount,
        ),
        spender=X402_UPTO_PERMIT2_PROXY_ADDRESS,
        nonce=nonce,
        deadline=deadline,
        witness=UptoPermit2Witness(
            to=normalize_address(requirements.pay_to),
            facilitator=normalize_address(facilitator_address),
            valid_after=valid_after,
        ),
    )

    signature = _sign_upto_permit2_authorization(signer, permit2_authorization, requirements)

    payload = UptoPermit2Payload(
        permit2_authorization=permit2_authorization,
        signature=signature,
    )
    return payload.to_dict()


def _sign_upto_permit2_authorization(
    signer: ClientEvmSigner,
    permit2_authorization: UptoPermit2Authorization,
    requirements: PaymentRequirements,
) -> str:
    """Sign an upto Permit2 PermitWitnessTransferFrom using EIP-712."""
    chain_id = get_evm_chain_id(str(requirements.network))
    domain_dict, typed_fields, primary_type, message = _build_upto_permit2_typed_data(
        permit2_authorization, chain_id
    )

    sig_bytes = signer.sign_typed_data(
        domain_dict,  # type: ignore[arg-type]
        typed_fields,
        primary_type,
        message,
    )
    return "0x" + sig_bytes.hex()


def _build_upto_permit2_typed_data(
    permit2_authorization: UptoPermit2Authorization,
    chain_id: int,
) -> tuple[dict[str, Any], dict[str, list[TypedDataField]], str, dict[str, Any]]:
    """Build EIP-712 typed data for upto Permit2 signature."""
    from ..constants import PERMIT2_ADDRESS

    domain_dict: dict[str, Any] = {
        "name": "Permit2",
        "chainId": chain_id,
        "verifyingContract": PERMIT2_ADDRESS,
    }

    message = {
        "permitted": {
            "token": permit2_authorization.permitted.token,
            "amount": int(permit2_authorization.permitted.amount),
        },
        "spender": permit2_authorization.spender,
        "nonce": int(permit2_authorization.nonce),
        "deadline": int(permit2_authorization.deadline),
        "witness": {
            "to": permit2_authorization.witness.to,
            "facilitator": permit2_authorization.witness.facilitator,
            "validAfter": int(permit2_authorization.witness.valid_after),
        },
    }

    typed_fields: dict[str, list[TypedDataField]] = {
        type_name: [TypedDataField(name=f["name"], type=f["type"]) for f in fields]
        for type_name, fields in UPTO_PERMIT2_WITNESS_TYPES.items()
    }

    return domain_dict, typed_fields, "PermitWitnessTransferFrom", message
