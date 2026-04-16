package facilitator

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

// VerifyDeposit verifies a batched deposit payload.
// Validates ERC-3009 authorization, voucher signature, payer balance, and maxClaimableAmount.
func VerifyDeposit(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batched.BatchedDepositPayload,
	requirements types.PaymentRequirements,
) (*x402.VerifyResponse, error) {
	config := payload.Deposit.ChannelConfig
	channelId := payload.Voucher.ChannelId

	// Validate channel config
	if err := ValidateChannelConfig(config, channelId, requirements); err != nil {
		return nil, err
	}

	// Validate deposit amount
	depositAmount, ok := new(big.Int).SetString(payload.Deposit.Amount, 10)
	if !ok || depositAmount.Sign() <= 0 {
		return nil, x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer,
			fmt.Sprintf("invalid deposit amount: %s", payload.Deposit.Amount))
	}

	// Get chain ID
	chainId, err := signer.GetChainID(ctx)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelStateReadFailed, config.Payer,
			fmt.Sprintf("failed to get chain ID: %s", err))
	}

	// Validate ERC-3009 authorization if present
	if auth := payload.Deposit.Authorization.Erc3009Authorization; auth != nil {
		validAfter, ok := new(big.Int).SetString(auth.ValidAfter, 10)
		if !ok {
			return nil, x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer, "invalid validAfter")
		}
		validBefore, ok := new(big.Int).SetString(auth.ValidBefore, 10)
		if !ok {
			return nil, x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer, "invalid validBefore")
		}

		if reason := Erc3009AuthorizationTimeInvalidReason(validAfter, validBefore); reason != "" {
			return nil, x402.NewVerifyError(reason, config.Payer, "ERC-3009 authorization time window invalid")
		}

		// Verify ReceiveWithAuthorization signature
		erc3009Valid, err := verifyReceiveWithAuthorization(
			ctx, signer, config.Payer, config.Token, depositAmount, validAfter, validBefore, auth.Salt, auth.Signature, chainId,
		)
		if err != nil {
			return nil, x402.NewVerifyError(ErrErc3009SignatureInvalid, config.Payer,
				fmt.Sprintf("ERC-3009 signature verification failed: %s", err))
		}
		if !erc3009Valid {
			return nil, x402.NewVerifyError(ErrErc3009SignatureInvalid, config.Payer,
				"ERC-3009 signature is invalid")
		}
	}

	// Verify voucher signature
	voucherValid, err := VerifyBatchedVoucherTypedData(
		ctx, signer,
		channelId,
		payload.Voucher.MaxClaimableAmount,
		config.PayerAuthorizer,
		config.Payer,
		payload.Voucher.Signature,
		chainId,
	)
	if err != nil {
		return nil, x402.NewVerifyError(ErrVoucherSignatureInvalid, config.Payer,
			fmt.Sprintf("voucher signature verification failed: %s", err))
	}
	if !voucherValid {
		return nil, x402.NewVerifyError(ErrVoucherSignatureInvalid, config.Payer,
			"voucher signature is invalid")
	}

	// Check payer balance
	payerBalance, err := signer.GetBalance(ctx, config.Payer, config.Token)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelStateReadFailed, config.Payer,
			fmt.Sprintf("failed to read payer balance: %s", err))
	}
	if payerBalance.Cmp(depositAmount) < 0 {
		return nil, x402.NewVerifyError(ErrInsufficientBalance, config.Payer,
			fmt.Sprintf("payer balance %s is less than deposit amount %s", payerBalance.String(), depositAmount.String()))
	}

	// Read existing channel state.
	// For brand-new channels the contract returns zero values for all fields;
	// ReadChannelState returns those zeros successfully — a nil error with
	// Balance=0, TotalClaimed=0 etc.  A non-nil error means an actual RPC
	// failure, which we surface rather than silently masking.
	state, err := ReadChannelState(ctx, signer, channelId)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelStateReadFailed, config.Payer,
			fmt.Sprintf("failed to read channel state: %s", err))
	}

	// Validate maxClaimableAmount <= balance + deposit
	maxClaimable, ok := new(big.Int).SetString(payload.Voucher.MaxClaimableAmount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer, "invalid maxClaimableAmount")
	}
	effectiveBalance := new(big.Int).Add(state.Balance, depositAmount)
	if maxClaimable.Cmp(effectiveBalance) > 0 {
		return nil, x402.NewVerifyError(ErrMaxClaimableExceedsBal, config.Payer,
			fmt.Sprintf("maxClaimableAmount %s exceeds effective balance %s", maxClaimable.String(), effectiveBalance.String()))
	}

	// Validate maxClaimableAmount > totalClaimed (monotonic increase)
	if maxClaimable.Cmp(state.TotalClaimed) < 0 {
		return nil, x402.NewVerifyError(ErrMaxClaimableTooLow, config.Payer,
			fmt.Sprintf("maxClaimableAmount %s is below totalClaimed %s", maxClaimable.String(), state.TotalClaimed.String()))
	}

	// Simulate the deposit transaction to catch on-chain errors early
	configTuple := buildChannelConfigTuple(config)
	collectorData, err := buildERC3009CollectorData(payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidDepositPayload, config.Payer,
			fmt.Sprintf("failed to build collector data for simulation: %s", err))
	}
	_, simErr := signer.ReadContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementDepositABI,
		"deposit",
		configTuple,
		depositAmount,
		common.HexToAddress(batched.ERC3009DepositCollectorAddress),
		collectorData,
	)
	if simErr != nil {
		return &x402.VerifyResponse{ //nolint:nilerr // simulation failure → error encoded in response
			IsValid:       false,
			InvalidReason: ErrDepositSimulationFailed,
			Payer:         config.Payer,
		}, nil
	}

	// Build response with projected state after deposit
	projectedState := &batched.ChannelState{
		Balance:             effectiveBalance,
		TotalClaimed:        state.TotalClaimed,
		WithdrawRequestedAt: state.WithdrawRequestedAt,
		RefundNonce:         state.RefundNonce,
	}

	return &x402.VerifyResponse{
		IsValid:    true,
		Payer:      config.Payer,
		Extensions: BuildChannelStateExtra(channelId, payload.Voucher.MaxClaimableAmount, projectedState),
	}, nil
}

