package batchsettlement

// Scheme name on the wire and in payment requirements.
const Scheme = "batch-settlement"

const (
	// MinWithdrawDelay is the shortest grace period a channel may advertise, in seconds.
	MinWithdrawDelay = 900
	// MaxWithdrawDelay is the longest grace period a channel may advertise, in seconds.
	MaxWithdrawDelay = 2_592_000
	// FullSplitBPS assigns the whole deposit to one recipient.
	FullSplitBPS = 10_000
	// ClientVoucherExpiresAt is the voucher expiry this scheme uses: the voucher does not expire on its own.
	ClientVoucherExpiresAt = 0
)

// AuthorizationDomain separates payer authorizations a server-signed channel spends.
var AuthorizationDomain = []byte("x402-batch-authorization-v2")

// CloseDomain separates a receiver-authorizer close authorization.
var CloseDomain = []byte("x402:batch-settlement:svm:close:v1")

// Extra field names carried on batch-settlement payment requirements.
const (
	ExtraPaymentFlow        = "paymentFlow"
	ExtraMinDeposit         = "minDeposit"
	ExtraFeePayer           = "feePayer"
	ExtraReceiverAuthorizer = "receiverAuthorizer"
	ExtraWithdrawDelay      = "withdrawDelay"
	ExtraTokenProgram       = "tokenProgram"
	ExtraMemo               = "memo"
	ExtraRecentBlockhash    = "recentBlockhash"
	ExtraRecentSlot         = "recentSlot"
	ExtraChannelState       = "channelState"
	ExtraVoucherState       = "voucherState"
	ExtraVoucherSigner      = "voucherSigner"
	ExtraOperator           = "operator"
	ExtraMaxIdleSecs        = "maxIdleSecs"
	ExtraMaxClaimChannels   = "maxClaimChannels"
	ExtraMaxSettleChannels  = "maxSettleChannels"
)

// Redemption batch capacities (scheme_batch_settlement_svm.md, "Facilitator-built
// transactions and batching capacity"). A facilitator advertises the capacity of
// the message version it builds redemptions in; absent means DefaultBatchChannels.
const (
	// DefaultBatchChannels is the claim and settle capacity of a legacy or
	// version-0 redemption, and the capacity when a facilitator advertises none.
	DefaultBatchChannels = 4
	// V1MaxClaimChannels is how many Ed25519-plus-settle pairs fit one version-1 transaction.
	V1MaxClaimChannels = 18
	// V1MaxSettleChannels is how many distribute instructions a facilitator
	// advertises for one version-1 transaction. Fourteen fit (64 account keys)
	// when, as in every settle request, the channels share the route's payTo;
	// thirteen keeps one channel of margin.
	V1MaxSettleChannels = 13
)

const (
	// VoucherSignerClient means the payer signs cumulative vouchers.
	VoucherSignerClient = "client"
	// VoucherSignerServer means the operator signs cumulative vouchers.
	VoucherSignerServer = "server"
)

const (
	PayloadTypeDeposit       = "deposit"
	PayloadTypeVoucher       = "voucher"
	PayloadTypeAuthorization = "authorization"
	PayloadTypeRefund        = "refund"
	PayloadTypeClaim         = "claim"
	PayloadTypeSettle        = "settle"
	PayloadTypeSeal          = "seal"
	AuthorizationTypeProof   = "proof"
)

// DynamicExtraFields are the PaymentRequirements.extra keys a server
// regenerates for every PaymentRequired, so they are not part of requirements
// matching.
var DynamicExtraFields = []string{ExtraRecentBlockhash, ExtraRecentSlot}
