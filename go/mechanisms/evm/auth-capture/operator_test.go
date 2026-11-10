package authcapture

import (
	"bytes"
	"context"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

const (
	testCaptureAuthorizer = "0x1111111111111111111111111111111111111111"
	testPaymentInfoHash   = "0x00000000000000000000000000000000000000000000000000000000000000aa"
)

func testSigner(t *testing.T) evm.ClientEvmSigner {
	t.Helper()
	key, err := crypto.GenerateKey()
	require.NoError(t, err)
	signer, err := evmsigners.NewClientSignerFromPrivateKey(hexutil.Encode(crypto.FromECDSA(key)))
	require.NoError(t, err)
	return signer
}

func TestOperatorDomain(t *testing.T) {
	domain := OperatorDomain(testCaptureAuthorizer, big.NewInt(84532))

	assert.Equal(t, "x402 Auth Capture Operator", domain.Name)
	assert.Equal(t, "1", domain.Version)
	assert.Equal(t, big.NewInt(84532), domain.ChainID)
	assert.Equal(t, evm.NormalizeAddress(testCaptureAuthorizer), domain.VerifyingContract)
}

func TestOperatorTypesIncludeEIP712Domain(t *testing.T) {
	for name, types := range map[string]map[string][]evm.TypedDataField{
		"capture v1.0": CaptureTypesV1_0,
		"capture v1.1": CaptureTypesV1_1,
		"charge v1.0":  ChargeTypesV1_0,
		"charge v1.1":  ChargeTypesV1_1,
		"void":         VoidTypes,
		"refund":       RefundTypes,
	} {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, evm.EIP712DomainTypesWithVersion, types["EIP712Domain"])
		})
	}
}

func TestDefaultCaptureFee(t *testing.T) {
	amount := big.NewInt(1_000_000)

	v10 := DefaultCaptureFee(ResolveAuthCaptureDeployment(AuthCaptureEscrowV1_0Address), amount, 25)
	require.NotNil(t, v10.Bps)
	assert.Equal(t, uint16(25), v10.Arg())
	wire := map[string]interface{}{}
	v10.AddToWire(wire)
	assert.Equal(t, map[string]interface{}{"feeBps": uint16(25)}, wire)

	v11 := DefaultCaptureFee(ResolveAuthCaptureDeployment(AuthCaptureEscrowV1_1Address), amount, 25)
	assert.Equal(t, big.NewInt(2500), v11.Arg())
	wire = map[string]interface{}{}
	v11.AddToWire(wire)
	assert.Equal(t, map[string]interface{}{"feeAmount": "2500"}, wire)
}

func TestCaptureSignatureRoundTrip(t *testing.T) {
	ctx := context.Background()
	chainID := big.NewInt(84532)

	for _, escrow := range []string{AuthCaptureEscrowV1_0Address, AuthCaptureEscrowV1_1Address} {
		t.Run(escrow, func(t *testing.T) {
			deployment := ResolveAuthCaptureDeployment(escrow)
			signer := testSigner(t)
			params := CaptureParams{
				PaymentInfoHash:    testPaymentInfoHash,
				Amount:             big.NewInt(600000),
				Fee:                DefaultCaptureFee(deployment, big.NewInt(600000), 50),
				FeeReceiver:        "0x4444444444444444444444444444444444444444",
				ExpectedCapturable: big.NewInt(400000),
				ExpectedRefundable: big.NewInt(0),
			}

			signature, err := SignCapture(ctx, signer, deployment, testCaptureAuthorizer, chainID, params)
			require.NoError(t, err)

			verify := func(chain *big.Int, p CaptureParams) bool {
				ok, err := evm.VerifyEOATypedData(signer.Address(), OperatorDomain(testCaptureAuthorizer, chain), CaptureTypesForDeployment(deployment), "Capture", p.message(), signature)
				require.NoError(t, err)
				return ok
			}
			assert.True(t, verify(chainID, params))
			assert.False(t, verify(big.NewInt(8453), params), "the signature is bound to the chain")

			tampered := params
			tampered.Amount = big.NewInt(600001)
			assert.False(t, verify(chainID, tampered), "the signature is bound to the amount")
		})
	}
}

