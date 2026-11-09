"""x402 Builder Code Facilitator Example.

FastAPI-based facilitator that verifies and settles payments and appends
ERC-8021 wallet attribution (``w``) at settlement via ``BuilderCodeFacilitatorExtension``.

Run with: uv run python main.py

Environment variables:
    EVM_PRIVATE_KEY: Required. Facilitator EVM key (pays gas / submits txs).
    FACILITATOR_BUILDER_CODE: Optional facilitator wallet builder code (``w``).
    EVM_RPC_URL: Optional. Defaults to https://sepolia.base.org.
    PORT: Optional. Defaults to 4022.
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from x402 import x402Facilitator
from x402.extensions.builder_code import BuilderCodeFacilitatorExtension
from x402.mechanisms.evm import FacilitatorWeb3Signer
from x402.mechanisms.evm.exact import register_exact_evm_facilitator

load_dotenv()

PORT = int(os.environ.get("PORT") or "4022")
EVM_NETWORK = "eip155:84532"

if not os.environ.get("EVM_PRIVATE_KEY"):
    print("EVM_PRIVATE_KEY environment variable is required")
    sys.exit(1)

evm_signer = FacilitatorWeb3Signer(
    private_key=os.environ["EVM_PRIVATE_KEY"],
    rpc_url=os.environ.get("EVM_RPC_URL", "https://sepolia.base.org"),
)
print(f"EVM Facilitator account: {evm_signer.get_addresses()[0]}")

facilitator = (
    x402Facilitator()
    .on_before_verify(lambda ctx: print(f"Before verify: {ctx}"))
    .on_after_verify(lambda ctx: print(f"After verify: {ctx}"))
    .on_verify_failure(lambda ctx: print(f"Verify failure: {ctx}"))
    .on_before_settle(lambda ctx: print(f"Before settle: {ctx}"))
    .on_after_settle(lambda ctx: print(f"After settle: {ctx}"))
    .on_settle_failure(lambda ctx: print(f"Settle failure: {ctx}"))
    .register_extension(
        BuilderCodeFacilitatorExtension(
            builder_code=os.environ.get("FACILITATOR_BUILDER_CODE"),
        )
    )
)

register_exact_evm_facilitator(
    facilitator,
    evm_signer,
    networks=EVM_NETWORK,
    eip6492_allowed_factories=[],
)


class VerifyRequest(BaseModel):
    paymentPayload: dict
    paymentRequirements: dict


class SettleRequest(BaseModel):
    paymentPayload: dict
    paymentRequirements: dict


app = FastAPI(
    title="x402 Builder Code Facilitator",
    description="Verifies and settles x402 payments with ERC-8021 builder-code attribution",
    version="2.0.0",
)


@app.post("/verify")
async def verify(request: VerifyRequest):
    try:
        from x402.schemas import PaymentRequirements, parse_payment_payload

        payload = parse_payment_payload(request.paymentPayload)
        requirements = PaymentRequirements.model_validate(request.paymentRequirements)
        response = await facilitator.verify(payload, requirements)
        return response.model_dump(by_alias=True, exclude_none=True)
    except Exception as e:
        print(f"Verify error: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/settle")
async def settle(request: SettleRequest):
    try:
        from x402.schemas import PaymentRequirements, parse_payment_payload

        payload = parse_payment_payload(request.paymentPayload)
        requirements = PaymentRequirements.model_validate(request.paymentRequirements)
        response = await facilitator.settle(payload, requirements)
        return response.model_dump(by_alias=True, exclude_none=True)
    except Exception as e:
        print(f"Settle error: {e}")

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
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    print(f"Facilitator listening on http://localhost:{PORT} (Base Sepolia)")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
