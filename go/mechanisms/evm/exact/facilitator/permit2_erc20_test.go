package facilitator

import (
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

// buildSignedApproveTransaction creates a signed approve(Permit2, MaxUint256) transaction
// for use in tests. Uses a well-known test private key.
func buildSignedApproveTransaction(t *testing.T, privateKeyHex string, tokenAddress string, chainID *big.Int) (string, string) {
	t.Helper()

	privateKeyHex = strings.TrimPrefix(privateKeyHex, "0x")
	privateKey, err := crypto.HexToECDSA(privateKeyHex)
	if err != nil {
		t.Fatalf("failed to parse private key: %v", err)
	}
	from := crypto.PubkeyToAddress(privateKey.PublicKey)

	// Encode approve(Permit2, MaxUint256) calldata
	// selector: 0x095ea7b3
	// param 1 (spender): left-padded Permit2 address
	// param 2 (amount): MaxUint256
	spenderAddr := common.HexToAddress(evm.PERMIT2Address)
	maxUint256 := evm.MaxUint256()

	calldata := make([]byte, 4+32+32)
	copy(calldata[0:4], []byte{0x09, 0x5e, 0xa7, 0xb3})
	spenderBytes := spenderAddr.Bytes()
	copy(calldata[4+12:4+32], spenderBytes) // right-align address in 32 bytes
	maxBytes := maxUint256.Bytes()
	copy(calldata[4+32+(32-len(maxBytes)):], maxBytes) // right-align in 32 bytes

	toAddr := common.HexToAddress(tokenAddress)
	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   chainID,
		Nonce:     0,
		GasTipCap: big.NewInt(1000000000), // 1 gwei
		GasFeeCap: big.NewInt(2000000000), // 2 gwei
		Gas:       evm.ERC20ApproveGasLimit,
		To:        &toAddr,
		Value:     big.NewInt(0),
		Data:      calldata,
	})

	signer := types.LatestSignerForChainID(chainID)
	signedTx, err := types.SignTx(tx, signer, privateKey)
	if err != nil {
		t.Fatalf("failed to sign tx: %v", err)
	}

	rlpBytes, err := signedTx.MarshalBinary()
	if err != nil {
		t.Fatalf("failed to marshal tx: %v", err)
	}

	return "0x" + hex.EncodeToString(rlpBytes), from.Hex()
}

