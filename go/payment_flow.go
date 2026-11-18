package x402

import (
	"fmt"
	"sort"
	"strings"

	"github.com/x402-foundation/x402/go/v2/types"
)

// SDKDefaultAssetTransferMethod is an SDK-only ATM key for schemes with no
// on-wire assetTransferMethod. Never emit assetTransferMethod: "default" on the
// 402 wire.
const SDKDefaultAssetTransferMethod = "default"

// PaymentFlows is the closed set of payment-flow phase tables.
//
// Multi-settle flows (escrow) invoke settle lifecycle hooks once per settle.
// Authors of side-effecting beforeSettle / afterSettle hooks should branch on
// SettleContext.Phase when used with those flows.
var PaymentFlows = map[PaymentFlowName]PaymentFlowPhases{
	PaymentFlowAuthorization: {VerifyBeforeHandler: true, SettleBeforeHandler: false, SettleAfterHandler: true},
	PaymentFlowUpfront:       {VerifyBeforeHandler: false, SettleBeforeHandler: true, SettleAfterHandler: false},
	PaymentFlowEscrow:        {VerifyBeforeHandler: false, SettleBeforeHandler: true, SettleAfterHandler: true},
}

// ResolvePaymentFlow resolves assetTransferMethod and paymentFlow from a scheme
// table and requirements.
//
// Omit ATM → scheme.DefaultAssetTransferMethod(). Omit paymentFlow → that ATM's
// table default. Unsupported ATM or flow returns an error.
func ResolvePaymentFlow(scheme SchemeNetworkServer, requirements types.PaymentRequirements) (string, PaymentFlowName, error) {
	atm := scheme.DefaultAssetTransferMethod()
	if requirements.Extra != nil {
		if v, ok := requirements.Extra["assetTransferMethod"].(string); ok {
			atm = v
		}
	}

	flows := scheme.PaymentFlows()
	config, ok := flows[atm]
	if !ok {
		supported := make([]string, 0, len(flows))
		for k := range flows {
			supported = append(supported, k)
		}
		sort.Strings(supported)
		return "", "", fmt.Errorf(
			`[x402] Scheme %q does not support assetTransferMethod %q. Supported: %s`,
			scheme.Scheme(), atm, strings.Join(supported, ", "),
		)
	}

	defaultInSupported := false
	for _, f := range config.Supported {
		if f == config.Default {
			defaultInSupported = true
			break
		}
	}
	if !defaultInSupported {
		return "", "", fmt.Errorf(
			`[x402] Scheme %q paymentFlows[%q].default is not in supported`,
			scheme.Scheme(), atm,
		)
	}

	flow := config.Default
	var requested interface{}
	if requirements.Extra != nil {
		if v, exists := requirements.Extra["paymentFlow"]; exists && v != nil {
			requested = v
			if s, ok := v.(string); ok {
				flow = PaymentFlowName(s)
			} else {
				flow = PaymentFlowName(fmt.Sprint(v))
			}
		}
	}

	supported := false
	for _, f := range config.Supported {
		if f == flow {
			supported = true
			break
		}
	}
	if !supported {
		supportedNames := make([]string, len(config.Supported))
		for i, f := range config.Supported {
			supportedNames[i] = string(f)
		}
		return "", "", fmt.Errorf(
			`[x402] Scheme %q assetTransferMethod %q does not support paymentFlow %q. Supported: %s (default: %s)`,
			scheme.Scheme(), atm, fmt.Sprint(requested), strings.Join(supportedNames, ", "), config.Default,
		)
	}

	return atm, flow, nil
}

// ApplyPaymentFlowWireExtra applies resolved payment-flow rules to 402 extra:
//   - Strip the SDK ATM sentinel "default" (never on the wire).
//   - When resolved flow is not authorization, set extra.paymentFlow so clients
//     can distinguish trust models without scheme-specific knowledge.
func ApplyPaymentFlowWireExtra(extra map[string]interface{}, assetTransferMethod string, flow PaymentFlowName) map[string]interface{} {
	next := make(map[string]interface{}, len(extra)+1)
	for k, v := range extra {
		next[k] = v
	}
	if assetTransferMethod == SDKDefaultAssetTransferMethod || next["assetTransferMethod"] == SDKDefaultAssetTransferMethod {
		delete(next, "assetTransferMethod")
	}
	if flow != PaymentFlowAuthorization {
		next["paymentFlow"] = string(flow)
	}
	if len(next) == 0 {
		return nil
	}
	return next
}

// ResolvePaymentFlowPhases resolves the phase table for a payment flow name.
func ResolvePaymentFlowPhases(flow PaymentFlowName) (PaymentFlowPhases, error) {
	phases, ok := PaymentFlows[flow]
	if !ok {
		names := make([]string, 0, len(PaymentFlows))
		for name := range PaymentFlows {
			names = append(names, string(name))
		}
		sort.Strings(names)
		return PaymentFlowPhases{}, fmt.Errorf(
			`[x402] Unknown payment flow %q. Expected one of: %s`,
			flow, strings.Join(names, ", "),
		)
	}
	return phases, nil
}

// IsRecognizedPaymentFlow reports whether flow is one of the closed payment-flow names,
// or absent (nil / missing). Used by client selection.
func IsRecognizedPaymentFlow(flow interface{}) bool {
	if flow == nil {
		return true
	}
	s, ok := flow.(string)
	if !ok {
		return false
	}
	switch PaymentFlowName(s) {
	case PaymentFlowAuthorization, PaymentFlowUpfront, PaymentFlowEscrow:
		return true
	default:
		return false
	}
}
