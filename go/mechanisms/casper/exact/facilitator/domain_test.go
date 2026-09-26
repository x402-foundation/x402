package facilitator_test

import (
	"context"
	"strings"
	"testing"

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
