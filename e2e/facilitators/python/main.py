"""x402 Python Facilitator for E2E Testing.

FastAPI-based facilitator service that verifies and settles payments
on-chain for the x402 protocol.

Supports:
- EVM networks (Base Sepolia) via web3.py
- SVM networks (Solana Devnet) via solders
- TVM networks (TON testnet/mainnet) via pytoniq + Toncenter/TonAPI
- Bazaar discovery extension for resource cataloging
- EIP-2612 gas sponsoring extension (gasless Permit2 approval via permit)
- ERC-20 approval gas sponsoring extension (gasless Permit2 via signed tx relay)
- V1 and V2 protocol versions

Run with: uv run uvicorn main:app --port 4022
"""

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s: %(message)s")
logging.getLogger("x402.permit2").setLevel(logging.DEBUG)
logging.getLogger("x402.signers").setLevel(logging.DEBUG)

from bazaar import BazaarCatalog
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from solders.keypair import Keypair

from x402 import x402Facilitator
from datetime import datetime, timezone

from x402.extensions.bazaar import DiscoveryResource, extract_discovery_info
from x402.extensions.eip2612_gas_sponsoring import EIP2612_GAS_SPONSORING
from x402.extensions.erc20_approval_gas_sponsoring import (
    Erc20ApprovalFacilitatorExtension,
    WriteContractCall,
)
from x402.mechanisms.evm import FacilitatorWeb3Signer
from x402.mechanisms.evm.constants import TX_STATUS_SUCCESS
from x402.mechanisms.evm.exact import register_exact_evm_facilitator
from x402.mechanisms.evm.types import TransactionReceipt
from x402.mechanisms.evm.upto import UptoEvmFacilitatorScheme
from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
from x402.mechanisms.evm.batch_settlement.facilitator import (
    BatchSettlementEvmFacilitator,
)
from x402.mechanisms.svm import FacilitatorKeypairSigner
from x402.mechanisms.svm.exact import register_exact_svm_facilitator
from x402.mechanisms.tvm import (
    TVM_PROVIDER_TONAPI,
    HighloadV3Config,
    FacilitatorHighloadV3Signer,
)
from x402.mechanisms.tvm.exact import ExactTvmFacilitatorScheme


def _catalog_testnet_caip2(network_id: str) -> str:
    """Read testnet.caip2 from e2e/config/mechanisms_<id>.json."""
    injected = os.getenv("E2E_MECHANISMS_CATALOG")
    candidates: list[Path] = []
    if injected:
        candidates.append(Path(injected))
    here = Path(__file__).resolve()
    candidates.extend(parent / "config" for parent in here.parents)
    for catalog_dir in candidates:
        path = catalog_dir / f"mechanisms_{network_id}.json"
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            return data["testnet"]["caip2"]
    raise FileNotFoundError(f"Could not locate mechanisms_{network_id}.json")


def _resolve_network_caip2(network_id: str) -> str:
    env_key = f"{network_id.upper()}_NETWORK"
    return os.environ.get(env_key) or _catalog_testnet_caip2(network_id)


def _caip2_pattern(caip2: str) -> str:
    """Derive a CAIP-2 namespace wildcard (`eip155:*`) from a concrete CAIP-2 id."""
    ns = caip2.split(":", 1)[0]
    if not ns:
        raise ValueError(f"invalid caip2: {caip2}")
    return f"{ns}:*"


def _network_caip2_pattern(network_id: str) -> str:
    """Client/resource-server registration pattern for a catalog network id."""
    return _caip2_pattern(_resolve_network_caip2(network_id))


# Configuration
PORT = int(os.environ.get("PORT", "4022"))

# Initialize bazaar catalog
bazaar_catalog = BazaarCatalog()

# Validate that at least one chain is configured
if not any(
    [
        os.environ.get("FACILITATOR_EVM_PRIVATE_KEY"),
        os.environ.get("FACILITATOR_SVM_PRIVATE_KEY"),
        os.environ.get("FACILITATOR_TVM_PRIVATE_KEY"),
    ]
):
    print(
        "❌ At least one of FACILITATOR_EVM_PRIVATE_KEY, FACILITATOR_SVM_PRIVATE_KEY, or FACILITATOR_TVM_PRIVATE_KEY is required"
    )
    sys.exit(1)

