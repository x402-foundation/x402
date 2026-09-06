package evm

// Shared EVM error constants used across all EVM payment types.
// Values must never change without a coordinated update across all SDKs.
const (
	// ErrAssetNotDeployedContract is returned when the payment asset address has no bytecode.
	// EOAs return empty data on any eth_call without reverting, causing silent no-op settlements.
	ErrAssetNotDeployedContract = "asset_not_deployed_contract"

	// ErrSettlementPending: broadcast succeeded; receipt wait failed (RPC/timeout). Non-terminal —
	// return with the tx hash so the caller can reconcile onchain before retrying.
	ErrSettlementPending = "settlement_pending"
)
