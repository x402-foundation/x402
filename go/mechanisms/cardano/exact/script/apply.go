package script

import (
	"errors"
	"fmt"

	"github.com/blinklabs-io/gouroboros/cbor"
	"github.com/blinklabs-io/plutigo/data"
	"github.com/blinklabs-io/plutigo/syn"
)

// ApplyParams applies Plutus data parameters to a flat program given with
// zero, one or two CBOR byte-string wrappers and returns the single-wrapped
// applied script, as Aiken's apply_params and the TypeScript SDK do.
func ApplyParams(code []byte, params []data.PlutusData) ([]byte, error) {
	flat := code
	for i := 0; i < 2; i++ {
		if len(flat) == 0 || flat[0]>>5 != 2 {
			break
		}
		var inner []byte
		if _, err := cbor.Decode(flat, &inner); err != nil {
			break
		}
		flat = inner
	}
	program, err := syn.DecodeDeBruijn(flat)
	if err != nil {
		return nil, fmt.Errorf("malformed flat UPLC program: %w", err)
	}
	for _, p := range params {
		if p == nil {
			return nil, errors.New("script parameter is nil")
		}
		program.Term = &syn.Apply[syn.DeBruijn]{
			Function: program.Term,
			Argument: &syn.Constant{Con: &syn.Data{Inner: p}},
		}
	}
	applied, err := syn.Encode(program)
	if err != nil {
		return nil, err
	}
	return cbor.Encode(applied)
}
