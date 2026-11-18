package client

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestCreatePaymentPayloadUsesMintTokenProgram(t *testing.T) {
	legacyMint := solana.NewWallet().PublicKey()
	token2022Mint := solana.NewWallet().PublicKey()
	programs := map[string]solana.PublicKey{
		legacyMint.String():    solana.TokenProgramID,
		token2022Mint.String(): solana.Token2022ProgramID,
	}
	// Both programs support this initialized, extension-free mint layout.
	mintData := make([]byte, 82)
	binary.LittleEndian.PutUint64(mintData[36:44], 1_000_000)
	mintData[44] = 6 // decimals
	mintData[45] = 1 // initialized
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     json.RawMessage   `json:"id"`
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		if request.Method != "getAccountInfo" || len(request.Params) == 0 {
			t.Errorf("unexpected RPC call: %s", request.Method)
			http.Error(w, "unexpected method", http.StatusBadRequest)
			return
		}
		var mint string
		if err := json.Unmarshal(request.Params[0], &mint); err != nil {
			t.Error(err)
			http.Error(w, "invalid mint", http.StatusBadRequest)
			return
		}
		program, ok := programs[mint]
		if !ok {
			t.Errorf("unexpected mint: %s", mint)
			http.Error(w, "unknown mint", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, err := w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(request.ID) + `,"result":{"context":{"slot":1234},"value":{"data":["` + base64.StdEncoding.EncodeToString(mintData) + `","base64"],"executable":false,"lamports":1000000,"owner":"` + program.String() + `","rentEpoch":0}}}`))
		if err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(server.Close)

	signer := &mockClientSigner{keypair: solana.NewWallet().PrivateKey}
	client := NewExactSvmScheme(signer, &svm.ClientConfig{RPCURL: server.URL})
	payTo := solana.NewWallet().PublicKey()
	feePayer := solana.NewWallet().PublicKey()
	cases := []struct {
		name    string
		mint    solana.PublicKey
		program solana.PublicKey
	}{
		{"legacy_token", legacyMint, solana.TokenProgramID},
		{"token_2022", token2022Mint, solana.Token2022ProgramID},
		{"legacy_after_token_2022", legacyMint, solana.TokenProgramID},
	}
	for _, parallel := range []bool{false, true} {
		name := "sequential"
		if parallel {
			name = "parallel"
		}
		t.Run(name, func(t *testing.T) {
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					if parallel {
						t.Parallel()
					}
					payload, err := client.CreatePaymentPayload(context.Background(), types.PaymentRequirements{
						Scheme: "exact", Network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
						Asset: tc.mint.String(), Amount: "100000", PayTo: payTo.String(), MaxTimeoutSeconds: 60,
						Extra: map[string]interface{}{"feePayer": feePayer.String(), "recentBlockhash": fixedBlockhash, "memo": "token-program-test"},
					}, x402.PaymentPayloadContext{})
					require.NoError(t, err)
					transaction, err := svm.DecodeTransaction(payload.Payload["transaction"].(string))
					require.NoError(t, err)
					require.Len(t, transaction.Message.Instructions, 4)
					transfer := transaction.Message.Instructions[2]
					program, err := transaction.Message.Program(transfer.ProgramIDIndex)
					require.NoError(t, err)
					accounts, err := transfer.ResolveInstructionAccounts(&transaction.Message)
					require.NoError(t, err)
					require.Len(t, accounts, 4)
					expectedSource, _, err := solana.FindProgramAddress(
						[][]byte{signer.Address().Bytes(), tc.program.Bytes(), tc.mint.Bytes()}, solana.SPLAssociatedTokenAccountProgramID,
					)
					require.NoError(t, err)
					expectedDestination, _, err := solana.FindProgramAddress(
						[][]byte{payTo.Bytes(), tc.program.Bytes(), tc.mint.Bytes()}, solana.SPLAssociatedTokenAccountProgramID,
					)
					require.NoError(t, err)
					assert.Equal(t, tc.program, program, "transfer program must match the mint owner")
					assert.Equal(t, expectedSource, accounts[0].PublicKey, "source ATA must use the mint's token program")
					assert.Equal(t, expectedDestination, accounts[2].PublicKey, "destination ATA must use the mint's token program")
					assert.Equal(t, tc.mint, accounts[1].PublicKey)
					assert.Equal(t, signer.Address(), accounts[3].PublicKey)
					assert.True(t, accounts[0].IsWritable, "source token account must be writable")
					assert.False(t, accounts[0].IsSigner)
					assert.False(t, accounts[1].IsWritable, "mint must be readonly")
					assert.False(t, accounts[1].IsSigner)
					assert.True(t, accounts[2].IsWritable, "destination token account must be writable")
					assert.False(t, accounts[2].IsSigner)
					assert.True(t, accounts[3].IsSigner, "owner must sign the transfer")
					assert.False(t, accounts[3].IsWritable)
					decoded, err := token.DecodeInstruction(accounts, transfer.Data)
					require.NoError(t, err)
					checked, ok := decoded.Impl.(*token.TransferChecked)
					require.True(t, ok)
					assert.Equal(t, uint64(100000), *checked.Amount)
					assert.Equal(t, uint8(6), *checked.Decimals)
					assert.Equal(t, feePayer, transaction.Message.AccountKeys[0])
					assert.Equal(t, fixedBlockhash, transaction.Message.RecentBlockhash.String())
					assert.Equal(t, "token-program-test", string(transaction.Message.Instructions[3].Data))
					message, err := transaction.Message.MarshalBinary()
					require.NoError(t, err)
					signerIndex, err := transaction.GetAccountIndex(signer.Address())
					require.NoError(t, err)
					require.Greater(t, len(transaction.Signatures), int(signerIndex))
					assert.True(t, transaction.Signatures[signerIndex].Verify(signer.Address(), message))
				})
			}
		})
	}
	assert.Equal(t, solana.TokenProgramID, token.ProgramID, "construction must not change the process-wide token program")
}
