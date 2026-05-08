package x402

import (
	"fmt"
	"reflect"
	"strings"

	"github.com/x402-foundation/x402/go/types"
)

// ============================================================================
// Hook Mutation Policy Guards
// ============================================================================
//
// These helpers enforce hook-context immutability at runtime: extensions and
// schemes are free to inspect everything but allowed to mutate only specific
// fields. The framework snapshots the affected structures before invoking a
// hook and asserts the diff afterwards.
//
// Violations panic-via-error rather than silently corrupting downstream
// state — catching policy bugs at the point of misuse.

// IsVacantStringField reports whether a string field is treated as unset
// and may be filled by `enrichPaymentRequiredResponse`.
func IsVacantStringField(value string) bool {
	return strings.TrimSpace(value) == ""
}

// SnapshotPaymentRequirementsList deep-clones `requirements` so the result
// can serve as an immutable baseline for policy checks.
func SnapshotPaymentRequirementsList(requirements []types.PaymentRequirements) []types.PaymentRequirements {
	if requirements == nil {
		return nil
	}
	out := make([]types.PaymentRequirements, len(requirements))
	for i, req := range requirements {
		clone := req
		clone.Extra = cloneStringAnyMap(req.Extra)
		out[i] = clone
	}
	return out
}

// AssertAcceptsAllowlistedAfterExtensionEnrich enforces the extension-side
// `enrichPaymentRequiredResponse` mutation policy: extensions may fill vacant
// `payTo` / `amount` / `asset` and add new `extra` keys; everything else is
// immutable.
func AssertAcceptsAllowlistedAfterExtensionEnrich(
	baseline, current []types.PaymentRequirements,
	extensionKey string,
) error {
	if len(baseline) != len(current) {
		return fmt.Errorf(`[x402] extension %q violated accepts mutation policy: accepts length changed (%d → %d)`,
			extensionKey, len(baseline), len(current))
	}
	for i := range baseline {
		b := baseline[i]
		c := current[i]
		if b.Scheme != c.Scheme || b.Network != c.Network {
			return fmt.Errorf(`[x402] extension %q violated accepts mutation policy: scheme/network are immutable (index %d)`,
				extensionKey, i)
		}
		if b.MaxTimeoutSeconds != c.MaxTimeoutSeconds {
			return fmt.Errorf(`[x402] extension %q violated accepts mutation policy: maxTimeoutSeconds is immutable (index %d)`,
				extensionKey, i)
		}
		if !IsVacantStringField(b.PayTo) && b.PayTo != c.PayTo {
			return fmt.Errorf(`[x402] extension %q violated accepts mutation policy: "payTo" may only be set when the resource left it vacant (""); non-vacant values are immutable (index %d)`, extensionKey, i)
		}
		if !IsVacantStringField(b.Amount) && b.Amount != c.Amount {
			return fmt.Errorf(`[x402] extension %q violated accepts mutation policy: "amount" may only be set when the resource left it vacant (""); non-vacant values are immutable (index %d)`, extensionKey, i)
		}
		if !IsVacantStringField(b.Asset) && b.Asset != c.Asset {
			return fmt.Errorf(`[x402] extension %q violated accepts mutation policy: "asset" may only be set when the resource left it vacant (""); non-vacant values are immutable (index %d)`, extensionKey, i)
		}
		for key, bv := range b.Extra {
			cv, ok := c.Extra[key]
			if !ok {
				return fmt.Errorf(`[x402] extension %q violated accepts mutation policy: extra[%q] was removed (index %d)`,
					extensionKey, key, i)
			}
			if !reflect.DeepEqual(cv, bv) {
				return fmt.Errorf(`[x402] extension %q violated accepts mutation policy: extra[%q] may not be changed (index %d)`,
					extensionKey, key, i)
			}
		}
	}
	return nil
}

