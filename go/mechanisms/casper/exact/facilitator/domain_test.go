package facilitator_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/casper"
	casperClient "github.com/x402-foundation/x402/go/v2/mechanisms/casper/exact/client"
	casperFacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/casper/exact/facilitator"
	casperSigners "github.com/x402-foundation/x402/go/v2/signers/casper"
)

type domainFacilitatorSigner struct {
	*mockFacilitatorSigner
	config casper.NetworkConfig
}

func (s *domainFacilitatorSigner) GetNetworkConfig(context.Context, string) (casper.NetworkConfig, error) {
	return s.config, nil
}

func (s *domainFacilitatorSigner) VerifyEIP712Signature(digest [32]byte, signature [65]byte, publicKey string) (bool, error) {
	var verifier casperSigners.FacilitatorSigner
	return verifier.VerifyEIP712Signature(digest, signature, publicKey)
}

func TestVerify_CAIP2SigningDomain(t *testing.T) {
	for _, network := range []string{casper.CasperMainnetCAIP2, casper.CasperTestnetCAIP2} {
		for _, algorithm := range []string{"ed25519", "secp256k1"} {
			for _, configSource := range []string{"exported helper", "concrete signer"} {
				t.Run(network+"/"+algorithm+"/"+configSource, func(t *testing.T) {
					signer := &domainFacilitatorSigner{mockFacilitatorSigner: defaultSigner(t)}
					if configSource == "exported helper" {
						config, err := casper.GetNetworkConfig(network)
						require.NoError(t, err)
						signer.config = *config
						signer.config.RPCURL = signer.rpcURL
					} else {
						concrete := casperSigners.NewFacilitatorSigner(casperSigners.FacilitatorSignerConfig{
							RpcURLs: map[string]string{network: signer.rpcURL},
						})
						var err error
						signer.config, err = concrete.GetNetworkConfig(context.Background(), network)
						require.NoError(t, err)
					}
					client, err := casperSigners.NewClientSignerFromSecret(strings.Repeat("11", 32), algorithm)
					require.NoError(t, err)
					_, requirements := buildValidPayload(t)
					requirements.Network = network
					requirements.MaxTimeoutSeconds = 300
					payload, err := casperClient.NewExactCasperScheme(client).CreatePaymentPayload(context.Background(), requirements, x402.PaymentPayloadContext{})
					require.NoError(t, err)
					payload.Accepted = requirements
					scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
					response, err := scheme.Verify(context.Background(), payload, requirements, nil)
					require.NoError(t, err)
					require.True(t, response.IsValid)
					assert.Equal(t, client.AccountAddress(), response.Payer)

					_, err = scheme.Settle(context.Background(), payload, requirements, nil)
					require.NoError(t, err)
					require.NotNil(t, signer.capturedTransaction)
					assert.Equal(t, casper.ChainNameFromNetwork(network), signer.capturedTransaction.Payload.ChainName)

					// Rewriting both network fields must not let a signature cross domains.
					otherNetwork := casper.CasperMainnetCAIP2
					if network == otherNetwork {
						otherNetwork = casper.CasperTestnetCAIP2
					}
					payload.Accepted.Network = otherNetwork
					requirements.Network = otherNetwork
					response, err = scheme.Verify(context.Background(), payload, requirements, nil)
					require.ErrorContains(t, err, casperFacilitator.ErrInvalidSignature)
					assert.Nil(t, response)
				})
			}
		}
	}
}

func TestVerify_ClientClockAheadOfChain(t *testing.T) {
	fixture := newPreflightFixture(t)
	fixture.block = preflightBlock(time.Now().Add(-15 * time.Minute))
	config, err := casper.GetNetworkConfig(testNetwork)
	require.NoError(t, err)
	signer := &domainFacilitatorSigner{mockFacilitatorSigner: defaultSigner(t), config: *config}
	signer.config.RPCURL = fixture.url
	client, err := casperSigners.NewClientSignerFromSecret(strings.Repeat("11", 32), "ed25519")
	require.NoError(t, err)
	_, requirements := buildValidPayload(t)
	requirements.MaxTimeoutSeconds = 300
	payload, err := casperClient.NewExactCasperScheme(client).CreatePaymentPayload(context.Background(), requirements, x402.PaymentPayloadContext{})
	require.NoError(t, err)
	payload.Accepted = requirements

	response, err := casperFacilitator.NewExactCasperScheme(signer, nil).Verify(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, response.IsValid)
	assert.Equal(t, client.AccountAddress(), response.Payer)
}

func TestVerify_Secp256k1SignatureReasons(t *testing.T) {
	const (
		zero             = "0000000000000000000000000000000000000000000000000000000000000000"
		one              = "0000000000000000000000000000000000000000000000000000000000000001"
		halfOrder        = "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0"
		halfOrderPlusOne = "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1"
		orderMinusOne    = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140"
		order            = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
		nonCanonical     = "invalid_exact_casper_facilitator_non_canonical_signature"
	)
	client, err := casperSigners.NewClientSignerFromSecret(strings.Repeat("11", 32), "secp256k1")
	require.NoError(t, err)
	for _, test := range []struct{ name, r, s, reason string }{
		{"low-s boundary", one, halfOrder, ""},
		{"high-s boundary", one, halfOrderPlusOne, nonCanonical},
		{"highest valid s scalar", one, orderMinusOne, nonCanonical},
		{"zero r with high-s", zero, halfOrderPlusOne, casperFacilitator.ErrInvalidSignature},
		{"out-of-range r", order, one, casperFacilitator.ErrInvalidSignature},
		{"zero s", one, zero, casperFacilitator.ErrInvalidSignature},
		{"out-of-range s", one, order, casperFacilitator.ErrInvalidSignature},
	} {
		t.Run(test.name, func(t *testing.T) {
			signer := defaultSigner(t)
			scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
			_, requirements := buildValidPayload(t)
			requirements.MaxTimeoutSeconds = 300
			payload, err := casperClient.NewExactCasperScheme(client).CreatePaymentPayload(context.Background(), requirements, x402.PaymentPayloadContext{})
			require.NoError(t, err)
			payload.Accepted = requirements
			payload.Payload["signature"] = "02" + test.r + test.s

			response, err := scheme.Verify(context.Background(), payload, requirements, nil)
			if test.reason == "" {
				require.NoError(t, err)
				assert.True(t, response.IsValid)
				return
			}
			assert.Nil(t, response)
			var verifyErr *x402.VerifyError
			require.ErrorAs(t, err, &verifyErr)
			assert.Equal(t, test.reason, verifyErr.InvalidReason)
			if test.reason == nonCanonical {
				assert.Equal(t, client.AccountAddress(), verifyErr.Payer)
			}

			_, err = scheme.Settle(context.Background(), payload, requirements, nil)
			settleErr := requireSettleError(t, err)
			assert.Equal(t, test.reason, settleErr.ErrorReason)
			assert.Empty(t, settleErr.Transaction)
			assert.Zero(t, signer.putCalls.Load())
		})
	}
}
