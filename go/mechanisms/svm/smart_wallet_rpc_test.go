package svm

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/system"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNormalizeSimulatedInnerInstructions_ParsedTransferChecked(t *testing.T) {
	program := solana.TokenProgramID
	source := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	dest := solana.NewWallet().PublicKey()
	authority := solana.NewWallet().PublicKey()
	keys := solana.PublicKeySlice{source, mint, dest, authority, program}

	raw := []byte(`[{
		"index": 2,
		"instructions": [{
			"parsed": {
				"info": {
					"authority": "` + authority.String() + `",
					"destination": "` + dest.String() + `",
					"mint": "` + mint.String() + `",
					"source": "` + source.String() + `",
					"tokenAmount": {"amount": "1000", "decimals": 6}
				},
				"type": "transferChecked"
			},
			"program": "spl-token",
			"programId": "` + program.String() + `",
			"stackHeight": 2
		}]
	}]`)

	var groups []simulateInnerGroup
	require.NoError(t, json.Unmarshal(raw, &groups))

	normalized := normalizeSimulatedInnerInstructions(groups, keys)
	require.Len(t, normalized, 1)
	require.Len(t, normalized[0].Instructions, 1)

	ix := normalized[0].Instructions[0]
	assert.Equal(t, uint16(4), ix.ProgramIDIndex)
	require.Len(t, ix.Accounts, 4)
	assert.Equal(t, []uint16{0, 1, 2, 3}, ix.Accounts)
	require.GreaterOrEqual(t, len(ix.Data), 9)
	assert.Equal(t, byte(ixTokenTransferChecked), ix.Data[0])
	assert.Equal(t, uint64(1000), binary.LittleEndian.Uint64(ix.Data[1:9]))
}

func TestNormalizeSimulatedInnerInstructions_CompiledPassthrough(t *testing.T) {
	data := make([]byte, 9)
	data[0] = ixTokenTransferChecked
	binary.LittleEndian.PutUint64(data[1:], 500)

	groups := []simulateInnerGroup{{
		Index: 1,
		Instructions: []simulateInnerIx{{
			ProgramIDIndex: 5,
			Accounts:       []uint16{1, 2, 3, 4},
			Data:           solana.Base58(data),
		}},
	}}

	normalized := normalizeSimulatedInnerInstructions(groups, nil)
	require.Len(t, normalized, 1)
	require.Len(t, normalized[0].Instructions, 1)
	assert.Equal(t, uint16(5), normalized[0].Instructions[0].ProgramIDIndex)
	assert.Equal(t, []uint16{1, 2, 3, 4}, normalized[0].Instructions[0].Accounts)
	assert.Equal(t, solana.Base58(data), normalized[0].Instructions[0].Data)
}

func TestConfirmedTransactionEvidence(t *testing.T) {
	payer := solana.NewWallet().PublicKey()
	loadedWritable := solana.NewWallet().PublicKey()
	loadedReadonly := solana.NewWallet().PublicKey()
	owner := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	tx, err := solana.NewTransaction(
		[]solana.Instruction{system.NewTransferInstruction(1, payer, loadedWritable).Build()},
		solana.Hash{1},
		solana.TransactionPayer(payer),
	)
	require.NoError(t, err)
	wire, err := tx.MarshalBinary()
	require.NoError(t, err)
	balance := func(index int, amount string) map[string]any {
		return map[string]any{
			"accountIndex": index,
			"owner":        owner.String(),
			"mint":         mint.String(),
			"uiTokenAmount": map[string]any{
				"amount": amount, "decimals": 6, "uiAmount": 0.002, "uiAmountString": "0.002",
			},
		}
	}
	respond := func(result any) *rpc.Client {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			require.NoError(t, json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result}))
		}))
		t.Cleanup(server.Close)
		return rpc.New(server.URL)
	}

	t.Run("returns loaded account keys and raw token amounts", func(t *testing.T) {
		client := respond(map[string]any{
			"slot":        42,
			"transaction": []string{base64.StdEncoding.EncodeToString(wire), "base64"},
			"meta": map[string]any{
				"err":               nil,
				"fee":               5000,
				"preBalances":       []int{},
				"postBalances":      []int{},
				"loadedAddresses":   map[string]any{"writable": []string{loadedWritable.String()}, "readonly": []string{loadedReadonly.String()}},
				"preTokenBalances":  []any{balance(2, "200")},
				"postTokenBalances": []any{balance(2, "2200")},
			},
		})
		evidence, err := ConfirmedTransactionEvidence(context.Background(), client, solana.Signature{1})
		require.NoError(t, err)
		require.NotNil(t, evidence)
		assert.Equal(t, uint64(42), evidence.Slot)
		assert.Equal(t, []string{payer.String(), loadedWritable.String(), system.ProgramID.String(), loadedWritable.String(), loadedReadonly.String()}, evidence.AccountKeys)
		require.NotNil(t, evidence.Meta)
		assert.Nil(t, evidence.Meta.Err)
		assert.Equal(t, []FacilitatorTokenBalance{{AccountIndex: 2, Mint: mint.String(), Owner: owner.String(), UITokenAmount: FacilitatorTokenAmount{Amount: "200"}}}, evidence.Meta.PreTokenBalances)
		assert.Equal(t, "2200", evidence.Meta.PostTokenBalances[0].UITokenAmount.Amount)
	})

	t.Run("returns nothing for an unknown signature", func(t *testing.T) {
		evidence, err := ConfirmedTransactionEvidence(context.Background(), respond(nil), solana.Signature{1})
		require.NoError(t, err)
		assert.Nil(t, evidence)
	})
}
