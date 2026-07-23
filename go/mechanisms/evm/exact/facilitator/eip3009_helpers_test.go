package facilitator

import (
	"errors"
	"testing"
)

func TestParseEIP3009TransferError(t *testing.T) {
	tests := []struct {
		name string
		msg  string
		want string
	}{
		{"relayer gas exhaustion (go-ethereum)", "insufficient funds for gas * price + value", ErrRelayerInsufficientFunds},
		{"relayer gas exhaustion (transfer phrasing)", "err: insufficient funds for transfer: address 0x...", ErrRelayerInsufficientFunds},
		{"relayer gas exhaustion (account balance)", "exceeds the balance of the account", ErrRelayerInsufficientFunds},
		{"relayer gas exhaustion (nethermind)", "insufficient balance for transaction", ErrRelayerInsufficientFunds},
		{"AuthorizationExpired (string)", "FiatTokenV2: authorization is expired", ErrValidBeforeExpired},
		{"AuthorizationExpired (custom)", "execution reverted: AuthorizationExpired()", ErrValidBeforeExpired},
		{"AuthorizationNotYetValid (string)", "FiatTokenV2: authorization is not yet valid", ErrValidAfterInFuture},
		{"AuthorizationNotYetValid (custom)", "execution reverted: AuthorizationNotYetValid()", ErrValidAfterInFuture},
		{"AuthorizationUsed (string)", "FiatTokenV2: authorization is used", ErrNonceAlreadyUsed},
		{"AuthorizationAlreadyUsed (custom)", "execution reverted: AuthorizationAlreadyUsed()", ErrNonceAlreadyUsed},
		{"AuthorizationUsedOrCanceled (custom)", "execution reverted: AuthorizationUsedOrCanceled()", ErrNonceAlreadyUsed},
		{"payer ERC-20 balance (string)", "ERC20: transfer amount exceeds balance", ErrInsufficientBalance},
		{"payer ERC-20 balance (custom)", "execution reverted: ERC20InsufficientBalance(...)", ErrInsufficientBalance},
		{"invalid signature (string)", "FiatTokenV2: invalid signature", ErrInvalidSignature},
		{"SignerMismatch", "execution reverted: SignerMismatch()", ErrInvalidSignature},
		{"InvalidSignatureV", "execution reverted: InvalidSignatureV()", ErrInvalidSignature},
		{"InvalidSignatureS", "execution reverted: InvalidSignatureS()", ErrInvalidSignature},
		{"unknown revert falls back", "something nobody has ever seen", ErrFailedToExecuteTransfer},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseEIP3009TransferError(errors.New(tt.msg))
			if got != tt.want {
				t.Errorf("parseEIP3009TransferError(%q) = %q, want %q", tt.msg, got, tt.want)
			}
		})
	}
}

func TestParseEIP3009TransferError_NoMisclassificationAcrossBuckets(t *testing.T) {
	t.Run("payer ERC-20 balance error is not classified as relayer gas exhaustion", func(t *testing.T) {
		got := parseEIP3009TransferError(errors.New("ERC20: transfer amount exceeds balance"))
		if got != ErrInsufficientBalance {
			t.Errorf("got %q, want ErrInsufficientBalance", got)
		}
	})

	t.Run("relayer gas exhaustion is not classified as payer ERC-20 balance error", func(t *testing.T) {
		got := parseEIP3009TransferError(errors.New("insufficient funds for gas * price + value"))
		if got != ErrRelayerInsufficientFunds {
			t.Errorf("got %q, want ErrRelayerInsufficientFunds", got)
		}
	})
}
