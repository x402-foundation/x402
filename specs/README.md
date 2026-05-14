# x402 Specification

This folder contains documentation of x402, separated by version where applicable.

The x402 standard separates transport (how data is exchanged), from the logical way money moves (exact, defer, etc), and the network where value is exchanged.

---

## Extensions & Agent Protocols

| File | Description | Status |
|------|-------------|--------|
| [grants.md](./grants.md) | x402 Agent Grant System — EIP-712 signed spend delegation for AI agents | Live |
| [test-vectors.md](./test-vectors.md) / [.json](./test-vectors.json) | Verifiable test data with real Hardhat signatures | Live |
| [conformance.md](./conformance.md) | One-command conformance test suite (`npm test`) | Live |
| [payment-flow.md](./payment-flow.md) | End-to-end payment lifecycle with Mermaid sequence diagram | Live |
| reputation.md | Agent reputation & trust scoring via The Graph subgraph | Planned |
| subgraph.md | The Graph subgraph schema for revocation + reputation indexing | Planned |