// AssertAcceptsAdditiveExtraAfterSchemeEnrich enforces the scheme-side
// `enrichPaymentRequiredResponse` policy: schemes may only ADD new `extra`
// keys to the matching accept entry; payment terms (payTo / amount / asset /
// maxTimeoutSeconds) and scheme/network are immutable; non-matching accepts
// must be untouched.
func AssertAcceptsAdditiveExtraAfterSchemeEnrich(
	baseline, current []types.PaymentRequirements,
	scheme, network string,
) error {
	if len(baseline) != len(current) {
		return fmt.Errorf(`[x402] scheme %q violated accepts mutation policy: accepts length changed (%d → %d)`,
			scheme, len(baseline), len(current))
	}
	for i := range baseline {
		b := baseline[i]
		c := current[i]
		isMatchingAccept := b.Scheme == scheme && b.Network == network
		if b.Scheme != c.Scheme || b.Network != c.Network {
			return fmt.Errorf(`[x402] scheme %q violated accepts mutation policy: scheme/network are immutable (index %d)`, scheme, i)
		}
		if b.MaxTimeoutSeconds != c.MaxTimeoutSeconds || b.PayTo != c.PayTo || b.Amount != c.Amount || b.Asset != c.Asset {
			return fmt.Errorf(`[x402] scheme %q violated accepts mutation policy: payment terms are immutable (index %d)`, scheme, i)
		}
		for key, bv := range b.Extra {
			cv, ok := c.Extra[key]
			if !ok {
				return fmt.Errorf(`[x402] scheme %q violated accepts mutation policy: extra[%q] was removed (index %d)`, scheme, key, i)
			}
			if !reflect.DeepEqual(cv, bv) {
				return fmt.Errorf(`[x402] scheme %q violated accepts mutation policy: extra[%q] may not be changed (index %d)`, scheme, key, i)
			}
		}
		if !isMatchingAccept && len(c.Extra) != len(b.Extra) {
			return fmt.Errorf(`[x402] scheme %q violated accepts mutation policy: only matching accepts may receive new extra fields (index %d)`, scheme, i)
		}
	}
	return nil
}

// SettleResponseCoreSnapshot captures facilitator-settled fields that
// extensions must not rewrite.
type SettleResponseCoreSnapshot struct {
	Success      bool
	Transaction  string
	Network      Network
	Amount       string
	Payer        string
	ErrorReason  string
	ErrorMessage string
}

// SnapshotSettleResponseCore captures facilitator-settled fields.
func SnapshotSettleResponseCore(result *SettleResponse) SettleResponseCoreSnapshot {
	if result == nil {
		return SettleResponseCoreSnapshot{}
	}
	return SettleResponseCoreSnapshot{
		Success:      result.Success,
		Transaction:  result.Transaction,
		Network:      result.Network,
		Amount:       result.Amount,
		Payer:        result.Payer,
		ErrorReason:  result.ErrorReason,
		ErrorMessage: result.ErrorMessage,
	}
}

// AssertSettleResponseCoreUnchanged enforces that an extension did not
// rewrite facilitator outcome fields.
func AssertSettleResponseCoreUnchanged(before SettleResponseCoreSnapshot, after *SettleResponse, extensionKey string) error {
	if after == nil {
		return fmt.Errorf(`[x402] extension %q violated settlement mutation policy: settle result became nil`, extensionKey)
	}
	if after.Success != before.Success {
		return fmt.Errorf(`[x402] extension %q violated settlement mutation policy: field "success" is immutable after facilitator settle`, extensionKey)
	}
	if after.Transaction != before.Transaction {
		return fmt.Errorf(`[x402] extension %q violated settlement mutation policy: field "transaction" is immutable after facilitator settle`, extensionKey)
	}
	if after.Network != before.Network {
		return fmt.Errorf(`[x402] extension %q violated settlement mutation policy: field "network" is immutable after facilitator settle`, extensionKey)
	}
	if after.Amount != before.Amount {
		return fmt.Errorf(`[x402] extension %q violated settlement mutation policy: field "amount" is immutable after facilitator settle`, extensionKey)
	}
	if after.Payer != before.Payer {
		return fmt.Errorf(`[x402] extension %q violated settlement mutation policy: field "payer" is immutable after facilitator settle`, extensionKey)
	}
	if after.ErrorReason != before.ErrorReason {
		return fmt.Errorf(`[x402] extension %q violated settlement mutation policy: field "errorReason" is immutable after facilitator settle`, extensionKey)
	}
	if after.ErrorMessage != before.ErrorMessage {
		return fmt.Errorf(`[x402] extension %q violated settlement mutation policy: field "errorMessage" is immutable after facilitator settle`, extensionKey)
	}
	return nil
}

