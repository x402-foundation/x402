package paymentchannels

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// discoveryAccount is a canned getProgramAccounts row a test can tamper with
// before serving it, to exercise DiscoverChannelsByRentPayer's independent
// validation of what the RPC provider claims matched its filters.
type discoveryAccount struct {
	pubkey solana.PublicKey
	owner  solana.PublicKey
	data   []byte
}

func newDiscoveryStub(t *testing.T, accounts []discoveryAccount) (*rpc.Client, *[]rpc.RPCFilter) {
	t.Helper()

	var capturedFilters []rpc.RPCFilter
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     interface{}       `json:"id"`
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		require.Equal(t, "getProgramAccounts", request.Method)

		var opts rpc.GetProgramAccountsOpts
		require.NoError(t, json.Unmarshal(request.Params[1], &opts))
		capturedFilters = opts.Filters

		results := make([]map[string]interface{}, 0, len(accounts))
		for _, account := range accounts {
			results = append(results, map[string]interface{}{
				"pubkey": account.pubkey.String(),
				"account": map[string]interface{}{
					"data":       []interface{}{base64.StdEncoding.EncodeToString(account.data), "base64"},
					"executable": false,
					"lamports":   2_000_000,
					"owner":      account.owner.String(),
					"rentEpoch":  0,
					"space":      len(account.data),
				},
			})
		}

		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"result":  results,
		}))
	}))
	t.Cleanup(server.Close)

	return rpc.New(server.URL), &capturedFilters
}

// validDiscoveryChannel builds a channel account whose payer/payee/mint/
// authorizedSigner/salt/openSlot rederive to its own pubkey, as a genuine
// onchain channel must.
func validDiscoveryChannel(t *testing.T, rentPayer solana.PublicKey) (solana.PublicKey, []byte) {
	t.Helper()

	payer := testKeypair(t).PublicKey()
	payee := testKeypair(t).PublicKey()
	authorizedSigner := testKeypair(t).PublicKey()
	mint := testKeypair(t).PublicKey()
	salt, openSlot := uint64(7), uint64(341_000_000)

	pda, err := FindChannelPDA(payer, payee, mint, authorizedSigner, salt, openSlot)
	require.NoError(t, err)

	data := make([]byte, ChannelAccountSize)
	data[0] = ChannelAccountDiscriminator
	data[3] = byte(StatusDistributed)
	copy(data[4:12], u64LE(salt))
	copy(data[ChannelPayerOffset:ChannelPayerOffset+32], payer.Bytes())
	copy(data[ChannelPayeeOffset:ChannelPayeeOffset+32], payee.Bytes())
	copy(data[ChannelAuthorizedSignerOffset:ChannelAuthorizedSignerOffset+32], authorizedSigner.Bytes())
	copy(data[ChannelMintOffset:ChannelMintOffset+32], mint.Bytes())
	copy(data[ChannelRentPayerOffset:ChannelRentPayerOffset+32], rentPayer.Bytes())
	copy(data[ChannelOpenSlotOffset:ChannelOpenSlotOffset+8], u64LE(openSlot))
	return pda, data
}

func TestDiscoverChannelsByRentPayer_AcceptsValidatedAccount(t *testing.T) {
	rentPayer := testKeypair(t).PublicKey()
	pda, data := validDiscoveryChannel(t, rentPayer)

	client, filters := newDiscoveryStub(t, []discoveryAccount{
		{pubkey: pda, owner: ProgramID, data: data},
	})

	discovered, err := DiscoverChannelsByRentPayer(t.Context(), client, rentPayer)
	require.NoError(t, err)
	require.Len(t, discovered, 1)
	assert.Equal(t, pda, discovered[0].ChannelID)
	assert.Equal(t, rentPayer, discovered[0].Channel.RentPayer)

	require.Len(t, *filters, 2)
	assert.EqualValues(t, ChannelAccountSize, (*filters)[0].DataSize)
	require.NotNil(t, (*filters)[1].Memcmp)
	assert.EqualValues(t, ChannelRentPayerOffset, (*filters)[1].Memcmp.Offset)
	assert.Equal(t, solana.Base58(rentPayer.Bytes()), (*filters)[1].Memcmp.Bytes)
}

func TestDiscoverChannelsByRentPayer_RejectsWrongOwner(t *testing.T) {
	rentPayer := testKeypair(t).PublicKey()
	pda, data := validDiscoveryChannel(t, rentPayer)

	client, _ := newDiscoveryStub(t, []discoveryAccount{
		{pubkey: pda, owner: testKeypair(t).PublicKey(), data: data},
	})

	discovered, err := DiscoverChannelsByRentPayer(t.Context(), client, rentPayer)
	require.NoError(t, err)
	assert.Empty(t, discovered)
}

func TestDiscoverChannelsByRentPayer_RejectsPDAMismatch(t *testing.T) {
	rentPayer := testKeypair(t).PublicKey()
	_, data := validDiscoveryChannel(t, rentPayer)

	// A different pubkey than the one the account's fields actually derive to
	// must be rejected even though the RPC provider claims it matched.
	wrongPubkey := testKeypair(t).PublicKey()
	client, _ := newDiscoveryStub(t, []discoveryAccount{
		{pubkey: wrongPubkey, owner: ProgramID, data: data},
	})

	discovered, err := DiscoverChannelsByRentPayer(t.Context(), client, rentPayer)
	require.NoError(t, err)
	assert.Empty(t, discovered)
}

func TestDiscoverChannelsByRentPayer_RejectsMalformedAccount(t *testing.T) {
	rentPayer := testKeypair(t).PublicKey()
	pda := testKeypair(t).PublicKey()

	client, _ := newDiscoveryStub(t, []discoveryAccount{
		{pubkey: pda, owner: ProgramID, data: []byte{0x01, 0x02}},
	})

	discovered, err := DiscoverChannelsByRentPayer(t.Context(), client, rentPayer)
	require.NoError(t, err)
	assert.Empty(t, discovered)
}
