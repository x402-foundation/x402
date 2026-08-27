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

CREATE2 factory: `0x4e59b44847b379578588920cA78FbF26c0B4956C`. Salt is `keccak256("x402.auth-capture.test.<Name>.v1")`. ForwardingOperator is constructed with canonical `AuthCaptureEscrow` `0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff`. A bytecode change yields a new address.

| Contract | Address |
| --- | --- |
| ForwardingOperator | `0x7cEc17a1784118Eae0ACD148A4a3E4280F54ABe0` |
| NoopOperator | `0xB275Ff1fb679669A8057965d3Bf36F7601C8b9b1` |
| GasWastingOperator | `0x9471744F28AdbbFbb8996A3862FF63Aac33919F1` |

## Regenerate artifacts

```bash
forge build
# copy `out/<Name>.sol/<Name>.json` `abi` and `bytecode.object` into `artifacts/<Name>.json`
```

Solc 0.8.28, optimizer 200, `cbor_metadata = false`, `bytecode_hash = none` (see `foundry.toml`).