// SettleDeposit executes a deposit on-chain.
// Calls deposit(config, amount, collector, collectorData) on the BatchSettlement contract.
func SettleDeposit(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batched.BatchedDepositPayload,
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	config := payload.Deposit.ChannelConfig
	network := x402.Network(requirements.Network)

	depositAmount, ok := new(big.Int).SetString(payload.Deposit.Amount, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrInvalidDepositPayload, "", network, config.Payer,
			fmt.Sprintf("invalid deposit amount: %s", payload.Deposit.Amount))
	}

	// Build collector data for ERC-3009 deposit
	collectorData, err := buildERC3009CollectorData(payload)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidDepositPayload, "", network, config.Payer,
			fmt.Sprintf("failed to build collector data: %s", err))
	}

	// Build channel config tuple for contract call
	configTuple := buildChannelConfigTuple(config)

	// Call deposit on the BatchSettlement contract
	txHash, err := signer.WriteContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementDepositABI,
		"deposit",
		configTuple,
		depositAmount,
		common.HexToAddress(batched.ERC3009DepositCollectorAddress),
		collectorData,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrDepositTransactionFailed, "", network, config.Payer,
			fmt.Sprintf("deposit transaction failed: %s", err))
	}

	// Wait for receipt
	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrWaitForReceipt, txHash, network, config.Payer,
			fmt.Sprintf("failed waiting for deposit receipt: %s", err))
	}
	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionReverted, txHash, network, config.Payer,
			"deposit transaction reverted")
	}

	// Read updated channel state
	state, err := ReadChannelState(ctx, signer, payload.Voucher.ChannelId)
	if err != nil {
		state = &batched.ChannelState{
			Balance:      depositAmount,
			TotalClaimed: big.NewInt(0),
			RefundNonce:  big.NewInt(0),
		}
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Payer:       config.Payer,
		Amount:      payload.Deposit.Amount,
		Extensions:  BuildChannelStateExtra(payload.Voucher.ChannelId, payload.Voucher.MaxClaimableAmount, state),
	}, nil
}

// verifyReceiveWithAuthorization verifies an ERC-3009 ReceiveWithAuthorization signature.
func verifyReceiveWithAuthorization(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	from string,
	token string,
	value *big.Int,
	validAfter *big.Int,
	validBefore *big.Int,
	salt string,
	signature string,
	chainId *big.Int,
) (bool, error) {
	// Get token name and version for EIP-712 domain
	tokenName, tokenVersion, err := getTokenDomainInfo(ctx, signer, token)
	if err != nil {
		return false, fmt.Errorf("failed to get token domain info: %w", err)
	}

	domain := evm.TypedDataDomain{
		Name:              tokenName,
		Version:           tokenVersion,
		ChainID:           chainId,
		VerifyingContract: token,
	}

	saltBytes, err := evm.HexToBytes(salt)
	if err != nil {
		return false, fmt.Errorf("invalid salt: %w", err)
	}

	sigBytes, err := evm.HexToBytes(signature)
	if err != nil {
		return false, fmt.Errorf("invalid signature: %w", err)
	}

	message := map[string]interface{}{
		"from":        from,
		"to":          batched.ERC3009DepositCollectorAddress,
		"value":       value,
		"validAfter":  validAfter,
		"validBefore": validBefore,
		"nonce":       saltBytes,
	}

	return signer.VerifyTypedData(
		ctx,
		from,
		domain,
		batched.ReceiveAuthorizationTypes,
		"ReceiveWithAuthorization",
		message,
		sigBytes,
	)
}

