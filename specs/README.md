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
| subgraph.md | The Graph subgraph deployment guide (pending James Mulqueenyâs infra) | Planned |

---

## Reference Implementations

| Example | Description | Status |
|---------|-------------|--------|
| [examples/minimal-node-python](../examples/minimal-node-python/) | Node.js paying agent + Python receiving agent â clone & run in 60s | Live |
| [examples/minimal-node-python/BASE_SEPOLIA.md](../examples/minimal-node-python/BASE_SEPOLIA.md) | Real USDC settlement on Base Sepolia via EIP-3009 | Live |
