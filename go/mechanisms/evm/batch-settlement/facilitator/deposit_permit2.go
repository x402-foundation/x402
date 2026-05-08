package facilitator

import (
	"context"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
)

// permit2DepositBranchKind enumerates the three Permit2 deposit settlement
// strategies.
type permit2DepositBranchKind string

const (
	permit2BranchStandard      permit2DepositBranchKind = "standard"
	permit2BranchEip2612       permit2DepositBranchKind = "eip2612"
	permit2BranchErc20Approval permit2DepositBranchKind = "erc20Approval"
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
// envelope and decides which gas-sponsorship branch to take.
//
// On a well-formed but rejected extension (e.g. payer/asset/amount mismatch)
// returns ("invalidReason", nil); on a successful branch resolution returns
// (branch, "", nil); on an internal error returns (nil, "", err).
func resolvePermit2DepositBranch(
	_ context.Context,
	auth *batchsettlement.BatchSettlementPermit2Authorization,
	depositAmount string,
	requirements payerAssetView,
	extensions map[string]interface{},
	fctx *x402.FacilitatorContext,
	network string,
) (*permit2DepositBranch, string, error) {
	tokenAddress := evm.NormalizeAddress(requirements.Token)
	payer := requirements.Payer

	// EIP-2612 takes priority over ERC-20 approval because it keeps settlement
	// to a single deposit() transaction.
	eip2612Info, _ := eip2612gassponsor.ExtractEip2612GasSponsoringInfo(extensions)
	if eip2612Info != nil {
		// Wrap the shared evm validator with the batch-specific rule that
		// `info.amount == deposit.amount`, then translate the shared reason
		// strings into the batched error codes.
		if sharedReason := evm.ValidateEip2612PermitForPayment(eip2612Info, payer, tokenAddress); sharedReason != "" {
			var batchedReason string
			switch sharedReason {
			case "invalid_eip2612_extension_format":
				batchedReason = ErrEip2612InvalidFormat
			case "eip2612_from_mismatch":
				batchedReason = ErrEip2612OwnerMismatch
			case "eip2612_asset_mismatch":
				batchedReason = ErrEip2612AssetMismatch
			case "eip2612_spender_not_permit2":
				batchedReason = ErrEip2612SpenderMismatch
			case "eip2612_deadline_expired":
				batchedReason = ErrEip2612DeadlineExpired
			default:
				batchedReason = sharedReason
			}
			return nil, batchedReason, nil
		}
		if eip2612Info.Amount != depositAmount {
			return nil, ErrEip2612AmountMismatch, nil
		}
		v, r, s, signatureOK := splitEip2612Signature(eip2612Info.Signature)
		if !signatureOK {
			return nil, ErrEip2612InvalidSignature, nil
		}
		eip2612Bytes, encodeErr := batchsettlement.BuildEip2612PermitData(batchsettlement.Eip2612PermitInput{
			Value:    eip2612Info.Amount,
			Deadline: eip2612Info.Deadline,
			V:        v,
			R:        bytes32Hex(r),
			S:        bytes32Hex(s),
		})
		if encodeErr != nil {
			return nil, "", encodeErr
		}
		collectorData, err := batchsettlement.BuildPermit2CollectorData(auth.Nonce, auth.Deadline, auth.Signature, eip2612Bytes)
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
		// Validate the signed approve tx against batch-specific
		// expectations. Wire format mirrors exact (`approve(Permit2,
		// MaxUint256)` signed tx).
		switch {
		case !erc20approvalgassponsor.ValidateInfo(erc20Info):
			return nil, ErrErc20ApprovalInvalidFormat, nil
		case !strings.EqualFold(erc20Info.From, payer):
			return nil, ErrErc20ApprovalFromMismatch, nil
		case !strings.EqualFold(erc20Info.Asset, tokenAddress):
			return nil, ErrErc20ApprovalAssetMismatch, nil
		case !strings.EqualFold(erc20Info.Spender, evm.PERMIT2Address):
			return nil, ErrErc20ApprovalWrongSpender, nil
		}
		// ERC-20 approval branch: standard Permit2 collectorData (no EIP-2612
		// segment); the approve() tx is broadcast separately by the extension
		// signer ahead of the deposit() tx in `SettleDeposit`.
		collectorData, err := batchsettlement.BuildPermit2CollectorData(auth.Nonce, auth.Deadline, auth.Signature, nil)
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
	collectorData, err := batchsettlement.BuildPermit2CollectorData(auth.Nonce, auth.Deadline, auth.Signature, nil)
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
// resolver doesn't need to import the full BatchSettlementDepositPayload / channel
// types — keeps the signature stable and easier to test.
type payerAssetView struct {
	Payer string
	Token string
}

func splitEip2612Signature(signature string) (uint8, [32]byte, [32]byte, bool) {
	v, r, s, err := evm.SplitEip2612Signature(signature)
	return v, r, s, err == nil
}

// bytes32Hex converts a [32]byte to a 0x-prefixed hex string suitable for
// `BuildEip2612PermitData`'s R/S inputs (which accept either prefixed or
// unprefixed hex). Used twice (R and S) by `resolvePermit2DepositBranch`.
func bytes32Hex(b [32]byte) string {
	return common.BytesToHash(b[:]).Hex()
}
