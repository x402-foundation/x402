package facilitator

import (
	"context"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

// canonicalPayer is a checksummed-address-shaped fixture used across tests.
// Format must match `addressPattern` in the extension validators (40 hex chars
// after 0x), which is why the unit tests above use 0x1111... for the payer.
const (
	extPayer  = "0x1111111111111111111111111111111111111111"
	extToken  = "0x2222222222222222222222222222222222222222"
	extOwner  = extPayer
	extAmount = "1000"
	// futureDeadline is a unix timestamp far in the future so the deadline
	// validation in evm.ValidateEip2612PermitForPayment passes.
	futureDeadline = "9999999999"
	// 65-byte hex string formed from 130 hex chars; passes hexPattern.
	signature65Bytes = "0x" + // sentinel for clarity
		"11111111111111111111111111111111" +
		"11111111111111111111111111111111" +
		"22222222222222222222222222222222" +
		"22222222222222222222222222222222" +
		"01"
)

// extensionsWithEip2612 wraps a fully-populated Info into the envelope shape
// `eip2612gassponsor.ExtractEip2612GasSponsoringInfo` expects.
func extensionsWithEip2612(info *eip2612gassponsor.Info) map[string]interface{} {
	return map[string]interface{}{
		eip2612gassponsor.EIP2612GasSponsoring.Key(): map[string]interface{}{
			"info": info,
		},
	}
}

func extensionsWithErc20Approval(info *erc20approvalgassponsor.Info) map[string]interface{} {
	return map[string]interface{}{
		erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{
			"info": info,
		},
	}
}

// goodEip2612Info returns a valid EIP-2612 Info matching the deposit amount
// and the canonical Permit2 spender.
func goodEip2612Info() *eip2612gassponsor.Info {
	return &eip2612gassponsor.Info{
		From:      extOwner,
		Asset:     extToken,
		Spender:   evm.PERMIT2Address,
		Amount:    extAmount,
		Nonce:     "0",
		Deadline:  futureDeadline,
		Signature: signature65Bytes,
		Version:   "1",
	}
}

func goodErc20ApprovalInfo() *erc20approvalgassponsor.Info {
	return &erc20approvalgassponsor.Info{
		From:    extOwner,
		Asset:   extToken,
		Spender: evm.PERMIT2Address,
		Amount:  extAmount,
		// Minimal valid hex; ValidateInfo only checks the format pattern,
		// not RLP-decodability.
		SignedTransaction: "0x02",
		Version:           erc20approvalgassponsor.ERC20ApprovalGasSponsoringVersion,
	}
}

func TestResolvePermit2DepositBranch_StandardWhenNoExtensions(t *testing.T) {
	auth := goodPermit2Auth()
	branch, reason, err := resolvePermit2DepositBranch(
		context.Background(), auth, extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		nil, nil, "eip155:84532",
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != "" {
		t.Fatalf("reason = %q, want empty", reason)
	}
	if branch == nil {
		t.Fatal("branch is nil")
	}
	if branch.kind != permit2BranchStandard {
		t.Fatalf("kind = %q, want %q", branch.kind, permit2BranchStandard)
	}
	if len(branch.collectorData) == 0 {
		t.Fatal("collectorData should be populated for standard path")
	}
}

// TestResolvePermit2DepositBranch_Eip2612HappyPath confirms a valid EIP-2612
// extension resolves to the eip2612 branch with non-empty collectorData. The
// collectorData must be larger than the standard path's encoding (which has
// an empty 4th ABI segment) because it now carries the 5-tuple permit blob.
func TestResolvePermit2DepositBranch_Eip2612HappyPath(t *testing.T) {
	auth := goodPermit2Auth()
	standard, _, _ := resolvePermit2DepositBranch(
		context.Background(), auth, extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		nil, nil, "eip155:84532",
	)
	branch, reason, err := resolvePermit2DepositBranch(
		context.Background(), auth, extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		extensionsWithEip2612(goodEip2612Info()),
		nil, "eip155:84532",
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != "" {
		t.Fatalf("reason = %q, want empty", reason)
	}
	if branch.kind != permit2BranchEip2612 {
		t.Fatalf("kind = %q, want %q", branch.kind, permit2BranchEip2612)
	}
	if len(branch.collectorData) <= len(standard.collectorData) {
		t.Fatalf("eip2612 collectorData (%d bytes) should be longer than standard (%d bytes) — eip2612 segment must be encoded",
			len(branch.collectorData), len(standard.collectorData))
	}
}

// TestResolvePermit2DepositBranch_Eip2612AmountMismatch is the regression for
// the batch-specific rule that info.Amount must equal the deposit amount.
// This rule is what prevents a payer from gas-sponsoring a smaller permit
// than the channel deposit they are funding.
func TestResolvePermit2DepositBranch_Eip2612AmountMismatch(t *testing.T) {
	info := goodEip2612Info()
	info.Amount = "999" // != extAmount
	branch, reason, err := resolvePermit2DepositBranch(
		context.Background(), goodPermit2Auth(), extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		extensionsWithEip2612(info),
		nil, "eip155:84532",
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrEip2612AmountMismatch {
		t.Fatalf("reason = %q, want %q", reason, ErrEip2612AmountMismatch)
	}
	if branch != nil {
		t.Fatal("branch should be nil on rejection")
	}
}

func TestResolvePermit2DepositBranch_Eip2612OwnerMismatch(t *testing.T) {
	info := goodEip2612Info()
	info.From = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	_, reason, _ := resolvePermit2DepositBranch(
		context.Background(), goodPermit2Auth(), extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		extensionsWithEip2612(info),
		nil, "eip155:84532",
	)
	if reason != ErrEip2612OwnerMismatch {
		t.Fatalf("reason = %q, want %q", reason, ErrEip2612OwnerMismatch)
	}
}

func TestResolvePermit2DepositBranch_Eip2612SpenderMismatch(t *testing.T) {
	info := goodEip2612Info()
	info.Spender = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	_, reason, _ := resolvePermit2DepositBranch(
		context.Background(), goodPermit2Auth(), extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		extensionsWithEip2612(info),
		nil, "eip155:84532",
	)
	if reason != ErrEip2612SpenderMismatch {
		t.Fatalf("reason = %q, want %q", reason, ErrEip2612SpenderMismatch)
	}
}

func TestResolvePermit2DepositBranch_Eip2612DeadlineExpired(t *testing.T) {
	info := goodEip2612Info()
	info.Deadline = "1" // long expired
	_, reason, _ := resolvePermit2DepositBranch(
		context.Background(), goodPermit2Auth(), extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		extensionsWithEip2612(info),
		nil, "eip155:84532",
	)
	if reason != ErrEip2612DeadlineExpired {
		t.Fatalf("reason = %q, want %q", reason, ErrEip2612DeadlineExpired)
	}
}

// TestResolvePermit2DepositBranch_Erc20ApprovalRequiresExtensionSigner ensures
// the ERC-20 approval branch refuses to proceed when the host facilitator has
// not registered an `Erc20ApprovalFacilitatorExtension`. Without an extension
// signer there's no way to broadcast the pre-signed approve() before deposit().
func TestResolvePermit2DepositBranch_Erc20ApprovalRequiresExtensionSigner(t *testing.T) {
	_, reason, err := resolvePermit2DepositBranch(
		context.Background(), goodPermit2Auth(), extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		extensionsWithErc20Approval(goodErc20ApprovalInfo()),
		nil, // no fctx
		"eip155:84532",
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrErc20ApprovalUnavailable {
		t.Fatalf("reason = %q, want %q", reason, ErrErc20ApprovalUnavailable)
	}

	// Empty fctx (no registration) → same outcome.
	emptyCtx := x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{})
	_, reason, _ = resolvePermit2DepositBranch(
		context.Background(), goodPermit2Auth(), extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		extensionsWithErc20Approval(goodErc20ApprovalInfo()),
		emptyCtx, "eip155:84532",
	)
	if reason != ErrErc20ApprovalUnavailable {
		t.Fatalf("empty fctx: reason = %q, want %q", reason, ErrErc20ApprovalUnavailable)
	}
}

// TestResolvePermit2DepositBranch_Erc20ApprovalHappyPath verifies the branch
// resolves with a registered extension, populates collectorData (without an
// EIP-2612 segment — that's an exclusive-OR with this branch), and surfaces
// the extension signer for SettleDeposit to use.
func TestResolvePermit2DepositBranch_Erc20ApprovalHappyPath(t *testing.T) {
	standard, _, _ := resolvePermit2DepositBranch(
		context.Background(), goodPermit2Auth(), extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		nil, nil, "eip155:84532",
	)

	stub := &stubExtensionSigner{fakeFacilitatorSigner: &fakeFacilitatorSigner{}}
	ext := &erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension{Signer: stub}
	fctx := x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{
		erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): ext,
	})

	branch, reason, err := resolvePermit2DepositBranch(
		context.Background(), goodPermit2Auth(), extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		extensionsWithErc20Approval(goodErc20ApprovalInfo()),
		fctx, "eip155:84532",
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != "" {
		t.Fatalf("reason = %q, want empty", reason)
	}
	if branch.kind != permit2BranchErc20Approval {
		t.Fatalf("kind = %q, want %q", branch.kind, permit2BranchErc20Approval)
	}
	if branch.extensionSigner == nil {
		t.Fatal("extensionSigner should be propagated for SettleDeposit")
	}
	if branch.erc20Info == nil {
		t.Fatal("erc20Info should be propagated for SettleDeposit")
	}
	// ERC-20 approval branch reuses the standard collectorData encoding (no
	// EIP-2612 segment). Lengths must match exactly.
	if len(branch.collectorData) != len(standard.collectorData) {
		t.Fatalf("erc20Approval collectorData length %d != standard %d",
			len(branch.collectorData), len(standard.collectorData))
	}
}

func TestResolvePermit2DepositBranch_Erc20ApprovalAssetMismatch(t *testing.T) {
	info := goodErc20ApprovalInfo()
	info.Asset = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

	stub := &stubExtensionSigner{fakeFacilitatorSigner: &fakeFacilitatorSigner{}}
	ext := &erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension{Signer: stub}
	fctx := x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{
		erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): ext,
	})

	_, reason, err := resolvePermit2DepositBranch(
		context.Background(), goodPermit2Auth(), extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		extensionsWithErc20Approval(info),
		fctx, "eip155:84532",
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != ErrErc20ApprovalAssetMismatch {
		t.Fatalf("reason = %q, want %q", reason, ErrErc20ApprovalAssetMismatch)
	}
}

// TestResolvePermit2DepositBranch_Eip2612TakesPriorityOverErc20 ensures that
// when both extensions are advertised and populated by the client, EIP-2612
// wins because it executes atomically in a single deposit() transaction.
func TestResolvePermit2DepositBranch_Eip2612TakesPriorityOverErc20(t *testing.T) {
	stub := &stubExtensionSigner{fakeFacilitatorSigner: &fakeFacilitatorSigner{}}
	ext := &erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension{Signer: stub}
	fctx := x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{
		erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): ext,
	})

	exts := map[string]interface{}{
		eip2612gassponsor.EIP2612GasSponsoring.Key():             map[string]interface{}{"info": goodEip2612Info()},
		erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{"info": goodErc20ApprovalInfo()},
	}

	branch, reason, err := resolvePermit2DepositBranch(
		context.Background(), goodPermit2Auth(), extAmount,
		payerAssetView{Payer: extPayer, Token: extToken},
		exts, fctx, "eip155:84532",
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if reason != "" {
		t.Fatalf("reason = %q, want empty", reason)
	}
	if branch.kind != permit2BranchEip2612 {
		t.Fatalf("priority broken: got %q, want %q", branch.kind, permit2BranchEip2612)
	}
}

// stubExtensionSigner is a minimal Erc20ApprovalGasSponsoringSigner used only
// to register an extension for branch-resolution tests. The resolver stores
// the signer reference but does NOT invoke any of its methods — only
// `SettleDeposit` calls into it, and that path is covered by the integration
// test harness. We embed `*fakeFacilitatorSigner` to inherit the no-op
// FacilitatorEvmSigner stubs and only add `SendTransactions`.
type stubExtensionSigner struct {
	*fakeFacilitatorSigner
}

func (s *stubExtensionSigner) SendTransactions(_ context.Context, _ []erc20approvalgassponsor.TransactionRequest) ([]string, error) {
	return nil, nil
}
