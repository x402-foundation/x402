# Auth-capture test operators

**Warning: integration-test contracts only. Not audited. Do not use in production.**

These Solidity files exist so `@x402/evm` custom-operator integration tests can hit real bytecode on Base Sepolia (`eth_simulateV1`, gas cap, escrow events). They are not production operators and not a template for a merchant operator.

`collectorData` is payer-controlled opaque bytes. A forwarding operator passes it through unchanged; ERC-6492 preparation calldata is interpreted only by the canonical token collector, which executes it through a neutral Multicall3 sender.

| Contract | Role in tests |
| --- | --- |
| `ForwardingOperator.sol` | Spec-minimum: permissionless `authorize` / `charge` that forward 1:1 to canonical `AuthCaptureEscrow` |
| `NoopOperator.sol` | Adversarial: same selectors, empty body (success, no escrow event) |
| `GasWastingOperator.sol` | Adversarial: burns well over the facilitator collect gas cap, never calls escrow |

Committed ABI + creation bytecode live in `artifacts/`. Integration tests CREATE2-deploy via Arachnid’s deployer and skip if code is already at the predicted address.

## Base Sepolia addresses

CREATE2 factory: `0x4e59b44847b379578588920cA78FbF26c0B4956C`. Salt is `keccak256("x402.auth-capture.test.<Name>.v1")`. ForwardingOperator is constructed with canonical `AuthCaptureEscrow` `0xf96815976523E00e65Be8f34cA5e64b4f41EB19c`. A bytecode change yields a new address.

| Contract | Address |
| --- | --- |
| ForwardingOperator | `0x8FE415CdB559fBF5B235B81CC4F7a69684A274bb` |
| NoopOperator | `0x00Cc67f415Fec4ddAFB4F4a36F324AbBfdddFf27` |
| GasWastingOperator | `0x637233E61c1cCC12f2Aa5e83524d976be5E2dE04` |

## Regenerate artifacts

```bash
forge build
# copy `out/<Name>.sol/<Name>.json` `abi` and `bytecode.object` into `artifacts/<Name>.json`
```

Solc 0.8.28, optimizer 200, `cbor_metadata = false`, `bytecode_hash = none` (see `foundry.toml`).
