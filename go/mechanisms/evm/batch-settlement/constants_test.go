package batchsettlement

import (
	"encoding/hex"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

func TestContractAddresses(t *testing.T) {
	if !strings.HasPrefix(BatchSettlementAddress, "0x") || len(BatchSettlementAddress) != 42 {
		t.Fatalf("BatchSettlementAddress malformed: %q", BatchSettlementAddress)
	}
	if !strings.HasPrefix(ERC3009DepositCollectorAddress, "0x") || len(ERC3009DepositCollectorAddress) != 42 {
		t.Fatalf("ERC3009DepositCollectorAddress malformed: %q", ERC3009DepositCollectorAddress)
	}
}

func eip712TypeString(primary string, fields []evm.TypedDataField) string {
	parts := make([]string, len(fields))
	for i, field := range fields {
		parts[i] = field.Type + " " + field.Name
	}
	return primary + "(" + strings.Join(parts, ",") + ")"
}

func TestChannelConfigTypesMatchTypeString(t *testing.T) {
	got := eip712TypeString("ChannelConfig", ChannelConfigTypes["ChannelConfig"])
	if got != ChannelConfigTypeString {
		t.Fatalf("ChannelConfig type string = %s", got)
	}
	if sum := crypto.Keccak256([]byte(got)); hex.EncodeToString(sum) != hex.EncodeToString(ChannelConfigTypeHash) {
		t.Fatalf("ChannelConfig typehash = %x", sum)
	}
}

// TestVoucherTypes checks the voucher struct encodes to its EIP-712 type string
// and that keccak of that string is the voucher typehash.
func TestVoucherTypes(t *testing.T) {
	const typeString = "Voucher(bytes32 channelId,uint128 maxClaimableAmount)"
	got := eip712TypeString("Voucher", VoucherTypes["Voucher"])
	if got != typeString {
		t.Fatalf("Voucher type string = %s", got)
	}
	const typeHash = "1e1bd6ff84c3e0d9029a292b212e039c0ca97ec497c55191a4a5874294609a69"
	if hex.EncodeToString(crypto.Keccak256([]byte(got))) != typeHash {
		t.Fatalf("Voucher typehash = %x", crypto.Keccak256([]byte(got)))
	}
}

func TestRefundTypes(t *testing.T) {
	const typeString = "Refund(bytes32 channelId,uint256 nonce,uint128 amount)"
	if got := eip712TypeString("Refund", RefundTypes["Refund"]); got != typeString {
		t.Fatalf("Refund type string = %s", got)
	}
}

func TestClaimBatchTypes(t *testing.T) {
	cb, ok := ClaimBatchTypes["ClaimBatch"]
	if !ok || len(cb) != 1 {
		t.Fatalf("ClaimBatchTypes shape = %+v", cb)
	}
	if cb[0].Name != "claims" || cb[0].Type != "ClaimEntry[]" {
		t.Fatalf("ClaimBatch[0] = %+v", cb[0])
	}
	const entry = "ClaimEntry(bytes32 channelId,uint128 maxClaimableAmount,uint128 totalClaimed)"
	if got := eip712TypeString("ClaimEntry", ClaimBatchTypes["ClaimEntry"]); got != entry {
		t.Fatalf("ClaimEntry type string = %s", got)
	}
}

func TestReceiveAuthorizationTypes(t *testing.T) {
	const typeString = "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
	got := eip712TypeString("ReceiveWithAuthorization", ReceiveAuthorizationTypes["ReceiveWithAuthorization"])
	if got != typeString {
		t.Fatalf("ReceiveWithAuthorization type string = %s", got)
	}
}

func TestBatchPermit2WitnessTypes(t *testing.T) {
	permit := BatchPermit2WitnessTypes["PermitWitnessTransferFrom"]
	if len(permit) != 5 || permit[0].Name != "permitted" || permit[4].Name != "witness" || permit[4].Type != "DepositWitness" {
		t.Fatalf("PermitWitnessTransferFrom = %+v", permit)
	}
	const witness = "DepositWitness(bytes32 channelId)"
	if got := eip712TypeString("DepositWitness", BatchPermit2WitnessTypes["DepositWitness"]); got != witness {
		t.Fatalf("DepositWitness type string = %s", got)
	}
	const tokenPermissions = "TokenPermissions(address token,uint256 amount)"
	if got := eip712TypeString("TokenPermissions", BatchPermit2WitnessTypes["TokenPermissions"]); got != tokenPermissions {
		t.Fatalf("TokenPermissions type string = %s", got)
	}
}

func TestWithdrawDelayBounds(t *testing.T) {
	if MinWithdrawDelay >= MaxWithdrawDelay {
		t.Fatal("min must be less than max")
	}
}

// TestErrorCodes pins the canonical wire prefix `invalid_batch_settlement_evm_`
// for every error reason exported from this package. Both facilitator-mirrored
// constants and resource-server abort reasons share the same envelope —
// renaming or dropping the prefix here breaks cdp-facilitator's substring
// classifier and the `x402VerifyInvalidReason` / `x402SettleErrorReason`
// CDP Accounts API enums.
func TestErrorCodes(t *testing.T) {
	const wirePrefix = "invalid_batch_settlement_evm_"
	for _, code := range []string{
		ErrCumulativeBelowClaimed,
		ErrCumulativeAmountMismatch,
		ErrChannelBusy,
		ErrMissingChannel,
		ErrChargeExceedsSignedCumulative,
		ErrRefundNoBalance,
		ErrRefundAmountInvalid,
		ErrRefundAmountExceedsBalance,
		ErrDepositBelowMinDeposit,
		ErrRefundAuthorizerMismatch,
		ErrRefundAuthorizerSignature,
		ErrVoucherStoreUnavailable,
		ErrVoucherStoreModeMismatch,
		ErrUnexpectedPendingId,
		ErrUnexpectedCancel,
		ErrPendingIdMismatch,
		ErrReceiverMismatch,
		ErrReceiverAuthorizerMismatch,
		ErrTokenMismatch,
		ErrWithdrawDelayMismatch,
		ErrWithdrawDelayOutOfRange,
		ErrCumulativeExceedsBalance,
	} {
		if !strings.HasPrefix(code, wirePrefix) {
			t.Fatalf("error reason must start with %q, got %q", wirePrefix, code)
		}
	}
}
