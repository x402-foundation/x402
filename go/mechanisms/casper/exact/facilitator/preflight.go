package facilitator

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/make-software/casper-go-sdk/v2/casper"
	"github.com/make-software/casper-go-sdk/v2/rpc"
	caspertypes "github.com/make-software/casper-go-sdk/v2/types"
	"github.com/make-software/casper-go-sdk/v2/types/clvalue"
	"github.com/make-software/casper-go-sdk/v2/types/clvalue/cltype"
	"github.com/make-software/casper-go-sdk/v2/types/key"
	"golang.org/x/crypto/blake2b"

	x402 "github.com/x402-foundation/x402/go/v2"
	casperMechanism "github.com/x402-foundation/x402/go/v2/mechanisms/casper"
	x402types "github.com/x402-foundation/x402/go/v2/types"
)

// validateTargetedPreflight reads one block's state so contract, balance, nonce,
// and authorization time checks cannot accidentally use different snapshots.
func (f *ExactCasperScheme) validateTargetedPreflight(
	ctx context.Context,
	p *casperMechanism.ExactCasperPayload,
	requirements x402types.PaymentRequirements,
	networkCfg casperMechanism.NetworkConfig,
) error {
	fail := func(reason, message string) error {
		return x402.NewVerifyError(reason, p.Authorization.From, message)
	}
	client := casper.NewRPCClient(casper.NewRPCHandler(networkCfg.RPCURL, http.DefaultClient))
	block, err := client.GetLatestBlock(ctx)
	if err != nil {
		return fail(ErrPreflightFailed, "read latest block: "+err.Error())
	}
	chainTime := time.Time(block.Block.Timestamp)
	protocolMajor, err := strconv.ParseUint(strings.Split(block.Block.ProtocolVersion, ".")[0], 10, 16)
	if err != nil || protocolMajor == 0 || chainTime.IsZero() || block.Block.StateRootHash == (key.Hash{}) {
		return fail(ErrPreflightFailed, "latest block is missing valid state, timestamp, or protocol version")
	}
	// Verify has already parsed these values, but the chain time must also obey
	// CEP-3009's strict bounds; the facilitator's wall clock is not authoritative.
	validAfter, _ := strconv.ParseUint(p.Authorization.ValidAfter, 10, 64)
	validBefore, _ := strconv.ParseUint(p.Authorization.ValidBefore, 10, 64)
	chainNow := uint64(chainTime.Unix())
	if chainNow <= validAfter {
		return fail(ErrNotYetValid, "authorization is not yet valid at current chain time")
	}
	if chainNow >= validBefore {
		return fail(ErrPayloadExpired, "authorization has expired at current chain time")
	}

	stateRoot := block.Block.StateRootHash.String()
	packageResult, err := client.QueryGlobalStateByStateHash(ctx, &stateRoot, "hash-"+requirements.Asset, []string{})
	if err != nil {
		return fail(ErrPreflightFailed, "read token package: "+err.Error())
	}
	contractPackage := packageResult.StoredValue.ContractPackage
	if contractPackage == nil {
		return fail(ErrUnsupportedAsset, "asset is not a contract package")
	}
	version, ok := activeContractVersion(contractPackage, uint16(protocolMajor))
	if !ok {
		return fail(ErrUnsupportedAsset, "token package has no enabled version for the current or an earlier protocol")
	}
	contractResult, err := client.QueryGlobalStateByStateHash(ctx, &stateRoot, "hash-"+version.Hash.String(), []string{})
	if err != nil {
		return fail(ErrPreflightFailed, "read active token contract: "+err.Error())
	}
	contract := contractResult.StoredValue.Contract
	if contract == nil || !supportsAuthorization(contract) {
		return fail(ErrUnsupportedAsset, "active token contract does not support transfer_with_authorization")
	}
	balances, err := contract.NamedKeys.Find("balances")
	if err != nil || balances.URef == nil {
		return fail(ErrUnsupportedAsset, "token contract is missing the balances dictionary URef")
	}
	usedNonces, err := contract.NamedKeys.Find("used_nonces")
	if err != nil || usedNonces.URef == nil {
		return fail(ErrUnsupportedAsset, "token contract is missing the used_nonces dictionary URef")
	}
	payerKey, err := hex.DecodeString(p.Authorization.From)
	if err != nil || len(payerKey) != 33 || (payerKey[0] != key.TypeIDAccount && payerKey[0] != key.TypeIDHash) {
		return fail(ErrMalformedPayload, "payer must be a serialized account or contract Key")
	}
	// CEP-18 balance keys are base64(serialized Key), including its variant tag.
	balanceResult, err := client.GetDictionaryItem(ctx, &stateRoot, balances.URef.String(), base64.StdEncoding.EncodeToString(payerKey))
	if err != nil {
		if dictionaryItemMissing(err) {
			return fail(ErrInsufficientBalance, "payer has no token balance")
		}
		return fail(ErrPreflightFailed, "read payer balance: "+err.Error())
	}
	balance, err := preflightCLValue(balanceResult.StoredValue.CLValue, cltype.UInt256)
	if err != nil || balance.UI256 == nil || balance.UI256.Value().BitLen() > 256 {
		return fail(ErrPreflightFailed, "balance dictionary did not return a valid U256")
	}
	amount, ok := new(big.Int).SetString(p.Authorization.Value, 10)
	if !ok || balance.UI256.Value().Cmp(amount) < 0 {
		return fail(ErrInsufficientBalance, "payer token balance is less than the authorized amount")
	}
	nonce, err := hex.DecodeString(p.Authorization.Nonce)
	if err != nil || len(nonce) != 32 {
		return fail(ErrMalformedPayload, "nonce must contain 32 bytes")
	}
	// CEP-3009: hex(blake2b256(Key::to_bytes() || Bytes::to_bytes())).
	// Casper Bytes includes a little-endian u32 length before the nonce bytes.
	nonceInput := make([]byte, 0, len(payerKey)+4+len(nonce))
	nonceInput = append(nonceInput, payerKey...)
	nonceInput = binary.LittleEndian.AppendUint32(nonceInput, uint32(len(nonce)))
	nonceInput = append(nonceInput, nonce...)
	nonceHash := blake2b.Sum256(nonceInput)
	nonceResult, err := client.GetDictionaryItem(ctx, &stateRoot, usedNonces.URef.String(), hex.EncodeToString(nonceHash[:]))
	if err != nil {
		if dictionaryItemMissing(err) {
			return nil // CEP-3009 defines a missing entry as an unused nonce.
		}
		return fail(ErrPreflightFailed, "read authorization nonce: "+err.Error())
	}
	used, err := preflightCLValue(nonceResult.StoredValue.CLValue, cltype.Bool)
	if err != nil || used.Bool == nil {
		return fail(ErrPreflightFailed, "used_nonces dictionary did not return a valid Bool")
	}
	if used.Bool.Value() {
		return fail(ErrAuthorizationUsed, "authorization nonce has been consumed or canceled")
	}
	return nil
}

