# EVM V1 Implementation

This package contains the V1 implementation of the EVM mechanism for x402. 

## Key Differences from V2

1. **Version Support**: Only supports x402 version 1 (v2 supports version 2)

2. **ValidAfter Buffer**: V1 subtracts 10 minutes from the current time for `validAfter` to ensure the transaction is immediately valid. V2 uses the current time directly.

3. **Default Validity Window**: V1 uses a 10-minute window by default, V2 uses 1 hour.

4. **Price Parsing**: V1 has simpler price parsing logic, defaulting to USDC for the network.

## Usage

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    evmv1 "github.com/x402-foundation/x402/go/mechanisms/evm/exact/v1"
)

// Register V1 client
client := x402.Newx402Client()
client = evmv1.RegisterClient(client, signer)

// Register V1 facilitator  
facilitator := x402.Newx402Facilitator()
facilitator = evmv1.RegisterFacilitator(facilitator, signer)

// Register V1 server
server := x402.Newx402ResourceServer(
    evmv1.RegisterServer(),
)
```

## Migration to V2

To migrate from V1 to V2:

1. Update x402 version in payment requirements from 1 to 2
2. Remove any custom `validAfter` buffer logic (V2 handles this)
3. Update imports from `evm/v1` to `evm`
4. Test thoroughly, especially around timing windows

## Compatibility

V1 is maintained for backward compatibility with existing integrations. New implementations should use V2 (the parent `evm` package).