# Network configuration — harness-injected `${ID}_NETWORK` or catalog testnet
EVM_NETWORK = _resolve_network_caip2("evm")
SVM_NETWORK = _resolve_network_caip2("svm")
TVM_NETWORK = _resolve_network_caip2("tvm")

# Initialize the EVM signer from private key when configured
evm_signer = None
if os.environ.get("FACILITATOR_EVM_PRIVATE_KEY"):
    evm_rpc_url = os.environ.get("EVM_RPC_URL") or "https://sepolia.base.org"
    evm_signer = FacilitatorWeb3Signer(
        private_key=os.environ["FACILITATOR_EVM_PRIVATE_KEY"],
        rpc_url=evm_rpc_url,
    )
    print(f"EVM Facilitator account: {evm_signer.get_addresses()[0]}")

# Initialize the SVM signer from private key when configured
svm_signer = None
if os.environ.get("FACILITATOR_SVM_PRIVATE_KEY"):
    svm_keypair = Keypair.from_base58_string(os.environ["FACILITATOR_SVM_PRIVATE_KEY"])
    svm_signer = FacilitatorKeypairSigner(svm_keypair)
    print(f"SVM Facilitator account: {svm_signer.get_addresses()[0]}")

# Initialize the TVM signer from private key when configured
tvm_signer = None
if os.environ.get("FACILITATOR_TVM_PRIVATE_KEY"):
    tvm_config = HighloadV3Config.from_private_key(os.environ["FACILITATOR_TVM_PRIVATE_KEY"])
    tvm_provider = (os.environ.get("TVM_PROVIDER") or "").strip().lower()
    tvm_config.provider = tvm_provider or tvm_config.provider
    tvm_config.api_key = (
        os.environ.get("TVM_TONAPI_API_KEY")
        if tvm_provider == TVM_PROVIDER_TONAPI
        else os.environ.get("TVM_TONCENTER_API_KEY")
    )
    tvm_config.provider_base_url = os.environ.get("TVM_RPC_URL")
    tvm_signer = FacilitatorHighloadV3Signer({TVM_NETWORK: tvm_config})
    print(f"TVM Facilitator account: {tvm_signer.get_addresses()[0]}")


class Erc20ApprovalSigner:
    """Wraps FacilitatorWeb3Signer with send_transactions for ERC-20 approval sponsoring.

    Broadcasts pre-signed approval txs and settles via the proxy contract,
    matching the Go/TS facilitator pattern.
    """

    def __init__(self, base_signer: FacilitatorWeb3Signer):
        self._signer = base_signer

    def send_transactions(self, transactions: list) -> list[str]:
        hashes: list[str] = []
        for tx in transactions:
            if isinstance(tx, str):
                raw_bytes = bytes.fromhex(tx[2:] if tx.startswith("0x") else tx)
                w3 = self._signer._w3

                payer_address = w3.eth.account.recover_transaction(tx)
                # Use the same gas constants as the library's approve tx builder
                gas_cost = (
                    70_000 * 1_000_000_000
                )  # ERC20_APPROVE_GAS_LIMIT * DEFAULT_MAX_FEE_PER_GAS

                payer_balance = w3.eth.get_balance(payer_address)
                if payer_balance < gas_cost:
                    deficit = gas_cost - payer_balance
                    print(
                        f"⛽ Funding payer {payer_address} with {deficit} wei for gas"
                    )
                    fund_tx = {
                        "to": payer_address,
                        "value": deficit,
                        "gas": 21000,
                        "gasPrice": w3.eth.gas_price,
                        "nonce": self._signer._reserve_nonce(),
                        "chainId": w3.eth.chain_id,
                    }
                    signed_fund = self._signer._account.sign_transaction(fund_tx)
                    fund_hash = w3.eth.send_raw_transaction(
                        signed_fund.raw_transaction
                    ).hex()
                    fund_receipt = w3.eth.wait_for_transaction_receipt(fund_hash)
                    if fund_receipt["status"] != 1:
                        raise RuntimeError(f"gas_funding_failed: {fund_hash}")
                    print(f"⛽ Gas funding confirmed: {fund_hash}")

                tx_hash = w3.eth.send_raw_transaction(raw_bytes).hex()
            elif isinstance(tx, dict) or isinstance(tx, WriteContractCall):
                if isinstance(tx, dict):
                    call = WriteContractCall(**tx)
                else:
                    call = tx
                tx_hash = self._signer.write_contract(
                    call.address, call.abi, call.function, *call.args
                )
            else:
                raise ValueError(f"Unsupported transaction type: {type(tx)}")

            receipt = self._signer.wait_for_transaction_receipt(tx_hash)
            if receipt.status != TX_STATUS_SUCCESS:
                raise RuntimeError(f"transaction_failed: {tx_hash}")
            hashes.append(tx_hash)
        return hashes

    def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
        return self._signer.wait_for_transaction_receipt(tx_hash)


