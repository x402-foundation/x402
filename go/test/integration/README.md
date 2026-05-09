# Integration Tests

These integration tests verify the complete x402 payment flows with real mechanism implementations. The EVM and SVM tests can make **real on-chain transactions** when configured with private keys.

## Test Overview

### Core Integration Tests (Always Run)
- ✅ **TestCoreIntegration** - Core x402 client/service/facilitator flow (mock cash)
- ✅ **TestHTTPIntegration** - HTTP layer integration (mock cash)

### Mechanism Integration Tests (Require Configuration)
- 🔐 **TestEVMIntegrationV2** - Full EVM V2 payment flow (Base Sepolia)
- 🔐 **TestEVMIntegrationV1** - Full EVM V1 payment flow (Base Sepolia)
- 🔐 **TestSVMIntegrationV2** - Full SVM V2 payment flow (Solana Devnet)
- 🔐 **TestSVMIntegrationV1** - Full SVM V1 payment flow (Solana Devnet)

### Batch-Settlement (Batched) Integration Tests (Require Configuration)
EVM batched mechanism tests in `evm_batch_settlement_test.go`. All tests
issue **real Base Sepolia transactions** and skip when env vars are missing.

- 🔐 **TestBatchSettlementIntegration_DepositThenVoucher** — direct API: deposit + follow-up voucher
- 🔐 **TestBatchSettlementIntegration_HTTPMiddleware** — full HTTP middleware end-to-end
- 🔐 **TestBatchSettlementIntegration_MultiVoucherClaimSettle** — 4 requests + manager.Claim + manager.Settle
- 🔐 **TestBatchSettlementIntegration_RefundPartial** — partial refund leaves channel open
- 🔐 **TestBatchSettlementIntegration_RefundDrainedChannelShortCircuit** — local short-circuit on drained channel
- 🔐 **TestBatchSettlementIntegration_RefundNonRecoverableFastFail** — `amount_exceeds_balance` errors immediately
- 🔐 **TestBatchSettlementIntegration_RefundRecoverableRetryExhaustion** — recoverable 402 → retry → exhaust
- 🔐 **TestBatchSettlementIntegration_AutoClaimTick** — `ClaimIntervalSecs` triggers OnClaim
- 🔐 **TestBatchSettlementIntegration_AutoClaimAndSettleTick** — both OnClaim and OnSettle fire
- 🔐 **TestBatchSettlementIntegration_WithdrawalPendingRefund** — pending-withdraw detection + manager.Refund

Tests marked with 🔐 require environment variables and will **skip** if not configured.

## Running Tests

### Without Configuration (Core Tests Only)
```bash
make test-integration
```

**Output**:
```
✅ TestCoreIntegration - PASS
✅ TestHTTPIntegration - PASS
⏭️  TestEVMIntegrationV2 - SKIP (env vars not set)
⏭️  TestEVMIntegrationV1 - SKIP (env vars not set)
⏭️  TestSVMIntegrationV2 - SKIP (env vars not set)
⏭️  TestSVMIntegrationV1 - SKIP (env vars not set)
```

### With Configuration (All Tests + Real Transactions)
```bash
# Set environment variables
source .env

# Run integration tests
make test-integration
```

**Output**:
```
✅ TestCoreIntegration - PASS
✅ TestHTTPIntegration - PASS
✅ TestEVMIntegrationV2 - PASS (real Base Sepolia transaction)
✅ TestEVMIntegrationV1 - PASS (real Base Sepolia transaction)
✅ TestSVMIntegrationV2 - PASS (real Solana Devnet transaction)
✅ TestSVMIntegrationV1 - PASS (real Solana Devnet transaction)
```

## Configuration

Create a `.env` file in the `go/` directory:

```bash
# EVM Configuration (Base Sepolia)
EVM_CLIENT_PRIVATE_KEY=<hex_private_key_without_0x>
EVM_FACILITATOR_PRIVATE_KEY=<hex_private_key_without_0x>
EVM_RESOURCE_SERVER_ADDRESS=<0x_ethereum_address>

# Batch-Settlement reuses the EVM_* keys above (EVM_RESOURCE_SERVER_ADDRESS is the payee)
EVM_AUTHORIZER_PRIVATE_KEY=<hex_private_key>        # optional, defaults to EVM_FACILITATOR_PRIVATE_KEY
EVM_RPC_URL=https://sepolia.base.org                # optional, defaults to Base Sepolia public RPC

# SVM Configuration (Solana Devnet)
SVM_CLIENT_PRIVATE_KEY=<base58_private_key>
SVM_FACILITATOR_PRIVATE_KEY=<base58_private_key>
SVM_FACILITATOR_ADDRESS=<base58_solana_address>
SVM_RESOURCE_SERVER_ADDRESS=<base58_solana_address>
```

### Required Setup

#### EVM (Base Sepolia)
1. **Client Wallet**: Must have USDC balance on Base Sepolia
2. **Facilitator Wallet**: Must have ETH for gas fees
3. **Resource Server Address**: Destination for payments
4. **Network**: Base Sepolia (ChainID: 84532)
5. **Token**: USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`)

**Get Testnet USDC**:
- Faucet: https://faucet.circle.com/
- Or bridge from Sepolia to Base Sepolia

#### SVM (Solana Devnet)
1. **Client Wallet**: Must have USDC balance on Solana Devnet
2. **Client ATA**: Must have Associated Token Account for USDC
3. **Resource Server ATA**: Must have Associated Token Account for USDC
4. **Facilitator Wallet**: Must have SOL for transaction fees
5. **Network**: Solana Devnet
6. **Token**: USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`)

