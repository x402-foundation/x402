package client

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

// DefaultServerSignedMaxDeposit is the escrow cap for a default asset under a trusted operator.
const DefaultServerSignedMaxDeposit = "$1"

var atomicDepositPattern = regexp.MustCompile(`^[1-9]\d*$`)

// ServerSignedChannelsAsset is an opt-in mint for server-signed channels.
type ServerSignedChannelsAsset struct {
	Network string
	// Asset is an on-chain mint, or a default-asset symbol such as "USDC".
	Asset string
	// MaxDeposit is an optional positive integer atomic escrow cap.
	MaxDeposit string
}

// BatchServerSignedChannelsPolicy lists operators that may hold this client's
// voucher-signing authority, and how much escrow it will lock under them.
type BatchServerSignedChannelsPolicy struct {
	AllowedOperators []string
	// MaxDeposit is the USD cap on escrow locked in one channel for a default asset.
	// Empty means DefaultServerSignedMaxDeposit. DisableMaxDeposit lifts the cap.
	MaxDeposit        string
	DisableMaxDeposit bool
	AllowedAssets     []ServerSignedChannelsAsset
}

// ResolvedServerSignedTrust is the grant for one server-signed accept.
type ResolvedServerSignedTrust struct {
	Operator string
	// MaxDeposit is the atomic escrow cap. Nil means the asset is uncapped.
	MaxDeposit *uint64
}

// UntrustedOperatorError is a server-signed accept this client will not act on.
// The creation-failure hook falls back to a client-signed accept when one is offered.
type UntrustedOperatorError struct {
	message  string
	Operator string
}

func (e *UntrustedOperatorError) Error() string {
	if e == nil {
		return ""
	}
	return e.message
}

// IsServerSignedAccept reports whether an accept asks the client to delegate
// voucher signing to the operator.
func IsServerSignedAccept(accept types.PaymentRequirements) bool {
	if accept.Scheme != batchsettlement.Scheme || accept.Extra == nil {
		return false
	}
	signer, _ := accept.Extra[batchsettlement.ExtraVoucherSigner].(string)
	return signer == batchsettlement.VoucherSignerServer
}

// ServerSignedTrustPolicy decides which server-signed accepts a client may act on.
type ServerSignedTrustPolicy struct {
	operators map[string]struct{}
	usdCap    string
	disabled  bool
	assets    []ServerSignedChannelsAsset
}

// NewServerSignedTrustPolicy validates policy. A nil policy trusts nobody.
func NewServerSignedTrustPolicy(policy *BatchServerSignedChannelsPolicy) (*ServerSignedTrustPolicy, error) {
	const label = "serverSignedChannelsPolicy"
	parsed := &ServerSignedTrustPolicy{operators: map[string]struct{}{}}
	if policy != nil {
		for index, operator := range policy.AllowedOperators {
			if operator == "" {
				return nil, fmt.Errorf("%s.allowedOperators[%d] must be a non-empty base58 key", label, index)
			}
			parsed.operators[operator] = struct{}{}
		}
		parsed.assets = policy.AllowedAssets
	}
	if policy != nil && policy.DisableMaxDeposit {
		parsed.disabled = true
	} else {
		money := DefaultServerSignedMaxDeposit
		if policy != nil && policy.MaxDeposit != "" {
			money = policy.MaxDeposit
		}
		amount, _, err := x402.ParseMoney(money)
		if err != nil {
			return nil, fmt.Errorf("%s.maxDeposit must be positive", label)
		}
		if amount == "" || amount == "0" || strings.HasPrefix(amount, "-") {
			return nil, fmt.Errorf("%s.maxDeposit must be positive", label)
		}
		if strings.HasPrefix(amount, "0") && !strings.Contains(amount, ".") {
			return nil, fmt.Errorf("%s.maxDeposit must be positive", label)
		}
		parsed.usdCap = amount
	}
	for index, entry := range parsed.assets {
		if entry.MaxDeposit != "" && !atomicDepositPattern.MatchString(entry.MaxDeposit) {
			return nil, fmt.Errorf(
				"%s.allowedAssets[%d].maxDeposit must be a positive integer atomic amount, not a dollar value; got %q",
				label, index, entry.MaxDeposit,
			)
		}
	}
	return parsed, nil
}

