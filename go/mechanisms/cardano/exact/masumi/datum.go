package masumi

import (
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"

	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/blinklabs-io/plutigo/data"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

const credentialHashBytes = 28

// Credential is a payment or stake credential in datum form: the hash as hex,
// unlike the byte-slice cardano.Credential parsed from addresses.
type Credential struct {
	IsScript bool
	// Hash is the lowercase hex of the 28-byte credential hash.
	Hash string
}

// Pointer is a legacy pointer stake reference.
type Pointer struct {
	Slot      *big.Int
	TxIndex   *big.Int
	CertIndex *big.Int
}

// AddressCredentials is an address split into its payment credential and
// optional stake credential or pointer.
type AddressCredentials struct {
	Payment Credential
	Stake   *Credential
	Pointer *Pointer
}

// LockDatumInput are the field values of a fresh lock datum. Empty return
// addresses encode as None.
type LockDatumInput struct {
	BuyerAddress              string
	SellerAddress             string
	BuyerReturnAddress        string
	SellerReturnAddress       string
	ReferenceKey              string
	ReferenceSignature        string
	SellerNonce               string
	BuyerNonce                string
	AgentIdentifier           string
	CollateralReturnLovelace  uint64
	InputHash                 string
	PayByTime                 *big.Int
	SubmitResultTime          *big.Int
	UnlockTime                *big.Int
	ExternalDisputeUnlockTime *big.Int
}

// DatumView is the decoded 19-field lock datum.
type DatumView struct {
	Buyer AddressCredentials
	// BuyerReturnAddress is nil when the datum carries None.
	BuyerReturnAddress *AddressCredentials
	Seller             AddressCredentials
	// SellerReturnAddress is nil when the datum carries None.
	SellerReturnAddress       *AddressCredentials
	ReferenceKey              string
	ReferenceSignature        string
	SellerNonce               string
	BuyerNonce                string
	AgentIdentifier           string
	CollateralReturnLovelace  *big.Int
	InputHash                 string
	ResultHash                string
	PayByTime                 *big.Int
	SubmitResultTime          *big.Int
	UnlockTime                *big.Int
	ExternalDisputeUnlockTime *big.Int
	SellerCooldownTime        *big.Int
	BuyerCooldownTime         *big.Int
	State                     uint
}

// parseShelleyAddress decodes a bech32 Shelley address, rejecting trailing
// bytes and non-bech32 input.
func parseShelleyAddress(bech32 string) (common.Address, error) {
	if !cardano.IsAddress(bech32) {
		return common.Address{}, errors.New("not a bech32 Shelley address")
	}
	addr, err := cardano.ParseAddress(bech32)
	if err != nil {
		return common.Address{}, err
	}
	raw, err := addr.Bytes()
	if err != nil {
		return common.Address{}, err
	}
	want := 1
	if addr.Type() != common.AddressTypeNoneKey && addr.Type() != common.AddressTypeNoneScript {
		want += credentialHashBytes
	}
	switch addr.StakingPayload().(type) {
	case common.AddressPayloadKeyHash, common.AddressPayloadScriptHash:
		want += credentialHashBytes
	case common.AddressPayloadPointer:
		p := addr.StakingPayload().(common.AddressPayloadPointer)
		want += varUintLen(p.Slot) + varUintLen(p.TxIndex) + varUintLen(p.CertIndex)
	}
	if len(raw) != want {
		return common.Address{}, errors.New("address carries trailing bytes")
	}
	return addr, nil
}

func varUintLen(v uint64) int {
	n := 1
	for v >= 0x80 {
		v >>= 7
		n++
	}
	return n
}

func payloadCredential(p common.AddressPayload) Credential {
	switch c := p.(type) {
	case common.AddressPayloadKeyHash:
		return Credential{Hash: hex.EncodeToString(c.Hash.Bytes())}
	case common.AddressPayloadScriptHash:
		return Credential{IsScript: true, Hash: hex.EncodeToString(c.Hash.Bytes())}
	}
	return Credential{}
}

// ExtractAddressCredentials splits a base, enterprise or pointer address into
// its credentials.
func ExtractAddressCredentials(bech32 string) (AddressCredentials, error) {
	addr, err := parseShelleyAddress(bech32)
	if err != nil {
		return AddressCredentials{}, err
	}
	if addr.Type() > common.AddressTypeScriptNone {
		return AddressCredentials{}, errors.New("masumi datum address must have a payment credential")
	}
	payment := payloadCredential(addr.PayloadPayload())
	out := AddressCredentials{Payment: payment}
	switch s := addr.StakingPayload().(type) {
	case common.AddressPayloadKeyHash, common.AddressPayloadScriptHash:
		stake := payloadCredential(s)
		out.Stake = &stake
	case common.AddressPayloadPointer:
		out.Pointer = &Pointer{
			Slot:      new(big.Int).SetUint64(s.Slot),
			TxIndex:   new(big.Int).SetUint64(s.TxIndex),
			CertIndex: new(big.Int).SetUint64(s.CertIndex),
		}
	}
	return out, nil
}

func bytesData(hexValue string) (data.PlutusData, error) {
	b, err := hex.DecodeString(hexValue)
	if err != nil {
		return nil, fmt.Errorf("invalid hex %q: %w", hexValue, err)
	}
	return data.NewByteString(b), nil
}

func credentialData(c Credential) (data.PlutusData, error) {
	hash, err := bytesData(c.Hash)
	if err != nil {
		return nil, err
	}
	tag := uint(0)
	if c.IsScript {
		tag = 1
	}
	return data.NewConstr(tag, hash), nil
}

func addressData(bech32 string) (data.PlutusData, error) {
	creds, err := ExtractAddressCredentials(bech32)
	if err != nil {
		return nil, err
	}
	payment, err := credentialData(creds.Payment)
	if err != nil {
		return nil, err
	}
	var stake data.PlutusData
	switch {
	case creds.Stake != nil:
		cred, err := credentialData(*creds.Stake)
		if err != nil {
			return nil, err
		}
		stake = data.NewConstr(0, data.NewConstr(0, cred))
	case creds.Pointer != nil:
		stake = data.NewConstr(0, data.NewConstr(1,
			data.NewInteger(creds.Pointer.Slot),
			data.NewInteger(creds.Pointer.TxIndex),
			data.NewInteger(creds.Pointer.CertIndex)))
	default:
		stake = data.NewConstr(1)
	}
	return data.NewConstr(0, payment, stake), nil
}

func optionAddressData(bech32 string) (data.PlutusData, error) {
	if bech32 == "" {
		return data.NewConstr(1), nil
	}
	addr, err := addressData(bech32)
	if err != nil {
		return nil, err
	}
	return data.NewConstr(0, addr), nil
}

// BuildLockDatum builds the 19-field Constr 0 vested_pay datum of a fresh lock
// (state FundsLocked, empty result_hash, zero cooldowns).
func BuildLockDatum(input LockDatumInput) (data.PlutusData, error) {
	fields := make([]data.PlutusData, 0, 19)
	add := func(d data.PlutusData, err error) error {
		if err != nil {
			return err
		}
		fields = append(fields, d)
		return nil
	}
	intData := func(v *big.Int) (data.PlutusData, error) {
		if v == nil {
			return nil, errors.New("masumi datum integer is missing")
		}
		return data.NewInteger(v), nil
	}
	steps := []func() error{
		func() error { return add(addressData(input.BuyerAddress)) },
		func() error { return add(optionAddressData(input.BuyerReturnAddress)) },
		func() error { return add(addressData(input.SellerAddress)) },
		func() error { return add(optionAddressData(input.SellerReturnAddress)) },
		func() error { return add(bytesData(input.ReferenceKey)) },
		func() error { return add(bytesData(input.ReferenceSignature)) },
		func() error { return add(bytesData(input.SellerNonce)) },
		func() error { return add(bytesData(input.BuyerNonce)) },
		func() error { return add(bytesData(input.AgentIdentifier)) },
		func() error {
			return add(data.NewInteger(new(big.Int).SetUint64(input.CollateralReturnLovelace)), nil)
		},
		func() error { return add(bytesData(input.InputHash)) },
		func() error { return add(data.NewByteString([]byte{}), nil) },
		func() error { return add(intData(input.PayByTime)) },
		func() error { return add(intData(input.SubmitResultTime)) },
		func() error { return add(intData(input.UnlockTime)) },
		func() error { return add(intData(input.ExternalDisputeUnlockTime)) },
		func() error { return add(data.NewInteger(big.NewInt(0)), nil) },
		func() error { return add(data.NewInteger(big.NewInt(0)), nil) },
		func() error { return add(data.NewConstr(StateFundsLocked), nil) },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return nil, err
		}
	}
	return data.NewConstr(0, fields...), nil
}