erc20_approval_signer = (
    Erc20ApprovalSigner(evm_signer) if evm_signer is not None else None
)


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
                    last_updated=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
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


# Initialize the x402 Facilitator with optional EVM/SVM/TVM support
facilitator = (
    x402Facilitator()
    .on_before_verify(lambda ctx: print("Before verify", ctx))
    .on_after_verify(lambda ctx: _handle_after_verify(ctx))
    .on_verify_failure(lambda ctx: print("Verify failure", ctx))
    .on_before_settle(lambda ctx: print("Before settle", ctx))
    .on_after_settle(lambda ctx: print(f"🎉 Payment settled: {ctx.result.transaction}"))
    .on_settle_failure(lambda ctx: print("Settle failure", ctx))
)

# Register EVM schemes (V1 and V2)
if evm_signer is not None:
    register_exact_evm_facilitator(
        facilitator,
        evm_signer,
        networks=EVM_NETWORK,
    )

    # Register upto EVM scheme (V2 only)
    facilitator.register([EVM_NETWORK], UptoEvmFacilitatorScheme(evm_signer))

    # Register batch-settlement EVM scheme (V2 only). Facilitator key is
    # advertised as receiverAuthorizer in /supported; servers may delegate
    # to it or supply their own (SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY).
    batch_settlement_authorizer = LocalAuthorizerSigner(
        os.environ["FACILITATOR_EVM_PRIVATE_KEY"]
    )
    print(
        f"EVM Receiver Authorizer (batch-settlement): {batch_settlement_authorizer.address}"
    )
    facilitator.register(
        [EVM_NETWORK],
        BatchSettlementEvmFacilitator(evm_signer, batch_settlement_authorizer),
    )

# Register SVM schemes (V1 and V2)
if svm_signer is not None:
    register_exact_svm_facilitator(
        facilitator,
        svm_signer,
        networks=SVM_NETWORK,
    )

# Register TVM schemes (V2)
if tvm_signer is not None:
    facilitator.register(
        [TVM_NETWORK],
        ExactTvmFacilitatorScheme(tvm_signer),
    )

# Register gas sponsoring extensions
if evm_signer is not None and erc20_approval_signer is not None:
    facilitator.register_extension(EIP2612_GAS_SPONSORING)
    facilitator.register_extension(
        Erc20ApprovalFacilitatorExtension(signer=erc20_approval_signer)
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
    title="x402 Python Facilitator (E2E)",
    description="Verifies and settles x402 payments on-chain for e2e testing",
    version="2.0.0",
)


@app.post("/verify")
async def verify(request: VerifyRequest):
    """Verify a payment against requirements.

    Note: Payment tracking and bazaar discovery are handled by lifecycle hooks.

    Args:
        request: Payment payload and requirements to verify.

    Returns:
        VerifyResponse with isValid and payer (if valid) or invalidReason.
    """
    try:
        from x402.schemas import parse_payment_payload, parse_payment_requirements

        # Parse payload (auto-detects V1/V2) and requirements (based on payload version)
        payload = parse_payment_payload(request.paymentPayload)
        requirements = parse_payment_requirements(
            payload.x402_version, request.paymentRequirements
        )

        # Hooks will automatically:
        # - Track verified payment (on_after_verify)
        # - Extract and catalog discovery info (on_after_verify)
        response = await facilitator.verify(payload, requirements)

        if not response.is_valid:
            print(
                f"  ❌ Verify rejected: {response.invalid_reason} (payer={response.payer})"
            )

        return response.model_dump(by_alias=True, exclude_none=True)
    except Exception as e:
        import traceback

        print(f"Verify error: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/settle")