// GrantFor returns the operator and atomic escrow cap for a server-signed accept.
func (p *ServerSignedTrustPolicy) GrantFor(requirements types.PaymentRequirements) (ResolvedServerSignedTrust, error) {
	operator, _ := requirements.Extra[batchsettlement.ExtraOperator].(string)
	if _, ok := p.operators[operator]; operator == "" || !ok {
		named := operator
		if operator == "" {
			named = ""
		}
		var reported *string
		if operator != "" {
			reported = &operator
		}
		return ResolvedServerSignedTrust{}, &UntrustedOperatorError{
			message:  untrustedOperatorMessage(reported),
			Operator: named,
		}
	}
	defaultAsset := svm.FindDefaultAsset(requirements.Asset, requirements.Network)
	for _, candidate := range p.assets {
		if !x402.MatchesNetwork(x402.Network(candidate.Network), x402.Network(requirements.Network)) {
			continue
		}
		assetMatch := strings.EqualFold(candidate.Asset, requirements.Asset)
		symbolMatch := defaultAsset != nil && strings.EqualFold(defaultAsset.Symbol, candidate.Asset)
		if !assetMatch && !symbolMatch {
			continue
		}
		grant := ResolvedServerSignedTrust{Operator: operator}
		if candidate.MaxDeposit != "" {
			parsed, err := paymentchannels.ParseU64(candidate.MaxDeposit, "maxDeposit")
			if err != nil {
				return ResolvedServerSignedTrust{}, err
			}
			grant.MaxDeposit = &parsed
		}
		return grant, nil
	}
	if defaultAsset == nil {
		return ResolvedServerSignedTrust{}, &UntrustedOperatorError{
			message: fmt.Sprintf(
				"batch-settlement: %s on %s is not a default asset. Add it to serverSignedChannelsPolicy.allowedAssets with an atomic maxDeposit before locking escrow under operator %s.",
				requirements.Asset, requirements.Network, operator,
			),
			Operator: operator,
		}
	}
	if p.disabled {
		return ResolvedServerSignedTrust{Operator: operator}, nil
	}
	atomic, err := x402.ConvertToTokenAmount(p.usdCap, defaultAsset.Decimals)
	if err != nil {
		return ResolvedServerSignedTrust{}, err
	}
	parsed, err := paymentchannels.ParseU64(atomic, "maxDeposit")
	if err != nil {
		return ResolvedServerSignedTrust{}, err
	}
	return ResolvedServerSignedTrust{Operator: operator, MaxDeposit: &parsed}, nil
}

// FilterAccepts drops server-signed accepts this client does not trust and
// moves trusted ones ahead of other batch-settlement accepts on the same network.
func (p *ServerSignedTrustPolicy) FilterAccepts(accepts []types.PaymentRequirements) ([]types.PaymentRequirements, error) {
	type kept struct {
		accept  types.PaymentRequirements
		trusted bool
	}
	remaining := make([]kept, 0, len(accepts))
	var refused []string
	for _, accept := range accepts {
		if !IsServerSignedAccept(accept) {
			remaining = append(remaining, kept{accept: accept})
			continue
		}
		_, err := p.GrantFor(accept)
		if err == nil {
			remaining = append(remaining, kept{accept: accept, trusted: true})
			continue
		}
		var untrusted *UntrustedOperatorError
		if !errors.As(err, &untrusted) {
			return nil, err
		}
		if untrusted.Operator != "" {
			refused = append(refused, untrusted.Operator)
		} else {
			refused = append(refused, "<missing>")
		}
	}
	if len(remaining) == 0 && len(refused) > 0 {
		operator := refused[0]
		return nil, &UntrustedOperatorError{
			message:  untrustedOperatorMessage(&operator),
			Operator: operator,
		}
	}
	trustedCount := 0
	for _, item := range remaining {
		if item.trusted {
			trustedCount++
		}
	}
	if trustedCount == 0 {
		out := make([]types.PaymentRequirements, len(remaining))
		for i, item := range remaining {
			out[i] = item.accept
		}
		return out, nil
	}
	reordered := make([]types.PaymentRequirements, 0, len(remaining))
	networksSeen := map[string]struct{}{}
	for _, item := range remaining {
		accept := item.accept
		if accept.Scheme == batchsettlement.Scheme {
			if _, seen := networksSeen[accept.Network]; !seen {
				networksSeen[accept.Network] = struct{}{}
				for _, candidate := range remaining {
					if candidate.trusted &&
						candidate.accept.Scheme == batchsettlement.Scheme &&
						candidate.accept.Network == accept.Network {
						reordered = append(reordered, candidate.accept)
					}
				}
			}
		}
		if item.trusted {
			continue
		}
		reordered = append(reordered, accept)
	}
	return reordered, nil
}

func untrustedOperatorMessage(operators ...*string) string {
	keys := make([]string, 0, len(operators))
	for _, key := range operators {
		if key != nil {
			keys = append(keys, *key)
		}
	}
	who := "<unknown>"
	if len(keys) > 0 {
		who = strings.Join(keys, ", ")
	}
	return "batch-settlement: this resource requires a server-signed channel whose operator (" + who + ") " +
		"can claim up to the full channel deposit without further client signatures. " +
		"Trust it explicitly by listing the key in serverSignedChannelsPolicy.allowedOperators, " +
		"and bound what it could take with serverSignedChannelsPolicy.maxDeposit."
}
