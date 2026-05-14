# x402 Specification

This folder contains documentation of x402, separated by version where applicable.

The x402 standard separates transport (how data is exchanged), from the logical way money moves (exact, defer, etc), and the network where value is exchanged.

---

## Extensions & Agent Protocols

| File | Description | Status |
|------|-------------|--------|
| [grants.md](./grants.md) | x402 Agent Grant System â EIP-712 signed spend delegation for AI agents | Live |
| [test-vectors.md](./test-vectors.md) / [.json](./test-vectors.json) | Verifiable test data with real Hardhat signatures | Live |
| [conformance.md](./conformance.md) | One-command conformance test suite (`npm test`) | Live |
| [payment-flow.md](./payment-flow.md) | End-to-end payment lifecycle with Mermaid sequence diagram | Live |
| [reputation.md](./reputation.md) | Optional reputation layer â subgraph scoring for Sybil-resistance | Live |
| [subgraph.md](./subgraph.md) | The Graph subgraph deployment guide â schema, manifest, full AssemblyScript mapping | Live |

---

## Reference Implementations

| Example | Description | Status |
|---------|-------------|--------|
| [examples/minimal-node-python](../examples/minimal-node-python/) | Node.js paying agent + Python receiving agent â clone & run in 60s | Live |
| [examples/minimal-node-python/BASE_SEPOLIA.md](../examples/minimal-node-python/BASE_SEPOLIA.md) | Real USDC settlement on Base Sepolia via EIP-3009 | Live |

---

## Subgraph Source

The complete subgraph workspace (ready to `graph deploy`) lives in [`subgraph/`](../subgraph/).

```
subgraph/
├── subgraph.yaml          ← manifest (update addresses before deploy)
├── schema.graphql         ← entity definitions
├── package.json           ← yarn install then yarn deploy
├── src/mapping.ts         ← full AssemblyScript event handlers + scoring
└── abis/                  ← SettlementListener + x402GrantRegistry ABIs
```
