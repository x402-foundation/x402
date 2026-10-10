package hedera

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	sdkproto "github.com/hiero-ledger/hiero-sdk-go/v2/proto/sdk"
	"github.com/hiero-ledger/hiero-sdk-go/v2/proto/services"
	hiero "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/proto"
)

type submissionOutcomeUnknownError struct {
	err error
}

func (e *submissionOutcomeUnknownError) Error() string {
	return e.err.Error()
}

func (e *submissionOutcomeUnknownError) Unwrap() error {
	return e.err
}

// addOperatorSignatures appends the facilitator fee-payer signature to every
// node variant in a TransactionList while preserving original BodyBytes.
//
// The Go SDK's Execute path remarsals TransactionBody (notably AccountID
// shard/realm encoding), which invalidates JS/TS client signatures. Signing
// and submitting at the protobuf layer avoids that.
func addOperatorSignatures(raw []byte, operatorKey hiero.PrivateKey) ([]*services.Transaction, hiero.TransactionID, error) {
	transactions, err := decodeAndValidateTransactionVariants(raw)
	if err != nil {
		return nil, hiero.TransactionID{}, err
	}

	pub := operatorKey.PublicKey()
	pubRaw := pub.BytesRaw()
	out := make([]*services.Transaction, 0, len(transactions))
	var txID hiero.TransactionID

	for _, wire := range transactions {
		if wire == nil {
			continue
		}
		signed := &services.SignedTransaction{}
		if len(wire.GetSignedTransactionBytes()) == 0 {
			return nil, hiero.TransactionID{}, fmt.Errorf("missing signed transaction bytes")
		}
		if err := proto.Unmarshal(wire.GetSignedTransactionBytes(), signed); err != nil {
			return nil, hiero.TransactionID{}, fmt.Errorf("decode signed transaction: %w", err)
		}
		if signed.GetSigMap() == nil {
			signed.SigMap = &services.SignatureMap{}
		}

		body := &services.TransactionBody{}
		if err := proto.Unmarshal(signed.GetBodyBytes(), body); err != nil {
			return nil, hiero.TransactionID{}, fmt.Errorf("decode transaction body: %w", err)
		}
		if txID.AccountID == nil {
			if parsed, err := transactionIDFromBody(body); err == nil {
				txID = parsed
			}
		}

		if !signatureMapHasKey(signed.GetSigMap(), pubRaw) {
			sig := operatorKey.Sign(signed.GetBodyBytes())
			signed.SigMap.SigPair = append(signed.SigMap.SigPair, signaturePairFor(pub, sig))
		}

		signedBytes, err := proto.Marshal(signed)
		if err != nil {
			return nil, hiero.TransactionID{}, err
		}
		out = append(out, &services.Transaction{SignedTransactionBytes: signedBytes})
	}
	if len(out) == 0 {
		return nil, hiero.TransactionID{}, fmt.Errorf("no transactions to submit")
	}
	return out, txID, nil
}

func decodeAndValidateTransactionVariants(raw []byte) ([]*services.Transaction, error) {
	list := &sdkproto.TransactionList{}
	if err := proto.Unmarshal(raw, list); err != nil {
		return nil, fmt.Errorf("decode transaction list: %w", err)
	}
	transactions := list.GetTransactionList()
	if len(transactions) == 0 {
		single := &services.Transaction{}
		if err := proto.Unmarshal(raw, single); err != nil {
			return nil, fmt.Errorf("decode transaction: %w", err)
		}
		transactions = []*services.Transaction{single}
	}

	var expected *services.TransactionBody
	for i, wire := range transactions {
		if wire == nil || len(wire.GetSignedTransactionBytes()) == 0 {
			return nil, fmt.Errorf("transaction variant %d has no signed transaction bytes", i)
		}
		signed := &services.SignedTransaction{}
		if err := proto.Unmarshal(wire.GetSignedTransactionBytes(), signed); err != nil {
			return nil, fmt.Errorf("decode transaction variant %d: %w", i, err)
		}
		if len(signed.GetBodyBytes()) == 0 {
			return nil, fmt.Errorf("transaction variant %d has no body bytes", i)
		}
		body := &services.TransactionBody{}
		if err := proto.Unmarshal(signed.GetBodyBytes(), body); err != nil {
			return nil, fmt.Errorf("decode transaction body variant %d: %w", i, err)
		}
		normalized := proto.Clone(body).(*services.TransactionBody)
		normalized.NodeAccountID = nil
		if expected == nil {
			expected = normalized
			continue
		}
		if !proto.Equal(expected, normalized) {
			return nil, fmt.Errorf("transaction variants differ beyond node account id")
		}
	}
	if expected == nil {
		return nil, fmt.Errorf("empty transaction list")
	}
	return transactions, nil
}

func signatureMapHasKey(sigMap *services.SignatureMap, pubRaw []byte) bool {
	if sigMap == nil {
		return false
	}
	for _, pair := range sigMap.GetSigPair() {
		if pair != nil && bytes.Equal(pair.GetPubKeyPrefix(), pubRaw) {
			return true
		}
	}
	return false
}

func signaturePairFor(pub hiero.PublicKey, signature []byte) *services.SignaturePair {
	prefix := pub.BytesRaw()
	// ECDSA secp256k1 compressed pubkeys are 33 bytes; ED25519 are 32.
	if len(prefix) == 33 {
		return &services.SignaturePair{
			PubKeyPrefix: prefix,
			Signature:    &services.SignaturePair_ECDSASecp256K1{ECDSASecp256K1: signature},
		}
	}
	return &services.SignaturePair{
		PubKeyPrefix: prefix,
		Signature:    &services.SignaturePair_Ed25519{Ed25519: signature},
	}
}

