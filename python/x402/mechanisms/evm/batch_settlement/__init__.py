"""Batch-settlement EVM scheme.

Public re-exports follow the pattern of the TS `mechanisms/evm/batch-settlement`
package: the client `BatchSettlementEvmScheme`, the `compute_channel_id`
utility, plus selected typed-data + AuthorizerSigner helpers.

Server- and facilitator-side schemes are intentionally not re-exported here;
import them from the `server` and `facilitator` subpackages directly so that
the client bundle stays slim.
"""

from .constants import (
    BATCH_SETTLEMENT_ADDRESS,
    BATCH_SETTLEMENT_DOMAIN_NAME,
    BATCH_SETTLEMENT_DOMAIN_VERSION,
    CLAIM_BATCH_TYPES,
    ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
    MAX_WITHDRAW_DELAY,
    MIN_WITHDRAW_DELAY,
    PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
    REFUND_TYPES,
    SCHEME_BATCH_SETTLEMENT,
    VOUCHER_TYPES,
)
from .types import (
    AuthorizerSigner,
    ChannelConfig,
    ChannelState,
    ChannelStateExtra,
    ClaimPayload,
    DepositAuthorization,
    DepositFields,
    DepositPayload,
    EnrichedRefundPayload,
    Erc3009Authorization,
    PaymentRequirementsExtra,
    PaymentResponseExtra,
    Permit2Authorization,
    Permit2DepositWitness,
    Permit2TokenPermissions,
    RefundPayload,
    SettlePayload,
    VoucherClaim,
    VoucherFields,
    VoucherPayload,
    VoucherStateExtra,
    is_claim_payload,
    is_deposit_payload,
    is_enriched_refund_payload,
    is_refund_payload,
    is_settle_payload,
    is_voucher_payload,
)
from .utils import (
    compute_channel_id,
    get_batch_settlement_eip712_domain,
)

__all__ = [
    "SCHEME_BATCH_SETTLEMENT",
    "BATCH_SETTLEMENT_ADDRESS",
    "ERC3009_DEPOSIT_COLLECTOR_ADDRESS",
    "PERMIT2_DEPOSIT_COLLECTOR_ADDRESS",
    "MIN_WITHDRAW_DELAY",
    "MAX_WITHDRAW_DELAY",
    "BATCH_SETTLEMENT_DOMAIN_NAME",
    "BATCH_SETTLEMENT_DOMAIN_VERSION",
    "VOUCHER_TYPES",
    "REFUND_TYPES",
    "CLAIM_BATCH_TYPES",
    "ChannelConfig",
    "ChannelState",
    "ChannelStateExtra",
    "VoucherFields",
    "VoucherStateExtra",
    "Erc3009Authorization",
    "Permit2Authorization",
    "Permit2TokenPermissions",
    "Permit2DepositWitness",
    "DepositAuthorization",
    "DepositFields",
    "DepositPayload",
    "VoucherPayload",
    "RefundPayload",
    "VoucherClaim",
    "ClaimPayload",
    "SettlePayload",
    "EnrichedRefundPayload",
    "PaymentRequirementsExtra",
    "PaymentResponseExtra",
    "AuthorizerSigner",
    "is_deposit_payload",
    "is_voucher_payload",
    "is_refund_payload",
    "is_claim_payload",
    "is_settle_payload",
    "is_enriched_refund_payload",
    "compute_channel_id",
    "get_batch_settlement_eip712_domain",
]
