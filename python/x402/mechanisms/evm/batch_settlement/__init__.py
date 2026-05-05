"""x402 batch-settlement mechanism (Python port).

Mirrors ``typescript/packages/mechanisms/evm/src/batch-settlement/``.

This package is being introduced incrementally; PR1 lands the foundation
(constants, ABI, types, encoding helpers, signer protocol). Client,
facilitator, server, storage, and recovery follow in stacked PRs (see
``docs/x402/batch-settlement/plan.md`` in the project tracker).
"""

from .abi import (
    batch_settlement_abi,
    channel_config_components,
    erc20_balance_of_abi,
)
from .constants import (
    BATCH_SETTLEMENT_ADDRESS,
    BATCH_SETTLEMENT_DOMAIN,
    BATCH_SETTLEMENT_SCHEME,
    CHANNEL_CONFIG_TYPEHASH,
    ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
    MAX_WITHDRAW_DELAY,
    MIN_WITHDRAW_DELAY,
    PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
    batch_permit2_witness_types,
    channel_config_types,
    claim_batch_types,
    receive_authorization_types,
    refund_types,
    voucher_types,
)

__all__ = [
    # Constants
    "BATCH_SETTLEMENT_SCHEME",
    "BATCH_SETTLEMENT_ADDRESS",
    "ERC3009_DEPOSIT_COLLECTOR_ADDRESS",
    "PERMIT2_DEPOSIT_COLLECTOR_ADDRESS",
    "MIN_WITHDRAW_DELAY",
    "MAX_WITHDRAW_DELAY",
    "BATCH_SETTLEMENT_DOMAIN",
    "CHANNEL_CONFIG_TYPEHASH",
    "channel_config_types",
    "voucher_types",
    "refund_types",
    "claim_batch_types",
    "receive_authorization_types",
    "batch_permit2_witness_types",
    # ABI
    "channel_config_components",
    "batch_settlement_abi",
    "erc20_balance_of_abi",
]
