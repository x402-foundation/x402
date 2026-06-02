"""Facilitator with Discovery Extension Example.

Demonstrates how to create a facilitator with bazaar discovery extension that
catalogs discovered x402 resources.
"""

import os
import sys
import base64
import json
from datetime import UTC, datetime
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel
from solders.keypair import Keypair

from x402 import x402Facilitator
from x402.extensions.bazaar import (
    DiscoveryResource,
    extract_discovery_info,
)
from x402.mechanisms.evm import FacilitatorWeb3Signer
from x402.mechanisms.evm.exact.facilitator import ExactEvmScheme, ExactEvmSchemeConfig
from x402.mechanisms.svm import FacilitatorKeypairSigner
from x402.mechanisms.svm.exact.facilitator import ExactSvmScheme

# Load environment variables
load_dotenv()

# Configuration
PORT = int(os.environ.get("PORT", "4022"))

# Configuration - optional per network
evm_private_key = os.environ.get("EVM_PRIVATE_KEY")
svm_private_key = os.environ.get("SVM_PRIVATE_KEY")

# Validate at least one private key is provided
if not evm_private_key and not svm_private_key:
    print("❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required")
    sys.exit(1)

# Network configuration
EVM_NETWORK = "eip155:84532"  # Base Sepolia
SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"  # Solana Devnet


# BazaarCatalog stores discovered resources
class BazaarCatalog:
    """Catalog for storing discovered x402 resources."""

    def __init__(self) -> None:
        self.resources: dict[str, DiscoveryResource] = {}

    def add(self, resource: DiscoveryResource) -> None:
        """Add a resource to the catalog."""
        self.resources[resource.resource] = resource

    def get_all(self) -> list[DiscoveryResource]:
        """Get all resources in the catalog."""
        return list(self.resources.values())

    def search(
        self,
        query: str,
        resource_type: str | None = None,
        limit: int | None = None,
    ) -> list[DiscoveryResource]:
        """Search resources using case-insensitive keyword matching.

        Matches against resource URL, type, description, service metadata, and extensions.

        Args:
            query: The search query string.
            resource_type: Optional filter by resource type.
            limit: Optional advisory maximum results.

        Returns:
            Matching resources.
        """
        needle = query.lower()
        results = []
        for r in self.resources.values():
            haystack = " ".join(
                [
                    r.resource,
                    r.type,
                    r.description or "",
                    r.service_name or "",
                    *(r.tags or []),
                    *[str(v) for v in (r.extensions or {}).values()],
                ]
            ).lower()
            if needle in haystack:
                results.append(r)

        if resource_type:
            results = [r for r in results if r.type == resource_type]

        return results[:limit] if limit is not None else results


bazaar_catalog = BazaarCatalog()

EXTENSION_RESPONSES_HEADER = "EXTENSION-RESPONSES"


def _set_extension_responses_header(response: Response) -> None:
    """Attach an example bazaar extension response header for client readback."""
    extension_responses = {"bazaar": {"status": "success"}}
    encoded = base64.b64encode(json.dumps(extension_responses).encode("utf-8")).decode("ascii")
    response.headers[EXTENSION_RESPONSES_HEADER] = encoded

# Initialize signers based on available keys
evm_signer = None
svm_signer = None

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


def _handle_after_verify(ctx: Any) -> None:
    """Handle after verify hook - extract discovery info and catalog."""
    print("✅ Payment verified")

    # Extract discovered resource from payment for bazaar catalog
    try:
        discovered = extract_discovery_info(
            ctx.payment_payload,
            ctx.requirements,
            validate=True,
        )

        if discovered:
            print(f"   📝 Discovered resource: {discovered.resource_url}")
            print(f"   📝 Method: {discovered.method}")
            print(f"   📝 X402Version: {discovered.x402_version}")
            if discovered.service_name is not None:
                print(f"   📝 Service: {discovered.service_name}")
            if discovered.tags is not None:
                print(f"   📝 Tags: {', '.join(discovered.tags)}")

            bazaar_catalog.add(
                DiscoveryResource(
                    resource=discovered.resource_url,
                    type=discovered.discovery_info.input.type,
                    x402_version=discovered.x402_version,
                    accepts=[
                        ctx.requirements.model_dump(by_alias=True)
                        if hasattr(ctx.requirements, "model_dump")
                        else ctx.requirements
                    ],
                    last_updated=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                    description=discovered.description,
                    mime_type=discovered.mime_type,
                    service_name=discovered.service_name,
                    tags=discovered.tags,
                    icon_url=discovered.icon_url,
                    extensions=discovered.extensions,
                )
            )
            print("   ✅ Added to bazaar catalog")
    except Exception as err:
        print(f"   ⚠️  Failed to extract discovery info: {err}")