func transactionIDFromBody(body *services.TransactionBody) (hiero.TransactionID, error) {
	if body == nil || body.GetTransactionID() == nil ||
		body.GetTransactionID().GetAccountID() == nil ||
		body.GetTransactionID().GetTransactionValidStart() == nil {
		return hiero.TransactionID{}, fmt.Errorf("incomplete transaction id")
	}
	pb := body.GetTransactionID()
	accountID := pb.GetAccountID()
	acct := fmt.Sprintf("%d.%d.%d",
		accountID.GetShardNum(),
		accountID.GetRealmNum(),
		accountID.GetAccountNum(),
	)
	vs := pb.GetTransactionValidStart()
	return hiero.TransactionIdFromString(fmt.Sprintf("%s@%d.%09d", acct, vs.GetSeconds(), vs.GetNanos()))
}

func nodeAccountIDFromSigned(tx *services.Transaction) (hiero.AccountID, error) {
	signed := &services.SignedTransaction{}
	if err := proto.Unmarshal(tx.GetSignedTransactionBytes(), signed); err != nil {
		return hiero.AccountID{}, err
	}
	body := &services.TransactionBody{}
	if err := proto.Unmarshal(signed.GetBodyBytes(), body); err != nil {
		return hiero.AccountID{}, err
	}
	if body.GetNodeAccountID() == nil {
		return hiero.AccountID{}, fmt.Errorf("missing node account id")
	}
	nodeAccountID := body.GetNodeAccountID()
	return hiero.AccountID{
		Shard:   uint64(nodeAccountID.GetShardNum()),
		Realm:   uint64(nodeAccountID.GetRealmNum()),
		Account: uint64(nodeAccountID.GetAccountNum()),
	}, nil
}

func (s *PrivateKeyFacilitatorSigner) submitSignedTransfers(ctx context.Context, network string, txs []*services.Transaction) error {
	sdkClient, err := s.sdkClient(network)
	if err != nil {
		return err
	}
	defer sdkClient.Close()

	addrsByNode := map[string][]string{}
	for addr, id := range sdkClient.GetNetwork() {
		key := id.String()
		addrsByNode[key] = append(addrsByNode[key], addr)
	}

	var lastErr error
	var unknownErr error
	for _, tx := range txs {
		nodeID, err := nodeAccountIDFromSigned(tx)
		if err != nil {
			lastErr = err
			continue
		}
		addrs := addrsByNode[nodeID.String()]
		if len(addrs) == 0 {
			resolved, resolveErr := s.resolveNodeAddresses(ctx, network, nodeID.String())
			if resolveErr != nil {
				lastErr = fmt.Errorf("no network address for node %s: %w", nodeID.String(), resolveErr)
				continue
			}
			addrs = resolved
			addrsByNode[nodeID.String()] = resolved
		}
		limit := 2
		if len(addrs) < limit {
			limit = len(addrs)
		}
		for _, addr := range addrs[:limit] {
			if err := grpcCryptoTransfer(ctx, addr, tx); err != nil {
				lastErr = err
				var unknown *submissionOutcomeUnknownError
				if errors.As(err, &unknown) {
					unknownErr = err
				}
				continue
			}
			return nil
		}
	}
	if unknownErr != nil {
		return unknownErr
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no node accepted transaction")
	}
	return lastErr
}

type mirrorNetworkNodesResponse struct {
	Nodes []struct {
		NodeAccountID    string `json:"node_account_id"`
		ServiceEndpoints []struct {
			IPAddressV4 string `json:"ip_address_v4"`
			DomainName  string `json:"domain_name"`
			Port        int    `json:"port"`
		} `json:"service_endpoints"`
	} `json:"nodes"`
}

func (s *PrivateKeyFacilitatorSigner) resolveNodeAddresses(ctx context.Context, network, nodeAccountID string) ([]string, error) {
	base, err := mirrorURLForNetwork(network, s.mirrorNodeURL)
	if err != nil {
		return nil, err
	}
	var resp mirrorNetworkNodesResponse
	url := strings.TrimRight(base, "/") + "/api/v1/network/nodes?account.id=" + nodeAccountID + "&limit=1"
	if err := s.http.getJSON(ctx, url, &resp); err != nil {
		return nil, err
	}
	var addrs []string
	for _, node := range resp.Nodes {
		if node.NodeAccountID != "" && !accountIDsEqual(node.NodeAccountID, nodeAccountID) {
			continue
		}
		for _, ep := range node.ServiceEndpoints {
			if ep.Port != 50211 {
				continue
			}
			host := strings.TrimSpace(ep.DomainName)
			if host == "" {
				host = strings.TrimSpace(ep.IPAddressV4)
			}
			if host == "" {
				continue
			}
			addrs = append(addrs, fmt.Sprintf("%s:%d", host, ep.Port))
		}
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("mirror has no :50211 endpoint for %s", nodeAccountID)
	}
	return addrs, nil
}

func grpcCryptoTransfer(ctx context.Context, address string, tx *services.Transaction) error {
	conn, err := grpc.NewClient(address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return fmt.Errorf("dial %s: %w", address, err)
	}
	defer conn.Close()

	client := services.NewCryptoServiceClient(conn)
	callCtx, callCancel := context.WithTimeout(ctx, 5*time.Second)
	defer callCancel()

	resp, err := client.CryptoTransfer(callCtx, tx)
	if err != nil {
		return &submissionOutcomeUnknownError{
			err: fmt.Errorf("cryptoTransfer %s: %w", address, err),
		}
	}
	code := resp.GetNodeTransactionPrecheckCode()
	if code != services.ResponseCodeEnum_OK {
		return fmt.Errorf("precheck %s from %s", code.String(), address)
	}
	return nil
}
