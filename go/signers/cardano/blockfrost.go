package cardano

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

const (
	submitPath = "/tx/submit"
	// utxoPageSize is Blockfrost's maximum page size.
	utxoPageSize = 100
	// maxResponseBytes bounds a Blockfrost response body.
	maxResponseBytes = 8 << 20
)

// Utxo is an unspent output reported by the chain provider.
type Utxo struct {
	TxHash  string
	Index   uint32
	Address string
	Coin    uint64
	// Assets maps policyId.assetNameHex to quantity.
	Assets             map[string]uint64
	HasDatum           bool
	HasReferenceScript bool
}

// Ref returns the UTxO reference txHash#index.
func (u Utxo) Ref() string { return x402cardano.FormatUtxoRef(u.TxHash, u.Index) }

// ProtocolParameters are the parameters the transaction builder needs, in
// Blockfrost naming; the facilitator converts them to the subset
// x402cardano.ProtocolParameters its phase-1 checks use.
type ProtocolParameters struct {
	MinFeeA          uint64
	MinFeeB          uint64
	CoinsPerUtxoByte uint64
	MaxTxSize        int
}

// TxOutputInfo describes an output of a known transaction. ConsumedBy is nil
// when the provider does not report spending, empty when unspent.
type TxOutputInfo struct {
	Address    string
	Coin       uint64
	Assets     map[string]uint64
	ConsumedBy *string
}

// Blockfrost is a minimal Blockfrost API client.
type Blockfrost struct {
	baseURL   string
	projectID string
	client    *http.Client
}

// NewBlockfrost creates a client for baseURL (e.g. https://cardano-preprod.blockfrost.io/api/v0).
// timeout bounds each request; zero uses the mechanism default.
func NewBlockfrost(baseURL, projectID string, timeout time.Duration) *Blockfrost {
	if timeout <= 0 {
		timeout = x402cardano.DefaultProviderTimeout
	}
	return &Blockfrost{
		baseURL:   strings.TrimRight(baseURL, "/"),
		projectID: projectID,
		client:    &http.Client{Timeout: timeout},
	}
}

// DefaultBlockfrostURL returns the public Blockfrost endpoint for network.
func DefaultBlockfrostURL(network string) (string, error) {
	switch x402cardano.NormalizeNetwork(network) {
	case x402cardano.CardanoMainnetCAIP2:
		return "https://cardano-mainnet.blockfrost.io/api/v0", nil
	case x402cardano.CardanoPreprodCAIP2:
		return "https://cardano-preprod.blockfrost.io/api/v0", nil
	case x402cardano.CardanoPreviewCAIP2:
		return "https://cardano-preview.blockfrost.io/api/v0", nil
	}
	return "", fmt.Errorf("unsupported Cardano network: %s", network)
}

// APIError is a non-2xx Blockfrost response.
type APIError struct {
	Path       string
	StatusCode int
	Body       string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("blockfrost %s failed: %d %s", e.Path, e.StatusCode, e.Body)
}

type blockfrostAmount struct {
	Unit     string `json:"unit"`
	Quantity string `json:"quantity"`
}

type blockfrostUtxo struct {
	TxHash              string             `json:"tx_hash"`
	OutputIndex         uint32             `json:"output_index"`
	Address             string             `json:"address"`
	Amount              []blockfrostAmount `json:"amount"`
	DataHash            *string            `json:"data_hash"`
	InlineDatum         *string            `json:"inline_datum"`
	ReferenceScriptHash *string            `json:"reference_script_hash"`
	ConsumedByTx        presence           `json:"consumed_by_tx"`
}

// presence records whether a JSON field was sent: Blockfrost reports
// consumed_by_tx as null for unspent outputs.
type presence struct {
	sent  bool
	value *string
}

func (p *presence) UnmarshalJSON(raw []byte) error {
	p.sent = true
	if string(raw) == "null" {
		return nil
	}
	return json.Unmarshal(raw, &p.value)
}