// BuildLockDatumCBOR is BuildLockDatum encoded as ledger Plutus Data CBOR.
func BuildLockDatumCBOR(input LockDatumInput) ([]byte, error) {
	d, err := BuildLockDatum(input)
	if err != nil {
		return nil, err
	}
	return data.Encode(d)
}

func asConstr(d data.PlutusData) (*data.Constr, bool) {
	c, ok := d.(*data.Constr)
	return c, ok
}

func asInt(d data.PlutusData) (*big.Int, bool) {
	i, ok := d.(*data.Integer)
	if !ok || i.Inner == nil {
		return nil, false
	}
	return i.Inner, true
}

func asHex(d data.PlutusData) (string, bool) {
	b, ok := d.(*data.ByteString)
	if !ok {
		return "", false
	}
	return hex.EncodeToString(b.Inner), true
}

func dataToCredential(d data.PlutusData) (Credential, bool) {
	c, ok := asConstr(d)
	if !ok || c.Tag > 1 || len(c.Fields) != 1 {
		return Credential{}, false
	}
	hash, ok := asHex(c.Fields[0])
	if !ok || len(hash) != 2*credentialHashBytes {
		return Credential{}, false
	}
	return Credential{IsScript: c.Tag == 1, Hash: hash}, true
}

func dataToAddress(d data.PlutusData) (AddressCredentials, bool) {
	c, ok := asConstr(d)
	if !ok || c.Tag != 0 || len(c.Fields) != 2 {
		return AddressCredentials{}, false
	}
	payment, ok := dataToCredential(c.Fields[0])
	if !ok {
		return AddressCredentials{}, false
	}
	opt, ok := asConstr(c.Fields[1])
	if !ok {
		return AddressCredentials{}, false
	}
	if opt.Tag == 1 {
		return AddressCredentials{Payment: payment}, len(opt.Fields) == 0
	}
	if opt.Tag != 0 || len(opt.Fields) != 1 {
		return AddressCredentials{}, false
	}
	ref, ok := asConstr(opt.Fields[0])
	if !ok {
		return AddressCredentials{}, false
	}
	if ref.Tag == 0 && len(ref.Fields) == 1 {
		stake, ok := dataToCredential(ref.Fields[0])
		if !ok {
			return AddressCredentials{}, false
		}
		return AddressCredentials{Payment: payment, Stake: &stake}, true
	}
	if ref.Tag == 1 && len(ref.Fields) == 3 {
		var values [3]*big.Int
		for i := range values {
			v, ok := asInt(ref.Fields[i])
			if !ok || v.Sign() < 0 {
				return AddressCredentials{}, false
			}
			values[i] = v
		}
		return AddressCredentials{Payment: payment, Pointer: &Pointer{Slot: values[0], TxIndex: values[1], CertIndex: values[2]}}, true
	}
	return AddressCredentials{}, false
}