func TestVoidSignatureRoundTrip(t *testing.T) {
	signer := testSigner(t)
	chainID := big.NewInt(84532)

	signature, err := SignVoid(context.Background(), signer, testCaptureAuthorizer, chainID, testPaymentInfoHash)
	require.NoError(t, err)

	message := map[string]interface{}{"paymentInfoHash": testPaymentInfoHash}
	ok, err := evm.VerifyEOATypedData(signer.Address(), OperatorDomain(testCaptureAuthorizer, chainID), VoidTypes, "Void", message, signature)
	require.NoError(t, err)
	assert.True(t, ok)

	other := map[string]interface{}{"paymentInfoHash": "0x00000000000000000000000000000000000000000000000000000000000000bb"}
	ok, err = evm.VerifyEOATypedData(signer.Address(), OperatorDomain(testCaptureAuthorizer, chainID), VoidTypes, "Void", other, signature)
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestChargeSignatureRoundTrip(t *testing.T) {
	ctx := context.Background()
	chainID := big.NewInt(84532)

	for _, escrow := range []string{AuthCaptureEscrowV1_0Address, AuthCaptureEscrowV1_1Address} {
		t.Run(escrow, func(t *testing.T) {
			deployment := ResolveAuthCaptureDeployment(escrow)
			signer := testSigner(t)
			params := ChargeParams{
				PaymentInfoHash: testPaymentInfoHash,
				Amount:          big.NewInt(750000),
				TokenCollector:  deployment.EIP3009Collector,
				CollectorData:   []byte{0x01, 0x02, 0x03},
				Fee:             DefaultCaptureFee(deployment, big.NewInt(750000), 100),
				FeeReceiver:     "0x4444444444444444444444444444444444444444",
			}

			signature, err := SignCharge(ctx, signer, deployment, testCaptureAuthorizer, chainID, params)
			require.NoError(t, err)

			verify := func(p ChargeParams) bool {
				ok, err := evm.VerifyEOATypedData(signer.Address(), OperatorDomain(testCaptureAuthorizer, chainID), ChargeTypesForDeployment(deployment), "Charge", p.message(), signature)
				require.NoError(t, err)
				return ok
			}
			assert.True(t, verify(params))

			tampered := params
			tampered.CollectorData = []byte{0x01, 0x02, 0x04}
			assert.False(t, verify(tampered), "the signature is bound to the collector data")
			tampered = params
			tampered.Amount = big.NewInt(750001)
			assert.False(t, verify(tampered), "the signature is bound to the amount")
		})
	}
}

func TestRefundSignatureRoundTrip(t *testing.T) {
	signer := testSigner(t)
	chainID := big.NewInt(84532)
	params := RefundParams{
		PaymentInfoHash:    testPaymentInfoHash,
		Amount:             big.NewInt(250000),
		TokenCollector:     OperatorRefundCollectorAddress,
		ExpectedCapturable: big.NewInt(0),
		ExpectedRefundable: big.NewInt(750000),
	}

	signature, err := SignRefund(context.Background(), signer, testCaptureAuthorizer, chainID, params)
	require.NoError(t, err)

	verify := func(p RefundParams) bool {
		ok, err := evm.VerifyEOATypedData(signer.Address(), OperatorDomain(testCaptureAuthorizer, chainID), RefundTypes, "Refund", p.message(), signature)
		require.NoError(t, err)
		return ok
	}
	assert.True(t, verify(params))

	tampered := params
	tampered.ExpectedRefundable = big.NewInt(500000)
	assert.False(t, verify(tampered), "the signature is bound to the refundable balance")
}

func TestEscrowABIsDeclareChargeRefundAndEvents(t *testing.T) {
	for _, escrow := range []string{AuthCaptureEscrowV1_0Address, AuthCaptureEscrowV1_1Address} {
		parsed, err := abi.JSON(bytes.NewReader(EscrowABIForDeployment(ResolveAuthCaptureDeployment(escrow))))
		require.NoError(t, err)
		for _, method := range []string{"authorize", "charge", "capture", "void", "refund", "paymentState", "getTokenStore"} {
			assert.Contains(t, parsed.Methods, method, escrow)
		}
		assert.Contains(t, parsed.Events, "PaymentAuthorized")
		assert.Contains(t, parsed.Events, "PaymentCharged")
	}
}
