package evm

import (
	"bytes"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// fakeBuilderCodeExtension implements BuilderCodeFacilitatorExtension, returning
// a fixed suffix so ResolveDataSuffix wiring can be tested without real CBOR.
type fakeBuilderCodeExtension struct {
	suffix []byte
}

func (f *fakeBuilderCodeExtension) Key() string { return BuilderCodeKey }

func (f *fakeBuilderCodeExtension) BuildDataSuffix(DataSuffixContext) ([]byte, error) {
	return f.suffix, nil
}

func TestAppendDataSuffix(t *testing.T) {
	calldata := []byte{0x01, 0x02}

	if got := AppendDataSuffix(calldata, nil); !bytes.Equal(got, calldata) {
		t.Fatalf("empty suffix should return calldata unchanged, got %x", got)
	}

	got := AppendDataSuffix(calldata, []byte{0xaa, 0xbb})
	if !bytes.Equal(got, []byte{0x01, 0x02, 0xaa, 0xbb}) {
		t.Fatalf("suffix should be appended, got %x", got)
	}
}

func TestResolveDataSuffix(t *testing.T) {
	ctx := DataSuffixContext{}

	t.Run("nil fctx returns nil", func(t *testing.T) {
		suffix, err := ResolveDataSuffix(nil, ctx)
		if err != nil || suffix != nil {
			t.Fatalf("expected nil, got %x err=%v", suffix, err)
		}
	})

	t.Run("no matching extension returns nil", func(t *testing.T) {
		fctx := x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{
			"other": x402.NewFacilitatorExtension("other"),
		})
		suffix, err := ResolveDataSuffix(fctx, ctx)
		if err != nil || suffix != nil {
			t.Fatalf("expected nil, got %x err=%v", suffix, err)
		}
	})

	t.Run("empty suffix returns nil", func(t *testing.T) {
		fctx := x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{
			BuilderCodeKey: &fakeBuilderCodeExtension{suffix: nil},
		})
		suffix, err := ResolveDataSuffix(fctx, ctx)
		if err != nil || suffix != nil {
			t.Fatalf("expected nil, got %x err=%v", suffix, err)
		}
	})

	t.Run("returns extension suffix", func(t *testing.T) {
		want := []byte{0xde, 0xad}
		fctx := x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{
			BuilderCodeKey: &fakeBuilderCodeExtension{suffix: want},
		})
		suffix, err := ResolveDataSuffix(fctx, ctx)
		if err != nil || !bytes.Equal(suffix, want) {
			t.Fatalf("expected %x, got %x err=%v", want, suffix, err)
		}
	})
}
