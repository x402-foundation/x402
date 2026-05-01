package facilitator

import (
	"context"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
)

// permit2DepositBranchKind enumerates the three Permit2 deposit settlement
// strategies, mirroring TS `resolvePermit2DepositBranch`.
type permit2DepositBranchKind string

const (
	permit2BranchStandard       permit2DepositBranchKind = "standard"
	permit2BranchEip2612        permit2DepositBranchKind = "eip2612"
	permit2BranchErc20Approval  permit2DepositBranchKind = "erc20Approval"
)

// permit2DepositBranch captures the resolved gas-sponsorship branch for a
// Permit2 batch-settlement deposit. Verify and settle share the result so
// they encode the same `collectorData` and pick the same execution path.
//
// kind=="standard"      → no extension; facilitator submits a single
//
//	deposit() tx with empty EIP-2612 segment.
//
// kind=="eip2612"       → encoded EIP-2612 permit segment is appended to
//
//	`collectorData`; facilitator still submits a single deposit() tx.
//
// kind=="erc20Approval" → facilitator extension signer broadcasts a
//
//	pre-signed approve() then deposit() (multi-tx).
type permit2DepositBranch struct {
	kind            permit2DepositBranchKind
	collectorData   []byte
	erc20Info       *erc20approvalgassponsor.Info
	extensionSigner erc20approvalgassponsor.Erc20ApprovalGasSponsoringSigner
}

// resolvePermit2DepositBranch parses the payment payload's `extensions`
// envelope and decides which gas-sponsorship branch to take. Mirrors
// TS `resolvePermit2DepositBranch` in
// `typescript/.../batch-settlement/facilitator/deposit-permit2.ts`.
//
// On a well-formed but rejected extension (e.g. payer/asset/amount mismatch)
// returns ("invalidReason", nil); on a successful branch resolution returns
// (branch, "", nil); on an internal error returns (nil, "", err).
func resolvePermit2DepositBranch(
	_ context.Context,
	auth *batched.BatchedPermit2Authorization,
	depositAmount string,
	requirements payerAssetView,
	extensions map[string]interface{},
	fctx *x402.FacilitatorContext,
	network string,
) (*permit2DepositBranch, string, error) {
	tokenAddress := evm.NormalizeAddress(requirements.Token)
	payer := requirements.Payer

	// EIP-2612 takes priority over ERC-20 approval, matching TS
	// `trySignEip2612PermitExtension` ordering on the client side and
	// `resolvePermit2DepositBranch` on the facilitator side.
	eip2612Info, _ := eip2612gassponsor.ExtractEip2612GasSponsoringInfo(extensions)
	if eip2612Info != nil {
		if reason := validateBatchEip2612Permit(eip2612Info, payer, tokenAddress, depositAmount); reason != "" {
			return nil, reason, nil
		}
		v, r, s, splitErr := evm.SplitEip2612Signature(eip2612Info.Signature)
		if splitErr != nil {
			return nil, ErrEip2612InvalidSignature, nil
		}
		eip2612Bytes, encodeErr := batched.BuildEip2612PermitData(batched.Eip2612PermitInput{
			Value:    eip2612Info.Amount,
			Deadline: eip2612Info.Deadline,
			V:        v,
			R:        bytes32Hex(r),
			S:        bytes32Hex(s),
		})
		if encodeErr != nil {
			return nil, "", encodeErr
		}
		collectorData, err := batched.BuildPermit2CollectorData(auth.Nonce, auth.Deadline, auth.Signature, eip2612Bytes)
		if err != nil {
			return nil, "", err
		}
		return &permit2DepositBranch{
			kind:          permit2BranchEip2612,
			collectorData: collectorData,
		}, "", nil
	}

	erc20Info, _ := erc20approvalgassponsor.ExtractInfo(extensions)
	if erc20Info != nil {
		if fctx == nil {
			return nil, ErrErc20ApprovalUnavailable, nil
		}
		ext, ok := fctx.GetExtension(erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key()).(*erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension)
		if !ok || ext == nil {
			return nil, ErrErc20ApprovalUnavailable, nil
		}
		extSigner := ext.ResolveSigner(network)
		if extSigner == nil {
			return nil, ErrErc20ApprovalUnavailable, nil
		}
		if reason, _ := validateErc20ApprovalForBatchPayment(erc20Info, payer, tokenAddress); reason != "" {
			return nil, reason, nil
		}
		// ERC-20 approval branch: standard Permit2 collectorData (no EIP-2612
		// segment); the approve() tx is broadcast separately by the extension
		// signer ahead of the deposit() tx in `SettleDeposit`.
		collectorData, err := batched.BuildPermit2CollectorData(auth.Nonce, auth.Deadline, auth.Signature, nil)
		if err != nil {
			return nil, "", err
		}
		return &permit2DepositBranch{
			kind:            permit2BranchErc20Approval,
			collectorData:   collectorData,
			erc20Info:       erc20Info,
			extensionSigner: extSigner,
		}, "", nil
	}

	// No extension supplied: standard Permit2 path. Caller will simulate against
	// the existing on-chain allowance and reject with `permit2_allowance_required`
	// if the user hasn't pre-approved Permit2.
	collectorData, err := batched.BuildPermit2CollectorData(auth.Nonce, auth.Deadline, auth.Signature, nil)
	if err != nil {
		return nil, "", err
	}
	return &permit2DepositBranch{
		kind:          permit2BranchStandard,
		collectorData: collectorData,
	}, "", nil
}

