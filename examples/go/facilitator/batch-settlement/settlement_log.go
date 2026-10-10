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
	if result.Transaction == "" {
		return
	}
	hash := result.Transaction
	input, err := signer.TransactionInput(ctx, hash)
	if err != nil {
		fmt.Printf("[voucher store] Failed to load claim tx %s: %v\n", hash, err)
		return
	}
	logs, err := signer.ReceiptLogs(ctx, hash)
	if err != nil {
		fmt.Printf("[voucher store] Failed to load claim receipt %s: %v\n", hash, err)
		return
	}
	builderCode, _ := buildercode.ParseBuilderCodeSuffixFromCalldata("0x" + hex.EncodeToString(input))
	attestation := batchsettlement.DecodeClaimAttestation(input, logs, result.Network, metadataOf(builderCode))

	chargeCounts := make([]string, len(attestation.ChargeCounts))
	for i, c := range attestation.ChargeCounts {
		chargeCounts[i] = fmt.Sprintf("%d", c)
	}

	payload := map[string]interface{}{
		"tx":           hash,
		"functionName": attestation.FunctionName,
		"chargeCounts": chargeCounts,
		"builderCode":  nil,
		"channels":     attestation.Channels,
	}
	if builderCode != nil {
		payload["builderCode"] = builderCode
	}
	encoded, _ := json.Marshal(payload)
	fmt.Printf("[voucher store] Claim attestation %s\n", string(encoded))
}

func logRefundSettlementAttestation(
	ctx context.Context,
	result batchedfac.FacilitatorRefundResult,
	signer *facilitatorEvmSigner,
) {
	if result.Transaction == "" {
		return
	}
	hash := result.Transaction
	input, err := signer.TransactionInput(ctx, hash)
	if err != nil {
		fmt.Printf("[voucher store] Failed to load refund tx %s: %v\n", hash, err)
		return
	}
	logs, err := signer.ReceiptLogs(ctx, hash)
	if err != nil {
		fmt.Printf("[voucher store] Failed to load refund receipt %s: %v\n", hash, err)
		return
	}
	builderCode, _ := buildercode.ParseBuilderCodeSuffixFromCalldata("0x" + hex.EncodeToString(input))
	attestation := batchsettlement.DecodeClaimAttestation(input, logs, result.Network, metadataOf(builderCode))

	chargeCounts := make([]string, len(attestation.ChargeCounts))
	for i, c := range attestation.ChargeCounts {
		chargeCounts[i] = fmt.Sprintf("%d", c)
	}

	payload := map[string]interface{}{
		"tx":           hash,
		"channelId":    result.Channel,
		"functionName": attestation.FunctionName,
		"chargeCounts": chargeCounts,
		"builderCode":  nil,
		"channels":     attestation.Channels,
	}
	if builderCode != nil {
		payload["builderCode"] = builderCode
	}
	encoded, _ := json.Marshal(payload)
	fmt.Printf("[voucher store] Refund attestation %s\n", string(encoded))
}