func TestValidateErc20ApprovalForPayment(t *testing.T) {
	// Use a deterministic test private key (DO NOT use in production)
	testPrivKey := "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
	tokenAddress := "0xeED520980fC7C7B4eB379B96d61CEdea2423005a"
	chainID := big.NewInt(84532) // Base Sepolia

	signedTx, payer := buildSignedApproveTransaction(t, testPrivKey, tokenAddress, chainID)

	t.Run("valid approval", func(t *testing.T) {
		info := &erc20approvalgassponsor.Info{
			From:              payer,
			Asset:             tokenAddress,
			Spender:           evm.PERMIT2Address,
			Amount:            evm.MaxUint256().String(),
			SignedTransaction: signedTx,
			Version:           "1",
		}
		reason, msg := ValidateErc20ApprovalForPayment(info, payer, tokenAddress)
		if reason != "" {
			t.Errorf("expected valid, got error: %s (%s)", reason, msg)
		}
	})

	t.Run("invalid format - bad from address", func(t *testing.T) {
		info := &erc20approvalgassponsor.Info{
			From:              "not-an-address",
			Asset:             tokenAddress,
			Spender:           evm.PERMIT2Address,
			Amount:            "12345",
			SignedTransaction: signedTx,
			Version:           "1",
		}
		reason, _ := ValidateErc20ApprovalForPayment(info, payer, tokenAddress)
		if reason != ErrErc20ApprovalInvalidFormat {
			t.Errorf("expected %s, got: %s", ErrErc20ApprovalInvalidFormat, reason)
		}
	})

	t.Run("from mismatch", func(t *testing.T) {
		otherAddr := "0x0000000000000000000000000000000000000001"
		info := &erc20approvalgassponsor.Info{
			From:              otherAddr,
			Asset:             tokenAddress,
			Spender:           evm.PERMIT2Address,
			Amount:            evm.MaxUint256().String(),
			SignedTransaction: signedTx,
			Version:           "1",
		}
		reason, _ := ValidateErc20ApprovalForPayment(info, payer, tokenAddress)
		if reason != ErrErc20ApprovalFromMismatch {
			t.Errorf("expected %s, got: %s", ErrErc20ApprovalFromMismatch, reason)
		}
	})

	t.Run("asset mismatch", func(t *testing.T) {
		info := &erc20approvalgassponsor.Info{
			From:              payer,
			Asset:             "0x0000000000000000000000000000000000000001",
			Spender:           evm.PERMIT2Address,
			Amount:            evm.MaxUint256().String(),
			SignedTransaction: signedTx,
			Version:           "1",
		}
		reason, _ := ValidateErc20ApprovalForPayment(info, payer, tokenAddress)
		if reason != ErrErc20ApprovalAssetMismatch {
			t.Errorf("expected %s, got: %s", ErrErc20ApprovalAssetMismatch, reason)
		}
	})

	t.Run("wrong spender in info (not Permit2)", func(t *testing.T) {
		info := &erc20approvalgassponsor.Info{
			From:              payer,
			Asset:             tokenAddress,
			Spender:           "0x0000000000000000000000000000000000000001",
			Amount:            evm.MaxUint256().String(),
			SignedTransaction: signedTx,
			Version:           "1",
		}
		reason, _ := ValidateErc20ApprovalForPayment(info, payer, tokenAddress)
		if reason != ErrErc20ApprovalWrongSpender {
			t.Errorf("expected %s, got: %s", ErrErc20ApprovalWrongSpender, reason)
		}
	})

	t.Run("tx parse failed - not valid RLP", func(t *testing.T) {
		info := &erc20approvalgassponsor.Info{
			From:              payer,
			Asset:             tokenAddress,
			Spender:           evm.PERMIT2Address,
			Amount:            evm.MaxUint256().String(),
			SignedTransaction: "0xdeadbeef1234",
			Version:           "1",
		}
		reason, _ := ValidateErc20ApprovalForPayment(info, payer, tokenAddress)
		if reason != ErrErc20ApprovalTxParseFailed {
			t.Errorf("expected %s, got: %s", ErrErc20ApprovalTxParseFailed, reason)
		}
	})

	t.Run("tx target mismatch", func(t *testing.T) {
		// Build tx targeting a different token
		wrongToken := "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
		wrongSignedTx, _ := buildSignedApproveTransaction(t, testPrivKey, wrongToken, chainID)
		info := &erc20approvalgassponsor.Info{
			From:              payer,
			Asset:             tokenAddress,
			Spender:           evm.PERMIT2Address,
			Amount:            evm.MaxUint256().String(),
			SignedTransaction: wrongSignedTx,
			Version:           "1",
		}
		reason, _ := ValidateErc20ApprovalForPayment(info, payer, tokenAddress)
		if reason != ErrErc20ApprovalWrongTarget {
			t.Errorf("expected %s, got: %s", ErrErc20ApprovalWrongTarget, reason)
		}
	})

	t.Run("wrong calldata selector", func(t *testing.T) {
		privateKey, _ := crypto.HexToECDSA(strings.TrimPrefix(testPrivKey, "0x"))
		toAddr := common.HexToAddress(tokenAddress)

		// Use wrong selector (transfer instead of approve)
		wrongCalldata := []byte{0xa9, 0x05, 0x9c, 0xbb} // transfer(address,uint256) selector
		wrongCalldata = append(wrongCalldata, make([]byte, 64)...)

		tx := types.NewTx(&types.DynamicFeeTx{
			ChainID:   chainID,
			Nonce:     1,
			GasTipCap: big.NewInt(1000000000),
			GasFeeCap: big.NewInt(2000000000),
			Gas:       evm.ERC20ApproveGasLimit,
			To:        &toAddr,
			Value:     big.NewInt(0),
			Data:      wrongCalldata,
		})
		signer := types.LatestSignerForChainID(chainID)
		signedTxObj, _ := types.SignTx(tx, signer, privateKey)
		rlpBytes, _ := signedTxObj.MarshalBinary()
		wrongSignedTxHex := "0x" + hex.EncodeToString(rlpBytes)

		info := &erc20approvalgassponsor.Info{
			From:              payer,
			Asset:             tokenAddress,
			Spender:           evm.PERMIT2Address,
			Amount:            evm.MaxUint256().String(),
			SignedTransaction: wrongSignedTxHex,
			Version:           "1",
		}
		reason, _ := ValidateErc20ApprovalForPayment(info, payer, tokenAddress)
		if reason != ErrErc20ApprovalWrongSelector {
			t.Errorf("expected %s, got: %s", ErrErc20ApprovalWrongSelector, reason)
		}
	})

	t.Run("wrong calldata spender", func(t *testing.T) {
		privateKey, _ := crypto.HexToECDSA(strings.TrimPrefix(testPrivKey, "0x"))
		toAddr := common.HexToAddress(tokenAddress)

		// Approve a wrong spender (not Permit2)
		wrongSpender := common.HexToAddress("0x0000000000000000000000000000000000000001")
		calldata := make([]byte, 4+32+32)
		copy(calldata[0:4], []byte{0x09, 0x5e, 0xa7, 0xb3})
		copy(calldata[4+12:4+32], wrongSpender.Bytes())
		maxUint256 := evm.MaxUint256()
		maxBytes := maxUint256.Bytes()
		copy(calldata[4+32+(32-len(maxBytes)):], maxBytes)

		tx := types.NewTx(&types.DynamicFeeTx{
			ChainID:   chainID,
			Nonce:     1,
			GasTipCap: big.NewInt(1000000000),
			GasFeeCap: big.NewInt(2000000000),
			Gas:       evm.ERC20ApproveGasLimit,
			To:        &toAddr,
			Value:     big.NewInt(0),
			Data:      calldata,
		})
		signer := types.LatestSignerForChainID(chainID)
		signedTxObj, _ := types.SignTx(tx, signer, privateKey)
		rlpBytes, _ := signedTxObj.MarshalBinary()
		wrongSignedTxHex := "0x" + hex.EncodeToString(rlpBytes)

		info := &erc20approvalgassponsor.Info{
			From:              payer,
			Asset:             tokenAddress,
			Spender:           evm.PERMIT2Address,
			Amount:            evm.MaxUint256().String(),
			SignedTransaction: wrongSignedTxHex,
			Version:           "1",
		}
		reason, _ := ValidateErc20ApprovalForPayment(info, payer, tokenAddress)
		if reason != ErrErc20ApprovalWrongCalldata {
			t.Errorf("expected %s, got: %s", ErrErc20ApprovalWrongCalldata, reason)
		}
	})

	t.Run("signer mismatch - signed by different key", func(t *testing.T) {
		// Sign with a different private key
		differentPrivKey := "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
		differentSignedTx, _ := buildSignedApproveTransaction(t, differentPrivKey, tokenAddress, chainID)

		info := &erc20approvalgassponsor.Info{
			From:              payer, // claims to be payer, but tx is signed by different key
			Asset:             tokenAddress,
			Spender:           evm.PERMIT2Address,
			Amount:            evm.MaxUint256().String(),
			SignedTransaction: differentSignedTx,
			Version:           "1",
		}
		reason, _ := ValidateErc20ApprovalForPayment(info, payer, tokenAddress)
		if reason != ErrErc20ApprovalSignerMismatch {
			t.Errorf("expected %s, got: %s", ErrErc20ApprovalSignerMismatch, reason)
		}
	})
}
