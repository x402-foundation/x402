"""All Networks Facilitator Example.

Demonstrates how to create a facilitator that supports all available networks with
optional chain configuration via environment variables.

New chain support should be added here in alphabetic order by network prefix
(e.g., "eip155" before "solana" before "tvm").
"""

import os
import sys

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from solders.keypair import Keypair

from x402 import x402Facilitator
from x402.mechanisms.evm import FacilitatorWeb3Signer
from x402.mechanisms.evm.exact.facilitator import ExactEvmScheme, ExactEvmSchemeConfig
from x402.mechanisms.svm import FacilitatorKeypairSigner
from x402.mechanisms.svm.exact.facilitator import ExactSvmScheme
from x402.mechanisms.tvm import (
    TVM_PROVIDER_TONAPI,
    TVM_TESTNET,
    FacilitatorHighloadV3Signer,
    HighloadV3Config,
)
from x402.mechanisms.tvm.exact.facilitator import ExactTvmScheme

# Load environment variables
load_dotenv()

# Configuration
PORT = int(os.environ.get("PORT", "4022"))

# Configuration - optional per network
evm_private_key = os.environ.get("EVM_PRIVATE_KEY")
svm_private_key = os.environ.get("SVM_PRIVATE_KEY")
tvm_private_key = os.environ.get("TVM_PRIVATE_KEY")

# Validate at least one private key is provided
if not evm_private_key and not svm_private_key and not tvm_private_key:
    print("❌ At least one of EVM_PRIVATE_KEY, SVM_PRIVATE_KEY, or TVM_PRIVATE_KEY is required")
    sys.exit(1)