func activeContractVersion(contractPackage *caspertypes.ContractPackage, protocolMajor uint16) (caspertypes.ContractVersion, bool) {
	var latest caspertypes.ContractVersion
	found := false
	for _, version := range contractPackage.Versions {
		if version.ProtocolVersionMajor > protocolMajor || version.Version == 0 || version.Hash.Hash == (key.Hash{}) {
			continue
		}
		disabled := false
		for _, disabledVersion := range contractPackage.DisabledVersions {
			if disabledVersion == (caspertypes.ContractVersionKey{int(version.ProtocolVersionMajor), int(version.Version)}) {
				disabled = true
				break
			}
		}
		if disabled {
			continue
		}
		if !found || version.ProtocolVersionMajor > latest.ProtocolVersionMajor ||
			(version.ProtocolVersionMajor == latest.ProtocolVersionMajor && version.Version > latest.Version) {
			latest, found = version, true
		}
	}
	return latest, found
}

func supportsAuthorization(contract *caspertypes.Contract) bool {
	for _, entryPoint := range contract.EntryPoints {
		if entryPoint.Name == "transfer_with_authorization" || entryPoint.EntryPoint.Name == "transfer_with_authorization" {
			return true
		}
	}
	return false
}

// Recognize the explicit missing-value response, never a missing dictionary
// seed, unavailable state root, timeout, or malformed response. The URef has
// already been resolved from the active contract at this state root.
func dictionaryItemMissing(err error) bool {
	var rpcErr *rpc.RpcError
	if !errors.As(err, &rpcErr) || rpcErr.Code != -32003 {
		return false
	}
	var detail string
	if json.Unmarshal(rpcErr.Data, &detail) != nil {
		return false
	}
	return detail == "value was not found in the global state" || strings.HasPrefix(detail, "ValueNotFound(")
}

func preflightCLValue(argument *caspertypes.Argument, expected cltype.CLType) (clvalue.CLValue, error) {
	if argument == nil {
		return clvalue.CLValue{}, errors.New("missing CLValue")
	}
	value, err := argument.Value()
	if err != nil {
		return clvalue.CLValue{}, err
	}
	if value.GetType() != expected {
		return clvalue.CLValue{}, errors.New("unexpected CLValue type")
	}
	raw, err := argument.Raw()
	if err != nil || !bytes.Equal(raw.Bytes, value.Bytes()) {
		return clvalue.CLValue{}, errors.New("noncanonical CLValue bytes")
	}
	return value, nil
}
