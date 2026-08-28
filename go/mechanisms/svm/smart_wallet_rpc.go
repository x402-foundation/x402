package svm

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	addresslookuptable "github.com/gagliardetto/solana-go/programs/address-lookup-table"
	"github.com/gagliardetto/solana-go/rpc"
)

// maxSupportedTxVersion is passed to getTransaction so v0 (lookup-table)
// transactions are returned instead of rejected.
var maxSupportedTxVersion uint64

const ixTokenTransferChecked = 12

// simulateInnerIx accepts both compiled (programIdIndex/accounts/data) and
// jsonParsed (programId + parsed.type/info) inner instructions. Current Solana
// RPCs return jsonParsed TransferChecked CPIs from simulateTransaction.
type simulateInnerIx struct {
	ProgramIDIndex uint16        `json:"programIdIndex"`
	Accounts       []uint16      `json:"accounts"`
	Data           solana.Base58 `json:"data"`
	ProgramID      string        `json:"programId"`
	Parsed         *struct {
		Type string                 `json:"type"`
		Info map[string]interface{} `json:"info"`
	} `json:"parsed"`
}

type simulateInnerGroup struct {
	Index        uint16            `json:"index"`
	Instructions []simulateInnerIx `json:"instructions"`
}

type simulateWithInnerResult struct {
	Value *struct {
		Err               interface{}          `json:"err"`
		InnerInstructions []simulateInnerGroup `json:"innerInstructions"`
	} `json:"value"`
}

// SimulateWithInnerInstructions simulates a transaction with inner instruction
// recording. Signature verification is off; the fee-payer slot may be empty.
func SimulateWithInnerInstructions(ctx context.Context, client *rpc.Client, tx *solana.Transaction) ([]rpc.InnerInstruction, error) {
	txData, err := tx.MarshalBinary()
	if err != nil {
		return nil, fmt.Errorf("failed to encode transaction: %w", err)
	}
	params := []interface{}{
		base64.StdEncoding.EncodeToString(txData),
		rpc.M{
			"encoding":          "base64",
			"sigVerify":         false,
			"commitment":        DefaultCommitment,
			"innerInstructions": true,
		},
	}
	var out simulateWithInnerResult
	if err := client.RPCCallForInto(ctx, &out, "simulateTransaction", params); err != nil {
		return nil, fmt.Errorf("simulation failed: %w", err)
	}
	if out.Value == nil {
		return nil, fmt.Errorf("simulation failed: empty result")
	}
	if out.Value.Err != nil {
		return nil, fmt.Errorf("simulation failed: %v", out.Value.Err)
	}
	return normalizeSimulatedInnerInstructions(out.Value.InnerInstructions, tx.Message.AccountKeys), nil
}

func accountIndex(keys solana.PublicKeySlice, address string) (uint16, bool) {
	pk, err := solana.PublicKeyFromBase58(address)
	if err != nil {
		return 0, false
	}
	for i, key := range keys {
		if key.Equals(pk) {
			return uint16(i), true
		}
	}
	return 0, false
}

func parsedTransferAmount(info map[string]interface{}) (uint64, bool) {
	if tokenAmount, ok := info["tokenAmount"].(map[string]interface{}); ok {
		if amount, ok := tokenAmount["amount"].(string); ok {
			parsed, err := strconv.ParseUint(amount, 10, 64)
			return parsed, err == nil
		}
	}
	switch amount := info["amount"].(type) {
	case string:
		parsed, err := strconv.ParseUint(amount, 10, 64)
		return parsed, err == nil
	case float64:
		return uint64(amount), true
	}
	return 0, false
}

