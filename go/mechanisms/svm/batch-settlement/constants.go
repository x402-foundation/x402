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
