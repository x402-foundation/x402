Add Python buyer and HTTP resource-server support for facilitator-managed EVM batch settlement, including refund-authorizer channel binding, remote voucher admission and charging, cancellation, and refund consent. The facilitator's voucher store and settlement worker remain Go-only.

Preserve admission for pending reconciliation, cancel unrecovered local settlement failures before dispatch, and reject incomplete facilitator snapshots.
