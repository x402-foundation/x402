"""x402 batch-settlement facilitator example.

FastAPI-based facilitator that verifies and settles batch-settlement EVM
payments on Base Sepolia. Use it alongside the batch-settlement server
and client examples in this repo.

Run with:
    uv sync && uv run uvicorn main:app --port 4022

Environment variables:
    EVM_PRIVATE_KEY                        Required. Facilitator EVM key (pays gas / submits txs).
    EVM_RPC_URL                            Optional. Defaults to https://sepolia.base.org.
    EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY    Optional. Receiver-authorizer key (defaults to EVM_PRIVATE_KEY).
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from x402 import x402Facilitator
from x402.mechanisms.evm import FacilitatorWeb3Signer
from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
from x402.mechanisms.evm.batch_settlement.facilitator import (
    BatchSettlementEvmFacilitator,
)

load_dotenv()

PORT = int(os.environ.get("PORT", "4022"))
EVM_NETWORK = "eip155:84532"

if not os.environ.get("EVM_PRIVATE_KEY"):
    print("EVM_PRIVATE_KEY is required")
    sys.exit(1)

evm_signer = FacilitatorWeb3Signer(
    private_key=os.environ["EVM_PRIVATE_KEY"],
    rpc_url=os.environ.get("EVM_RPC_URL", "https://sepolia.base.org"),
)
print(f"EVM Facilitator account: {evm_signer.get_addresses()[0]}")

receiver_authorizer_pk = (
    os.environ.get("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY") or os.environ["EVM_PRIVATE_KEY"]
)
authorizer_signer = LocalAuthorizerSigner(receiver_authorizer_pk)
print(f"Receiver authorizer: {authorizer_signer.address}")

facilitator = (
    x402Facilitator()
    .on_before_verify(lambda ctx: print(f"Before verify: {ctx}"))
    .on_after_verify(lambda ctx: print(f"After verify: {ctx}"))
    .on_verify_failure(lambda ctx: print(f"Verify failure: {ctx}"))
    .on_before_settle(lambda ctx: print(f"Before settle: {ctx}"))
    .on_after_settle(lambda ctx: print(f"After settle: {ctx}"))
    .on_settle_failure(lambda ctx: print(f"Settle failure: {ctx}"))
)
facilitator.register(
    [EVM_NETWORK],
    BatchSettlementEvmFacilitator(evm_signer, authorizer_signer),
)


class VerifyRequest(BaseModel):
    paymentPayload: dict
    paymentRequirements: dict


class SettleRequest(BaseModel):
    paymentPayload: dict
    paymentRequirements: dict


app = FastAPI(
    title="x402 Batch-Settlement Facilitator",
    description="Verifies and settles batch-settlement EVM payments",
    version="2.0.0",
)


@app.post("/verify")
async def verify(request: VerifyRequest):
    try:
        from x402.schemas import parse_payment_payload, parse_payment_requirements

        payload = parse_payment_payload(request.paymentPayload)
        requirements = parse_payment_requirements(
            payload.x402_version, request.paymentRequirements
        )
        response = await facilitator.verify(payload, requirements)
        return response.model_dump(by_alias=True, exclude_none=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/settle")
async def settle(request: SettleRequest):
    try:
        from x402.schemas import parse_payment_payload, parse_payment_requirements

        payload = parse_payment_payload(request.paymentPayload)
        requirements = parse_payment_requirements(
            payload.x402_version, request.paymentRequirements
        )
        response = await facilitator.settle(payload, requirements)
        return response.model_dump(by_alias=True, exclude_none=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/supported")
async def supported():
    response = facilitator.get_supported()
    return {
        "kinds": [k.model_dump(by_alias=True, exclude_none=True) for k in response.kinds],
        "extensions": response.extensions,
        "signers": response.signers,
    }


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    print(f"Batch-settlement facilitator listening on port {PORT}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