// UtxosAt returns all unspent outputs at address.
func (b *Blockfrost) UtxosAt(ctx context.Context, address string) ([]Utxo, error) {
	var all []Utxo
	for page := 1; ; page++ {
		var batch []blockfrostUtxo
		found, err := b.get(ctx, fmt.Sprintf("/addresses/%s/utxos?page=%d&count=%d", address, page, utxoPageSize), &batch)
		if err != nil {
			return nil, err
		}
		if !found {
			return all, nil
		}
		for _, raw := range batch {
			coin, assets, err := parseAmounts(raw.Amount)
			if err != nil {
				return nil, err
			}
			all = append(all, Utxo{
				TxHash:             strings.ToLower(raw.TxHash),
				Index:              raw.OutputIndex,
				Address:            raw.Address,
				Coin:               coin,
				Assets:             assets,
				HasDatum:           raw.DataHash != nil || raw.InlineDatum != nil,
				HasReferenceScript: raw.ReferenceScriptHash != nil,
			})
		}
		if len(batch) < utxoPageSize {
			return all, nil
		}
	}
}

// TxOutput returns output index of txHash, or nil when the transaction or output is unknown.
func (b *Blockfrost) TxOutput(ctx context.Context, txHash string, index uint32) (*TxOutputInfo, error) {
	var tx struct {
		Outputs []blockfrostUtxo `json:"outputs"`
	}
	found, err := b.get(ctx, "/txs/"+txHash+"/utxos", &tx)
	if err != nil || !found {
		return nil, err
	}
	for _, out := range tx.Outputs {
		if out.OutputIndex != index {
			continue
		}
		coin, assets, err := parseAmounts(out.Amount)
		if err != nil {
			return nil, err
		}
		info := &TxOutputInfo{Address: out.Address, Coin: coin, Assets: assets}
		if out.ConsumedByTx.sent {
			consumedBy := ""
			if out.ConsumedByTx.value != nil {
				consumedBy = *out.ConsumedByTx.value
			}
			info.ConsumedBy = &consumedBy
		}
		return info, nil
	}
	return nil, nil
}

// ProtocolParameters returns the latest epoch's parameters.
func (b *Blockfrost) ProtocolParameters(ctx context.Context) (*ProtocolParameters, error) {
	var raw struct {
		MinFeeA          json.Number `json:"min_fee_a"`
		MinFeeB          json.Number `json:"min_fee_b"`
		CoinsPerUtxoSize string      `json:"coins_per_utxo_size"`
		MaxTxSize        json.Number `json:"max_tx_size"`
	}
	found, err := b.get(ctx, "/epochs/latest/parameters", &raw)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, errors.New("blockfrost returned no protocol parameters")
	}
	params := &ProtocolParameters{}
	var parseErr error
	parse := func(s string) uint64 {
		v, err := strconv.ParseUint(s, 10, 64)
		if err != nil && parseErr == nil {
			parseErr = fmt.Errorf("invalid protocol parameter %q", s)
		}
		return v
	}
	params.MinFeeA = parse(raw.MinFeeA.String())
	params.MinFeeB = parse(raw.MinFeeB.String())
	params.CoinsPerUtxoByte = parse(raw.CoinsPerUtxoSize)
	params.MaxTxSize = int(parse(raw.MaxTxSize.String()))
	return params, parseErr
}

// Submit posts signed transaction bytes unchanged and returns the transaction id.
func (b *Blockfrost) Submit(ctx context.Context, tx []byte) (string, error) {
	var txHash string
	if err := b.post(ctx, submitPath, "application/cbor", tx, &txHash); err != nil {
		return "", err
	}
	return strings.ToLower(txHash), nil
}

