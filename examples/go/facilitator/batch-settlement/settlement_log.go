package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/x402-foundation/x402/go/v2/extensions/buildercode"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	batchedfac "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/facilitator"
)

// metadataOf returns the ERC-8021 `m` field of a parsed suffix, or nil when no suffix was found.
func metadataOf(suffix *buildercode.BuilderCodeSuffixData) map[string]any {
	if suffix == nil {
		return nil
	}
	return suffix.M
}

func logClaimAttestation(
	ctx context.Context,
	result batchedfac.FacilitatorClaimResult,
	signer *facilitatorEvmSigner,
) {
	logSettlementAttestation(ctx, signer, result.Transaction, result.Network, "claim", "Claim", nil)
}

func logRefundSettlementAttestation(
	ctx context.Context,
	result batchedfac.FacilitatorRefundResult,
	signer *facilitatorEvmSigner,
) {
	logSettlementAttestation(ctx, signer, result.Transaction, result.Network, "refund", "Refund", map[string]any{
		"channelId": result.Channel,
	})
}

func logSettlementAttestation(
	ctx context.Context,
	signer *facilitatorEvmSigner,
	hash, network, action, title string,
	extra map[string]any,
) {
	if hash == "" {
		return
	}
	input, err := signer.TransactionInput(ctx, hash)
	if err != nil {
		fmt.Printf("[voucher store] Failed to load %s tx %s: %v\n", action, hash, err)
		return
	}
	logs, err := signer.ReceiptLogs(ctx, hash)
	if err != nil {
		fmt.Printf("[voucher store] Failed to load %s receipt %s: %v\n", action, hash, err)
		return
	}
	builderCode, _ := buildercode.ParseBuilderCodeSuffixFromCalldata("0x" + hex.EncodeToString(input))
	attestation := batchsettlement.DecodeClaimAttestation(input, logs, network, metadataOf(builderCode))

	chargeCounts := make([]string, len(attestation.ChargeCounts))
	for i, count := range attestation.ChargeCounts {
		chargeCounts[i] = fmt.Sprintf("%d", count)
	}

	payload := map[string]any{
		"tx":           hash,
		"functionName": attestation.FunctionName,
		"chargeCounts": chargeCounts,
		"builderCode":  nil,
		"channels":     attestation.Channels,
	}
	for key, value := range extra {
		payload[key] = value
	}
	if builderCode != nil {
		payload["builderCode"] = builderCode
	}
	encoded, _ := json.Marshal(payload)
	fmt.Printf("[voucher store] %s attestation %s\n", title, string(encoded))
}
