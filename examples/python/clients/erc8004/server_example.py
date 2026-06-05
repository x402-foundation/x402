"""Example: Register ERC-8004 extension on an x402 resource server (v2)."""

from eth_account import Account
from x402 import x402ResourceServer
from x402.extensions.erc8004 import (
    ATTESTATION_HEADER,
    attach_interaction_attestation_header,
    create_erc8004_resource_server_extension,
    create_interaction_attestation,
    ERC8004Config,
)

agent_owner = Account.from_key("0x...")
facilitator_client = ...  # your facilitator client
server = x402ResourceServer(facilitator_client)

config = ERC8004Config(
    network="eip155:8453",
    wrapper_address="0x...X402AgentReputation...",
    reputation_registry="0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    identity_registry="0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    rpc_url="https://...",
    agent_id=42,
)

server.register_extension(create_erc8004_resource_server_extension(config))

# After handler runs (best-effort — log and continue if signing fails):
#
#   att = create_interaction_attestation(
#       agent_owner,
#       wrapper_address=config.wrapper_address,
#       agent_id=42,
#       requirements=requirements,
#       payment_payload=payment_payload,
#       ticket_id=int(settle_result.extensions["erc8004"]["ticketId"]),
#       tx_hash=settle_result.transaction,
#       payer=settle_result.payer,
#       method="GET",
#       url=url,
#       request_body=request_body_bytes,
#       response_body=response_body_bytes,
#       response_status=200,
#   )
#   response.headers = attach_interaction_attestation_header(dict(response.headers), att)
