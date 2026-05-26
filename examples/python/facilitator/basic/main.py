"""x402 Facilitator Example.

FastAPI-based facilitator service that verifies and settles payments
on-chain for the x402 protocol.

Supports:
- EVM networks (Base Sepolia) via web3.py
- SVM networks (Solana Devnet) via solders

Run with: uvicorn main:app --port 4022
"""

import os
import sys

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from solders.keypair import Keypair

from x402 import x402Facilitator
from x402.mechanisms.evm import FacilitatorWeb3Signer
from x402.mechanisms.evm.exact import register_exact_evm_facilitator
from x402.mechanisms.svm import FacilitatorKeypairSigner
from x402.mechanisms.svm.exact import register_exact_svm_facilitator

# Load environment variables
load_dotenv()

# Configuration
PORT = int(os.environ.get("PORT", "4022"))

# Validate required environment variables
if not os.environ.get("EVM_PRIVATE_KEY"):
    print("❌ EVM_PRIVATE_KEY environment variable is required")
    sys.exit(1)

if not os.environ.get("SVM_PRIVATE_KEY"):
    print("❌ SVM_PRIVATE_KEY environment variable is required")
    sys.exit(1)

# Initialize the EVM signer from private key
evm_signer = FacilitatorWeb3Signer(
    private_key=os.environ["EVM_PRIVATE_KEY"],
    rpc_url=os.environ.get("EVM_RPC_URL", "https://sepolia.base.org"),
)
print(f"EVM Facilitator account: {evm_signer.get_addresses()[0]}")

# Initialize the SVM signer from private key
svm_keypair = Keypair.from_base58_string(os.environ["SVM_PRIVATE_KEY"])
svm_signer = FacilitatorKeypairSigner(svm_keypair)
print(f"SVM Facilitator account: {svm_signer.get_addresses()[0]}")


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


# Initialize the x402 Facilitator with EVM and SVM support
facilitator = (
    x402Facilitator()
    .on_before_verify(before_verify_hook)
    .on_after_verify(after_verify_hook)
    .on_verify_failure(verify_failure_hook)
    .on_before_settle(before_settle_hook)
    .on_after_settle(after_settle_hook)
    .on_settle_failure(settle_failure_hook)
)

# Register EVM and SVM schemes
register_exact_evm_facilitator(
    facilitator,
    evm_signer,
    networks="eip155:84532",  # Base Sepolia
    deploy_erc4337_with_eip6492=True,
)
register_exact_svm_facilitator(
    facilitator,
    svm_signer,
    networks="solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",  # Devnet
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
    title="x402 Facilitator",
    description="Verifies and settles x402 payments on-chain",
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

    print(f"Facilitator listening on port {PORT}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