// getTokenDomainInfo reads the EIP-712 domain name and version from the token contract.
func getTokenDomainInfo(ctx context.Context, signer evm.FacilitatorEvmSigner, token string) (string, string, error) {
	nameResult, err := signer.ReadContract(ctx, token, evm.ERC20NameABI, "name")
	if err != nil {
		return "", "", fmt.Errorf("failed to read token name: %w", err)
	}
	name, ok := nameResult.(string)
	if !ok {
		return "", "", fmt.Errorf("token name is not a string")
	}

	versionResult, versionErr := signer.ReadContract(ctx, token, evm.ERC20VersionABI, "version")
	if versionErr != nil {
		return name, "1", nil //nolint:nilerr // version() is optional, default to "1"
	}
	version, ok := versionResult.(string)
	if !ok {
		return name, "1", nil
	}

	return name, version, nil
}

// buildERC3009CollectorData encodes the ERC-3009 authorization data for the collector contract.
func buildERC3009CollectorData(payload *batched.BatchedDepositPayload) ([]byte, error) {
	auth := payload.Deposit.Authorization.Erc3009Authorization
	if auth == nil {
		return nil, fmt.Errorf("no ERC-3009 authorization provided")
	}

	// The collector expects the ReceiveWithAuthorization parameters ABI-encoded
	validAfter, ok := new(big.Int).SetString(auth.ValidAfter, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validAfter: %s", auth.ValidAfter)
	}
	validBefore, ok := new(big.Int).SetString(auth.ValidBefore, 10)
	if !ok {
		return nil, fmt.Errorf("invalid validBefore: %s", auth.ValidBefore)
	}
	saltBytes, err := evm.HexToBytes(auth.Salt)
	if err != nil {
		return nil, fmt.Errorf("invalid salt: %w", err)
	}
	sigBytes, err := evm.HexToBytes(auth.Signature)
	if err != nil {
		return nil, fmt.Errorf("invalid signature: %w", err)
	}

	// ABI-encode: (address from, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)
	addressTy, _ := abi.NewType("address", "", nil)
	uint256Ty, _ := abi.NewType("uint256", "", nil)
	bytes32Ty, _ := abi.NewType("bytes32", "", nil)
	bytesTy, _ := abi.NewType("bytes", "", nil)

	args := abi.Arguments{
		{Type: addressTy},
		{Type: uint256Ty},
		{Type: uint256Ty},
		{Type: bytes32Ty},
		{Type: bytesTy},
	}

	var salt32 [32]byte
	copy(salt32[:], saltBytes)

	return args.Pack(
		common.HexToAddress(payload.Deposit.ChannelConfig.Payer),
		validAfter,
		validBefore,
		salt32,
		sigBytes,
	)
}

// buildChannelConfigTuple creates the Solidity-compatible struct for contract calls.
func buildChannelConfigTuple(config batched.ChannelConfig) interface{} {
	withdrawDelay := new(big.Int).SetInt64(int64(config.WithdrawDelay))

	saltBytes := common.FromHex(config.Salt)
	var salt [32]byte
	copy(salt[:], saltBytes)

	// Use anonymous struct matching the Solidity tuple
	return struct {
		Payer              common.Address
		PayerAuthorizer    common.Address
		Receiver           common.Address
		ReceiverAuthorizer common.Address
		Token              common.Address
		WithdrawDelay      *big.Int
		Salt               [32]byte
	}{
		Payer:              common.HexToAddress(config.Payer),
		PayerAuthorizer:    common.HexToAddress(config.PayerAuthorizer),
		Receiver:           common.HexToAddress(config.Receiver),
		ReceiverAuthorizer: common.HexToAddress(config.ReceiverAuthorizer),
		Token:              common.HexToAddress(config.Token),
		WithdrawDelay:      withdrawDelay,
		Salt:               salt,
	}
}