**Get Testnet USDC**:
```bash
# Get SOL from faucet
solana airdrop 2 <your_address> --url devnet

# Create ATA for USDC
spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --url devnet

# Get USDC from faucet (if available)
# Or use Solana Devnet USDC faucet
```

## What the Tests Do

### EVM Integration Tests
1. ✅ Creates real client with private key
2. ✅ Creates real facilitator with private key
3. ✅ Builds payment requirements (0.001 USDC)
4. ✅ Client creates EIP-3009 authorization and signs with EIP-712
5. ✅ Service verifies authorization signature
6. ✅ Service validates amount, recipient, nonce
7. ✅ **Facilitator submits transferWithAuthorization on-chain**
8. ✅ Waits for transaction confirmation
9. ✅ Verifies transaction succeeded

### SVM Integration Tests
1. ✅ Creates real client with private key
2. ✅ Creates real facilitator with private key
3. ✅ Builds payment requirements (0.001 USDC)
4. ✅ Client creates Solana transaction with:
   - Compute budget instructions
   - SPL Token TransferChecked instruction
5. ✅ Client partially signs transaction
6. ✅ Service decodes and validates transaction structure
7. ✅ Service validates compute prices, amount, mint, recipient
8. ✅ Facilitator co-signs transaction
9. ✅ **Facilitator submits transaction to Solana Devnet**
10. ✅ Waits for transaction confirmation (with retries)
11. ✅ Verifies transaction succeeded

## Test Output Examples

### EVM Test Output (With Configuration)
```
=== RUN   TestEVMIntegrationV2
  evm_test.go:400: ✅ Payment verified successfully from 0x1234...
  evm_test.go:429: ✅ Payment settled successfully! Transaction: 0xabcd...
--- PASS: TestEVMIntegrationV2 (5.2s)
```

### SVM Test Output (With Configuration)
```
=== RUN   TestSVMIntegrationV2
  svm_test.go:288: ✅ Payment payload created with transaction: 512 bytes
  svm_test.go:309: ✅ Payment verified successfully from ABC123...
  svm_test.go:336: ✅ Payment settled successfully! Transaction: 5J7...
  svm_test.go:337:    View on Solana Explorer: https://explorer.solana.com/tx/5J7.../devnet
--- PASS: TestSVMIntegrationV2 (8.1s)
```

## Troubleshooting

### EVM Tests Failing

**Error**: "insufficient balance"
- ➡️ Ensure client wallet has USDC on Base Sepolia
- ➡️ Use Circle faucet: https://faucet.circle.com/

**Error**: "invalid signature"
- ➡️ Check EVM_CLIENT_PRIVATE_KEY is correct (no 0x prefix)
- ➡️ Verify ChainID is 84532 (Base Sepolia)

**Error**: "nonce already used"
- ➡️ Wait a bit and retry (nonce was used in previous test)
- ➡️ Or use a new nonce (automatic in code)

### SVM Tests Failing

**Error**: "ATA not found"
- ➡️ Create Associated Token Accounts for USDC:
  ```bash
  spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --url devnet
  ```
- ➡️ Must create ATAs for both client and resource server addresses

**Error**: "insufficient lamports"
- ➡️ Get SOL from devnet faucet:
  ```bash
  solana airdrop 2 <address> --url devnet
  ```

**Error**: "transaction simulation failed"
- ➡️ Check all ATAs exist
- ➡️ Check client has USDC balance
- ➡️ Check facilitator has SOL for fees

## Security Notes

⚠️ **NEVER commit private keys to git**
⚠️ Use `.env` file and ensure it's in `.gitignore`
⚠️ Only use testnet keys with no real value
⚠️ These tests use devnet/testnet networks only

## CI/CD Integration

For CI/CD pipelines, you can:

1. **Skip tests by default** (no env vars)
2. **Run with secrets** in protected branches:
   ```yaml
   env:
     EVM_CLIENT_PRIVATE_KEY: ${{ secrets.EVM_CLIENT_PRIVATE_KEY }}
     EVM_FACILITATOR_PRIVATE_KEY: ${{ secrets.EVM_FACILITATOR_PRIVATE_KEY }}
     # ... other secrets
   ```

## Comparison with TypeScript

The Go integration tests match the TypeScript implementation:

| Feature | TypeScript | Go | Status |
|---------|-----------|-----|--------|
| Real signers | ✅ | ✅ | Implemented |
| On-chain transactions | ✅ | ✅ | Implemented |
| Environment variables | ✅ | ✅ | Implemented |
| Skip if not configured | ✅ | ✅ | Implemented |
| EVM (Base Sepolia) | ✅ | ✅ | Implemented |
| SVM (Solana Devnet) | ✅ | ✅ | Implemented |

## Performance

**Without Configuration**: ~1.5s (skips mechanism tests)
**With Configuration**: ~10-20s (includes real blockchain transactions)

## Next Steps

To run full on-chain tests:
1. Generate test wallets
2. Fund wallets with testnet tokens
3. Create ATAs (for SVM)
4. Set environment variables
5. Run `make test-integration`
6. Watch real transactions execute! 🚀

