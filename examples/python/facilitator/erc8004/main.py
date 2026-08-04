"""x402 facilitator for the ERC-8004 ticket extension (mainnet fork demo).

Routes settlement through ``X402AgentReputation.settleAndMintTicket*`` when the
client echoes ``extensions.erc8004.agentId`` in the payment payload.

Run:
    cd examples/python/facilitator/erc8004
    uv sync
    uv run python main.py
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from x402 import x402Facilitator
from x402.extensions.erc8004 import ERC8004TicketFacilitatorExtension
from x402.mechanisms.evm import FacilitatorWeb3Signer
from x402.mechanisms.evm.exact import register_exact_evm_facilitator

load_dotenv()

PORT = int(os.environ.get("PORT", "4022"))
NETWORK = os.environ.get("NETWORK", "eip155:1")
WRAPPER_ADDRESS = os.environ.get("WRAPPER_ADDRESS")
EVM_PRIVATE_KEY = os.environ.get("EVM_PRIVATE_KEY")
EVM_RPC_URL = os.environ.get("EVM_RPC_URL", "http://127.0.0.1:8545")

if not EVM_PRIVATE_KEY:
    print("ERROR: EVM_PRIVATE_KEY is required. Run bootstrap_fork.py --write-env first.")
    sys.exit(1)
if not WRAPPER_ADDRESS:
    print("ERROR: WRAPPER_ADDRESS is required. Run bootstrap_fork.py --write-env first.")
    sys.exit(1)

evm_signer = FacilitatorWeb3Signer(private_key=EVM_PRIVATE_KEY, rpc_url=EVM_RPC_URL)
print(f"Facilitator account: {evm_signer.get_addresses()[0]}")
print(f"Network: {NETWORK}")
print(f"Wrapper: {WRAPPER_ADDRESS}")

facilitator = x402Facilitator()
register_exact_evm_facilitator(facilitator, evm_signer, networks=NETWORK)
facilitator.register_extension(
    ERC8004TicketFacilitatorExtension(wrappers={NETWORK: WRAPPER_ADDRESS})
)


class VerifyRequest(BaseModel):
    paymentPayload: dict
    paymentRequirements: dict


class SettleRequest(BaseModel):
    paymentPayload: dict
    paymentRequirements: dict


app = FastAPI(
    title="x402 ERC-8004 Facilitator",
    description="Verifies and settles x402 payments with ticket minting",
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

    print(f"Facilitator listening on port {PORT}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