// AssertAdditivePayloadEnrichment ensures a scheme's
// `EnrichSettlementPayload` only ADDS new keys to the existing payload.
func AssertAdditivePayloadEnrichment(payload, enrichment map[string]interface{}, callerLabel string) error {
	for key := range enrichment {
		if _, exists := payload[key]; exists {
			return fmt.Errorf(`[x402] %s violated settlement payload enrichment policy: %q already exists on the client payload`, callerLabel, key)
		}
	}
	return nil
}

// AssertAdditiveSettlementExtra ensures a scheme's
// `EnrichSettlementResponse` only ADDS new fields to the response extra,
// recursively for nested plain objects.
func AssertAdditiveSettlementExtra(extra, enrichment map[string]interface{}, callerLabel string) error {
	return assertAdditiveRecord(extra, enrichment, callerLabel, "extra")
}

// MergeAdditiveSettlementExtra deep-merges `enrichment` into `extra` after
// the additive policy has been validated.
func MergeAdditiveSettlementExtra(extra, enrichment map[string]interface{}) map[string]interface{} {
	return mergeAdditiveRecord(extra, enrichment)
}

// ----- internal helpers -----

func cloneStringAnyMap(m map[string]interface{}) map[string]interface{} {
	if m == nil {
		return nil
	}
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		out[k] = deepCloneAny(v)
	}
	return out
}

func deepCloneAny(v interface{}) interface{} {
	switch t := v.(type) {
	case map[string]interface{}:
		return cloneStringAnyMap(t)
	case []interface{}:
		out := make([]interface{}, len(t))
		for i, item := range t {
			out[i] = deepCloneAny(item)
		}
		return out
	default:
		return v
	}
}

func isPlainRecord(v interface{}) (map[string]interface{}, bool) {
	m, ok := v.(map[string]interface{})
	return m, ok
}

func assertAdditiveRecord(target, enrichment map[string]interface{}, callerLabel, path string) error {
	for key, enrichmentValue := range enrichment {
		nextPath := fmt.Sprintf("%s[%q]", path, key)
		targetValue, exists := target[key]
		if !exists {
			continue
		}
		targetMap, targetIsRecord := isPlainRecord(targetValue)
		enrichmentMap, enrichmentIsRecord := isPlainRecord(enrichmentValue)
		if targetIsRecord && enrichmentIsRecord {
			if err := assertAdditiveRecord(targetMap, enrichmentMap, callerLabel, nextPath); err != nil {
				return err
			}
			continue
		}
		return fmt.Errorf(`[x402] %s violated settlement response enrichment policy: %s already exists on the settlement result`, callerLabel, nextPath)
	}
	return nil
}

func mergeAdditiveRecord(target, enrichment map[string]interface{}) map[string]interface{} {
	merged := make(map[string]interface{}, len(target)+len(enrichment))
	for k, v := range target {
		merged[k] = v
	}
	for key, enrichmentValue := range enrichment {
		targetValue, exists := merged[key]
		if exists {
			if targetMap, ok := isPlainRecord(targetValue); ok {
				if enrichmentMap, ok := isPlainRecord(enrichmentValue); ok {
					merged[key] = mergeAdditiveRecord(targetMap, enrichmentMap)
					continue
				}
			}
		}
		merged[key] = enrichmentValue
	}
	return merged
}