// payerAssetView is the narrow projection of the deposit payload + requirements
// that resolvePermit2DepositBranch needs. Defined as a small struct so the
// resolver doesn't need to import the full BatchedDepositPayload / channel
// types — keeps the signature stable and easier to test.
type payerAssetView struct {
	Payer string
	Token string
}

// validateBatchEip2612Permit wraps evm.ValidateEip2612PermitForPayment and adds
// the batch-settlement-specific rule that `info.Amount == deposit.amount`. This
// mirrors TS `validateBatchEip2612Permit` (deposit-permit2.ts).
func validateBatchEip2612Permit(
	info *eip2612gassponsor.Info,
	payer string,
	tokenAddress string,
	depositAmount string,
) string {
	if reason := evm.ValidateEip2612PermitForPayment(info, payer, tokenAddress); reason != "" {
		return mapEip2612SharedReasonToBatched(reason)
	}
	if info.Amount != depositAmount {
		return ErrEip2612AmountMismatch
	}
	return ""
}

// mapEip2612SharedReasonToBatched translates the generic reason strings emitted
// by evm.ValidateEip2612PermitForPayment into the batch-settlement error codes
// declared in errors.go. Matches TS error naming.
func mapEip2612SharedReasonToBatched(reason string) string {
	switch reason {
	case "invalid_eip2612_extension_format":
		return ErrEip2612InvalidFormat
	case "eip2612_from_mismatch":
		return ErrEip2612OwnerMismatch
	case "eip2612_asset_mismatch":
		return ErrEip2612AssetMismatch
	case "eip2612_spender_not_permit2":
		return ErrEip2612SpenderMismatch
	case "eip2612_deadline_expired":
		return ErrEip2612DeadlineExpired
	default:
		return reason
	}
}

// validateErc20ApprovalForBatchPayment validates the signed ERC-20 approve tx
// against batch-settlement-specific expectations. Reuses the exact mechanism's
// validator since the wire format is identical (approve(Permit2, MaxUint256)
// signed tx). Returns ("", "") on success.
func validateErc20ApprovalForBatchPayment(
	info *erc20approvalgassponsor.Info,
	payer string,
	tokenAddress string,
) (reason, message string) {
	if !erc20approvalgassponsor.ValidateInfo(info) {
		return ErrErc20ApprovalInvalidFormat, "ERC-20 approval extension info failed format validation"
	}
	if !strings.EqualFold(info.From, payer) {
		return ErrErc20ApprovalFromMismatch, "ERC-20 approval `from` does not match payer"
	}
	if !strings.EqualFold(info.Asset, tokenAddress) {
		return ErrErc20ApprovalAssetMismatch, "ERC-20 approval `asset` does not match channel token"
	}
	if !strings.EqualFold(info.Spender, evm.PERMIT2Address) {
		return ErrErc20ApprovalWrongSpender, "ERC-20 approval `spender` is not the canonical Permit2"
	}
	return "", ""
}

// bytes32Hex converts a [32]byte to a 0x-prefixed hex string suitable for
// `BuildEip2612PermitData`'s R/S inputs (which accept either prefixed or
// unprefixed hex).
func bytes32Hex(b [32]byte) string {
	return common.BytesToHash(b[:]).Hex()
}