func compiledFromSimulatedInner(ix simulateInnerIx, keys solana.PublicKeySlice) (rpc.CompiledInstruction, bool) {
	if len(ix.Data) > 0 {
		return rpc.CompiledInstruction{
			ProgramIDIndex: ix.ProgramIDIndex,
			Accounts:       ix.Accounts,
			Data:           ix.Data,
		}, true
	}
	if ix.Parsed == nil || ix.Parsed.Type != "transferChecked" || ix.Parsed.Info == nil {
		return rpc.CompiledInstruction{}, false
	}

	info := ix.Parsed.Info
	mint, _ := info["mint"].(string)
	destination, _ := info["destination"].(string)
	authority, _ := info["authority"].(string)
	source, _ := info["source"].(string)
	amount, ok := parsedTransferAmount(info)
	if !ok || mint == "" || destination == "" || authority == "" {
		return rpc.CompiledInstruction{}, false
	}

	programID := ix.ProgramID
	if programID == "" {
		return rpc.CompiledInstruction{}, false
	}
	programIdx, ok := accountIndex(keys, programID)
	if !ok {
		return rpc.CompiledInstruction{}, false
	}
	sourceIdx, okSource := accountIndex(keys, source)
	mintIdx, okMint := accountIndex(keys, mint)
	destIdx, okDest := accountIndex(keys, destination)
	authIdx, okAuth := accountIndex(keys, authority)
	if !okMint || !okDest || !okAuth {
		return rpc.CompiledInstruction{}, false
	}
	if !okSource {
		sourceIdx = 0
	}

	data := make([]byte, 9)
	data[0] = ixTokenTransferChecked
	binary.LittleEndian.PutUint64(data[1:], amount)
	return rpc.CompiledInstruction{
		ProgramIDIndex: programIdx,
		Accounts:       []uint16{sourceIdx, mintIdx, destIdx, authIdx},
		Data:           solana.Base58(data),
	}, true
}

func normalizeSimulatedInnerInstructions(groups []simulateInnerGroup, keys solana.PublicKeySlice) []rpc.InnerInstruction {
	if groups == nil {
		return nil
	}
	out := make([]rpc.InnerInstruction, 0, len(groups))
	for _, group := range groups {
		converted := rpc.InnerInstruction{Index: group.Index}
		for _, ix := range group.Instructions {
			compiled, ok := compiledFromSimulatedInner(ix, keys)
			if !ok {
				continue
			}
			converted.Instructions = append(converted.Instructions, compiled)
		}
		out = append(out, converted)
	}
	return out
}

// ConfirmedTransactionInnerInstructions fetches a confirmed transaction's CPI
// trace and the loaded account-key list inner-instruction indices address.
func ConfirmedTransactionInnerInstructions(ctx context.Context, client *rpc.Client, signature solana.Signature) ([]rpc.InnerInstruction, solana.PublicKeySlice, error) {
	result, err := client.GetTransaction(ctx, signature, &rpc.GetTransactionOpts{
		Encoding:                       solana.EncodingBase64,
		Commitment:                     DefaultCommitment,
		MaxSupportedTransactionVersion: &maxSupportedTxVersion,
	})
	if err != nil {
		return nil, nil, err
	}
	if result == nil || result.Meta == nil || result.Transaction == nil {
		return nil, nil, fmt.Errorf("transaction not indexed")
	}
	tx, err := result.Transaction.GetTransaction()
	if err != nil {
		return nil, nil, fmt.Errorf("failed to decode confirmed transaction: %w", err)
	}
	keys := append(solana.PublicKeySlice{}, tx.Message.AccountKeys...)
	keys = append(keys, result.Meta.LoadedAddresses.Writable...)
	keys = append(keys, result.Meta.LoadedAddresses.ReadOnly...)
	return result.Meta.InnerInstructions, keys, nil
}

// TokenAccountBalance returns the raw token amount of an ATA. The bool is
// false when the account does not exist.
func TokenAccountBalance(ctx context.Context, client *rpc.Client, tokenAccount solana.PublicKey) (uint64, bool, error) {
	result, err := client.GetTokenAccountBalance(ctx, tokenAccount, DefaultCommitment)
	if err != nil {
		return 0, false, err
	}
	if result == nil || result.Value == nil {
		return 0, false, nil
	}
	amount, err := strconv.ParseUint(result.Value.Amount, 10, 64)
	if err != nil {
		return 0, false, fmt.Errorf("invalid token account balance: %w", err)
	}
	return amount, true, nil
}

// AddressLookupTables fetches the address lists stored in the given lookup tables.
func AddressLookupTables(ctx context.Context, client *rpc.Client, tables []solana.PublicKey) (map[solana.PublicKey]solana.PublicKeySlice, error) {
	out := make(map[solana.PublicKey]solana.PublicKeySlice, len(tables))
	for _, table := range tables {
		state, err := addresslookuptable.GetAddressLookupTable(ctx, client, table)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch address lookup table %s: %w", table, err)
		}
		out[table] = state.Addresses
	}
	return out, nil
}