# Initialize the x402 Facilitator with discovery hooks
facilitator = (
    x402Facilitator()
    .on_before_verify(lambda ctx: print("Before verify", ctx))
    .on_after_verify(lambda ctx: _handle_after_verify(ctx))
    .on_verify_failure(lambda ctx: print("Verify failure", ctx))
    .on_before_settle(lambda ctx: print("Before settle", ctx))
    .on_after_settle(lambda ctx: print(f"🎉 Payment settled: {ctx.result.transaction}"))
    .on_settle_failure(lambda ctx: print("Settle failure", ctx))
)

# Register schemes based on available signers
if evm_signer:
    config = ExactEvmSchemeConfig(
        # Add trusted ERC-6492 factory addresses here (e.g. your chosen ERC-4337 smart wallet factory).
        # A non-empty list enables smart wallet deployment; an empty list denies all factory calls.
        eip6492_allowed_factories=[],
    )
    facilitator.register([EVM_NETWORK], ExactEvmScheme(evm_signer, config))

if svm_signer:
    facilitator.register([SVM_NETWORK], ExactSvmScheme(svm_signer))


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
    title="Discovery Facilitator",
    description="Verifies and settles x402 payments with bazaar discovery",
    version="2.0.0",
)


@app.post("/verify")
async def verify(request: VerifyRequest, http_response: Response):
    """Verify a payment against requirements.

    Note: Payment tracking and bazaar discovery are handled by lifecycle hooks.

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

        # Hooks will automatically:
        # - Track verified payment (on_after_verify)
        # - Extract and catalog discovery info (on_after_verify)
        verify_result = await facilitator.verify(payload, requirements)

        _set_extension_responses_header(http_response)
        return verify_result.model_dump(by_alias=True, exclude_none=True)
    except Exception as e:
        print(f"Verify error: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/settle")
async def settle(request: SettleRequest, http_response: Response):
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

        settle_result = await facilitator.settle(payload, requirements)

        _set_extension_responses_header(http_response)
        return settle_result.model_dump(by_alias=True, exclude_none=True)
    except Exception as e:
        print(f"Settle error: {e}")

        # Check if this was an abort from hook
        if "aborted" in str(e).lower() or "Settlement aborted" in str(e):
            from x402.schemas import SettleResponse

            abort = SettleResponse(
                success=False,
                error_reason=str(e).replace("Settlement aborted: ", ""),
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


@app.get("/discovery/resources")
async def discovery_resources():
    """List all discovered resources from bazaar.

    Returns:
        Discovery response with x402Version, items, and pagination.
    """
    try:
        resources = bazaar_catalog.get_all()
        return {
            "x402Version": 2,
            "items": [r.to_dict() for r in resources],
            "pagination": {
                "limit": 100,
                "offset": 0,
                "total": len(resources),
            },
        }
    except Exception as e:
        print(f"Discovery error: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/discovery/search")
async def discovery_search(query: str, type: str | None = None, limit: int | None = None):
    """Search discovered resources using keyword matching.

    Args:
        query: The search query string.
        type: Optional filter by resource type.
        limit: Optional advisory maximum number of results.

    Returns:
        Search response with x402Version, items, and optional pagination hints.
    """
    try:
        results = bazaar_catalog.search(query, type, limit)
        return {
            "x402Version": 2,
            "resources": [r.to_dict() for r in results],
            "partialResults": False,
            "pagination": None,
        }
    except Exception as e:
        print(f"Discovery search error: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    supported_networks = [k.network for k in facilitator.get_supported().kinds]
    print(f"🚀 Discovery Facilitator listening on http://0.0.0.0:{PORT}")
    print(f"   Supported networks: {', '.join(supported_networks)}")
    print("   Discovery endpoint: GET /discovery/resources")
    print()
    uvicorn.run(app, host="0.0.0.0", port=PORT)