// Evaluate dry-runs the Plutus scripts of a signed transaction.
func (b *Blockfrost) Evaluate(ctx context.Context, tx []byte) error {
	body, _ := json.Marshal(map[string]interface{}{"cbor": hex.EncodeToString(tx), "additionalUtxoSet": []interface{}{}})
	var resp struct {
		Type  string `json:"type"`
		Fault *struct {
			String string `json:"string"`
		} `json:"fault"`
		Result *struct {
			EvaluationFailure json.RawMessage `json:"EvaluationFailure"`
		} `json:"result"`
	}
	if err := b.post(ctx, "/utils/txs/evaluate/utxos", "application/json", body, &resp); err != nil {
		return err
	}
	switch {
	case resp.Type == "jsonwsp/fault":
		msg := "unknown fault"
		if resp.Fault != nil {
			msg = resp.Fault.String
		}
		return fmt.Errorf("blockfrost evaluation fault: %s", msg)
	case resp.Result == nil:
		return errors.New("blockfrost evaluation returned no result")
	case len(resp.Result.EvaluationFailure) > 0:
		return fmt.Errorf("blockfrost script evaluation failed: %s", resp.Result.EvaluationFailure)
	}
	return nil
}

// Evidence reports whether txHash is on chain and how deep. Phase-2 invalid
// transactions report unknown: they paid nothing.
func (b *Blockfrost) Evidence(ctx context.Context, txHash string) (*x402cardano.SettlementEvidence, error) {
	unknown := &x402cardano.SettlementEvidence{Status: x402cardano.EvidenceUnknown, Confirmations: x402cardano.MinL1Confirmations - 1}
	var tx struct {
		BlockHeight   *int64 `json:"block_height"`
		ValidContract *bool  `json:"valid_contract"`
	}
	found, err := b.get(ctx, "/txs/"+txHash, &tx)
	if err != nil {
		return nil, err
	}
	if !found {
		return unknown, nil
	}
	// Incomplete responses are lookup failures, never evidence.
	if tx.BlockHeight == nil || tx.ValidContract == nil {
		return nil, errors.New("blockfrost transaction response lacks block_height or valid_contract")
	}
	if !*tx.ValidContract {
		return unknown, nil
	}
	var tip struct {
		Height *int64 `json:"height"`
	}
	if _, err := b.get(ctx, "/blocks/latest", &tip); err != nil {
		return nil, err
	}
	if tip.Height == nil || *tip.Height < *tx.BlockHeight {
		return nil, errors.New("blockfrost chain tip is missing or behind the transaction's block")
	}
	return &x402cardano.SettlementEvidence{Status: x402cardano.EvidenceConfirmed, Confirmations: int(*tip.Height - *tx.BlockHeight)}, nil
}

func parseAmounts(amounts []blockfrostAmount) (uint64, map[string]uint64, error) {
	var coin uint64
	assets := map[string]uint64{}
	for _, a := range amounts {
		qty, err := strconv.ParseUint(a.Quantity, 10, 64)
		if err != nil {
			return 0, nil, fmt.Errorf("invalid quantity %q for %s", a.Quantity, a.Unit)
		}
		if a.Unit == x402cardano.LovelaceAsset {
			coin = qty
			continue
		}
		if len(a.Unit) < 56 {
			return 0, nil, fmt.Errorf("invalid asset unit %q", a.Unit)
		}
		assets[strings.ToLower(a.Unit[:56]+"."+a.Unit[56:])] = qty
	}
	return coin, assets, nil
}

func (b *Blockfrost) get(ctx context.Context, path string, out interface{}) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.baseURL+path, nil)
	if err != nil {
		return false, err
	}
	return b.do(req, path, out)
}

func (b *Blockfrost) post(ctx context.Context, path, contentType string, body []byte, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	found, err := b.do(req, path, out)
	if err == nil && !found {
		return &APIError{Path: path, StatusCode: http.StatusNotFound}
	}
	return err
}

func (b *Blockfrost) do(req *http.Request, path string, out interface{}) (bool, error) {
	if b.projectID != "" {
		req.Header.Set("project_id", b.projectID)
	}
	resp, err := b.client.Do(req)
	if err != nil {
		return false, fmt.Errorf("blockfrost %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return false, fmt.Errorf("blockfrost %s: %w", path, err)
	}
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return false, &APIError{Path: path, StatusCode: resp.StatusCode, Body: strings.TrimSpace(string(body))}
	}
	if err := json.Unmarshal(body, out); err != nil {
		return false, fmt.Errorf("blockfrost %s: invalid response: %w", path, err)
	}
	return true, nil
}