# Network configuration
EVM_NETWORK = os.environ.get("EVM_NETWORK", "eip155:84532")  # Base Sepolia
SVM_NETWORK = os.environ.get("SVM_NETWORK", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")
TVM_NETWORK = os.environ.get("TVM_NETWORK", TVM_TESTNET)

# Initialize signers based on available keys
evm_signer = None
svm_signer = None
tvm_signer = None

if evm_private_key:
    evm_signer = FacilitatorWeb3Signer(
        private_key=evm_private_key,
        rpc_url=os.environ.get("EVM_RPC_URL", "https://sepolia.base.org"),
    )
    print(f"EVM Facilitator account: {evm_signer.get_addresses()[0]}")

if svm_private_key:
    svm_keypair = Keypair.from_base58_string(svm_private_key)
    svm_signer = FacilitatorKeypairSigner(svm_keypair)
    print(f"SVM Facilitator account: {svm_signer.get_addresses()[0]}")

if tvm_private_key:
    tvm_config = HighloadV3Config.from_private_key(tvm_private_key)
    tvm_provider = (os.environ.get("TVM_PROVIDER") or "").strip().lower()
    tvm_config.provider = tvm_provider or tvm_config.provider
    tvm_config.api_key = (
        os.environ.get("TONAPI_API_KEY")
        if tvm_provider == TVM_PROVIDER_TONAPI
        else os.environ.get("TONCENTER_API_KEY")
    )
    tvm_config.provider_base_url = (
        os.environ.get("TONAPI_BASE_URL")
        if tvm_provider == TVM_PROVIDER_TONAPI
        else os.environ.get("TONCENTER_BASE_URL")
    )
    tvm_signer = FacilitatorHighloadV3Signer({TVM_NETWORK: tvm_config})
    print(f"TVM Facilitator account: {tvm_signer.get_addresses()[0]}")


# Async hook functions for the facilitator
async def before_verify_hook(ctx):
    print(f"Before verify: {ctx.payment_payload}")


async def after_verify_hook(ctx):
    print(f"After verify: {ctx.result}")


async def verify_failure_hook(ctx):
    print(f"Verify failure: {ctx.error}")


async def before_settle_hook(ctx):
    print(f"Before settle: {ctx.payment_payload}")


async def after_settle_hook(ctx):
    print(f"After settle: {ctx.result}")


async def settle_failure_hook(ctx):
    print(f"Settle failure: {ctx.error}")


# Initialize the x402 Facilitator
facilitator = (
    x402Facilitator()
    .on_before_verify(before_verify_hook)
    .on_after_verify(after_verify_hook)
    .on_verify_failure(verify_failure_hook)
    .on_before_settle(before_settle_hook)
    .on_after_settle(after_settle_hook)
    .on_settle_failure(settle_failure_hook)
)

# Register schemes based on available signers
if evm_signer:
    config = ExactEvmSchemeConfig(deploy_erc4337_with_eip6492=True)
    facilitator.register([EVM_NETWORK], ExactEvmScheme(evm_signer, config))

if svm_signer:
    facilitator.register([SVM_NETWORK], ExactSvmScheme(svm_signer))
if tvm_signer:
    facilitator.register(
        [TVM_NETWORK],
        ExactTvmScheme(tvm_signer),
    )


# Pydantic models for request/response
class VerifyRequest(BaseModel):
    """Verify endpoint request body."""

    paymentPayload: dict
    paymentRequirements: dict


class SettleRequest(BaseModel):
    """Settle endpoint request body."""

    paymentPayload: dict
    paymentRequirements: dict


# Initialize FastAPI app
app = FastAPI(
    title="All Networks Facilitator",
    description="Verifies and settles x402 payments on-chain with optional EVM/SVM/TVM support",
    version="2.0.0",
)


@app.post("/verify")
async def verify(request: VerifyRequest):
    """Verify a payment against requirements.

    Args:
        request: Payment payload and requirements to verify.

    Returns:
        VerifyResponse with isValid and payer (if valid) or invalidReason.
    """
    try:
        from x402.schemas import PaymentRequirements, parse_payment_payload

        # Parse payload (auto-detects V1/V2) and requirements
        payload = parse_payment_payload(request.paymentPayload)
        requirements = PaymentRequirements.model_validate(request.paymentRequirements)

        # Verify payment (await async method)
        response = await facilitator.verify(payload, requirements)

        return response.model_dump(by_alias=True, exclude_none=True)
    except Exception as e:
        print(f"Verify error: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/settle")
async def settle(request: SettleRequest):
    """Settle a payment on-chain.

    Args:
        request: Payment payload and requirements to settle.

    Returns:
        SettleResponse with success, transaction, network, and payer.
    """
    try:
        from x402.schemas import PaymentRequirements, parse_payment_payload

        # Parse payload (auto-detects V1/V2) and requirements
        payload = parse_payment_payload(request.paymentPayload)
        requirements = PaymentRequirements.model_validate(request.paymentRequirements)

        # Settle payment (await async method)
        response = await facilitator.settle(payload, requirements)

        return response.model_dump(by_alias=True, exclude_none=True)
    except Exception as e:
        print(f"Settle error: {e}")

        # Check if this was an abort from hook
        if "aborted" in str(e).lower():
            from x402.schemas import SettleResponse

            abort = SettleResponse(
                success=False,
                error_reason=str(e),
                network=request.paymentPayload.get("accepted", {}).get("network", "unknown"),
                transaction="",
            )
            return abort.model_dump(by_alias=True, exclude_none=True)

        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/supported")
async def supported():
    """Get supported payment kinds and extensions.

    Returns:
        SupportedResponse with kinds, extensions, and signers.
    """
    try:
        response = facilitator.get_supported()

        return {
            "kinds": [k.model_dump(by_alias=True, exclude_none=True) for k in response.kinds],
            "extensions": response.extensions,
            "signers": response.signers,
        }
    except Exception as e:
        print(f"Supported error: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    supported_networks = [k.network for k in facilitator.get_supported().kinds]
    print(f"🚀 All Networks Facilitator listening on http://0.0.0.0:{PORT}")
    print(f"   Supported networks: {', '.join(supported_networks)}")
    print()
    uvicorn.run(app, host="0.0.0.0", port=PORT)
