package clientutil

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

// HasSufficientPermit2Allowance reports whether owner has already approved at
// least requiredAmount of tokenAddress to Permit2. It returns false on any read
// or parse failure so callers conservatively attach an approval extension.
func HasSufficientPermit2Allowance(
	ctx context.Context,
	readSigner evm.ClientEvmSignerWithReadContract,
	tokenAddress string,
	owner string,
	requiredAmount string,
) bool {
	allowanceResult, err := readSigner.ReadContract(
		ctx,
		tokenAddress,
		evm.ERC20AllowanceABI,
		"allowance",
		common.HexToAddress(owner),
		common.HexToAddress(evm.PERMIT2Address),
	)
	if err != nil {
		return false
	}
	allowance, ok := allowanceResult.(*big.Int)
	if !ok {
		return false
	}
	required, ok := new(big.Int).SetString(requiredAmount, 10)
	if !ok {
		return false
	}
	return allowance.Cmp(required) >= 0
}
