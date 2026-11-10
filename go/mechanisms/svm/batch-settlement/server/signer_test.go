package server_test

import (
	"context"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"
)

type testSigner struct{ key solana.PrivateKey }

func newTestSigner(t *testing.T) testSigner {
	t.Helper()
	key, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	return testSigner{key: key}
}

func (s testSigner) Address() solana.PublicKey { return s.key.PublicKey() }

func (s testSigner) SignMessage(_ context.Context, message []byte) ([]byte, error) {
	signature, err := s.key.Sign(message)
	if err != nil {
		return nil, err
	}
	return signature[:], nil
}