// dataToOptionAddress decodes Some(address) / None; present is false for None.
func dataToOptionAddress(d data.PlutusData) (addr *AddressCredentials, ok bool) {
	c, isConstr := asConstr(d)
	if !isConstr {
		return nil, false
	}
	if c.Tag == 1 && len(c.Fields) == 0 {
		return nil, true
	}
	if c.Tag != 0 || len(c.Fields) != 1 {
		return nil, false
	}
	a, ok := dataToAddress(c.Fields[0])
	if !ok {
		return nil, false
	}
	return &a, true
}

var errDatumShape = errors.New("datum does not match masumi.vested_pay.v2")

// ParseLockDatum decodes an inline datum (CBOR hex) into a typed view. It
// fails when the structure is not the strict 19-field vested_pay datum.
func ParseLockDatum(cborHex string) (*DatumView, error) {
	raw, err := hex.DecodeString(cborHex)
	if err != nil || len(raw) == 0 {
		return nil, errDatumShape
	}
	d, err := data.Decode(raw)
	if err != nil {
		return nil, errDatumShape
	}
	return parseLockDatumData(d)
}

func parseLockDatumData(d data.PlutusData) (*DatumView, error) {
	root, ok := asConstr(d)
	if !ok || root.Tag != 0 || len(root.Fields) != 19 {
		return nil, errDatumShape
	}
	f := root.Fields
	view := &DatumView{}
	var okAll = true
	check := func(ok bool) { okAll = okAll && ok }

	var ok0 bool
	view.Buyer, ok0 = dataToAddress(f[0])
	check(ok0)
	view.BuyerReturnAddress, ok0 = dataToOptionAddress(f[1])
	check(ok0)
	view.Seller, ok0 = dataToAddress(f[2])
	check(ok0)
	view.SellerReturnAddress, ok0 = dataToOptionAddress(f[3])
	check(ok0)
	hexFields := []*string{&view.ReferenceKey, &view.ReferenceSignature, &view.SellerNonce, &view.BuyerNonce, &view.AgentIdentifier}
	for i, target := range hexFields {
		*target, ok0 = asHex(f[4+i])
		check(ok0)
	}
	view.CollateralReturnLovelace, ok0 = asInt(f[9])
	check(ok0)
	view.InputHash, ok0 = asHex(f[10])
	check(ok0)
	view.ResultHash, ok0 = asHex(f[11])
	check(ok0)
	intFields := []**big.Int{&view.PayByTime, &view.SubmitResultTime, &view.UnlockTime,
		&view.ExternalDisputeUnlockTime, &view.SellerCooldownTime, &view.BuyerCooldownTime}
	for i, target := range intFields {
		*target, ok0 = asInt(f[12+i])
		check(ok0)
	}
	state, ok0 := asConstr(f[18])
	check(ok0 && len(state.Fields) == 0)
	if !okAll {
		return nil, errDatumShape
	}
	view.State = state.Tag
	return view, nil
}