async def settle(request: SettleRequest):
    """Settle a payment on-chain.

    Note: Verification validation and cleanup are handled by lifecycle hooks.

    Args:
        request: Payment payload and requirements to settle.

    Returns:
        SettleResponse with success, transaction, network, and payer.
    """
    try:
        from x402.schemas import parse_payment_payload, parse_payment_requirements

        # Parse payload (auto-detects V1/V2) and requirements (based on payload version)
        payload = parse_payment_payload(request.paymentPayload)
        requirements = parse_payment_requirements(
            payload.x402_version, request.paymentRequirements
        )

        # Hooks will automatically:
        # - Validate payment was verified (on_before_settle - will abort if not)
        # - Check verification timeout (on_before_settle)
        # - Clean up tracking (on_after_settle / on_settle_failure)
        response = await facilitator.settle(payload, requirements)

        return response.model_dump(by_alias=True, exclude_none=True)
    except Exception as e:
        print(f"Settle error: {e}")

        # Check if this was an abort from hook
        if "aborted" in str(e).lower() or "Settlement aborted" in str(e):
            from x402.schemas import SettleResponse

            abort = SettleResponse(
                success=False,
                error_reason=str(e).replace("Settlement aborted: ", ""),
                network=request.paymentPayload.get("accepted", {}).get(
                    "network", "unknown"
                ),
                transaction="",
            )
            return abort.model_dump(by_alias=True, exclude_none=True)

        raise HTTPException(status_code=500, detail=str(e))


@app.get("/supported")
async def supported():
    """Get supported payment kinds and extensions.

    Returns:
        SupportedResponse with kinds, extensions, and signers.
    """
    try:
        response = facilitator.get_supported()

        return {
            "kinds": [
                k.model_dump(by_alias=True, exclude_none=True) for k in response.kinds
            ],
            "extensions": response.extensions,
            "signers": response.signers,
        }
    except Exception as e:
        print(f"Supported error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/discovery/resources")
async def discovery_resources(limit: int = 100, offset: int = 0):
    """List all discovered resources from bazaar.

    Returns:
        Discovery response with x402Version, items, and pagination.
    """
    try:
        return bazaar_catalog.get_resources(limit, offset)
    except Exception as e:
        print(f"Discovery error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/discovery/search")
async def discovery_search(query: str, type: str | None = None, limit: int | None = None):
    """Search discovered resources using keyword matching.

    Args:
        query: The search query string (required).
        type: Optional filter by resource type.
        limit: Optional advisory maximum number of results.

    Returns:
        Search response with x402Version, items, and optional pagination hints.
    """
    try:
        return bazaar_catalog.search_resources(query, type, limit)
    except Exception as e:
        print(f"Discovery search error: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "networks": [kind.network for kind in facilitator.get_supported().kinds],
        "facilitator": "python",
        "version": "2.0.0",
        "extensions": facilitator.get_extensions(),
        "discoveredResources": bazaar_catalog.get_count(),
    }


@app.post("/close")
async def close():
    """Graceful shutdown endpoint."""
    import asyncio

    print("Received shutdown request")
    if tvm_signer is not None:
        tvm_signer.close()

    async def shutdown():
        await asyncio.sleep(0.1)
        os._exit(0)

    asyncio.create_task(shutdown())
    return {"message": "Facilitator shutting down gracefully"}


if __name__ == "__main__":
    import uvicorn

    supported_networks = [kind.network for kind in facilitator.get_supported().kinds]
    active_extensions = facilitator.get_extensions()

    print(f"""
╔════════════════════════════════════════════════════════╗
║           x402 Python Facilitator (E2E)                ║
╠════════════════════════════════════════════════════════╣
║  Server:     http://localhost:{PORT}                       ║
║  Networks:   {", ".join(supported_networks[:2])[:36]:<36}║
║  Extensions: {", ".join(active_extensions)[:36]:<36}║
║                                                        ║
║  Endpoints:                                            ║
║  • POST /verify              (verify payment)          ║
║  • POST /settle              (settle payment)          ║
║  • GET  /supported           (get supported kinds)     ║
║  • GET  /discovery/resources (list discovered)         ║
║  • GET  /health              (health check)            ║
║  • POST /close               (shutdown server)         ║
╚════════════════════════════════════════════════════════╝
    """)

    # Log that facilitator is ready (needed for e2e test discovery)
    print("Facilitator listening")

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
