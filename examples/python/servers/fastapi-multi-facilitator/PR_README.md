# x402 Foundation Contribution — GenTech Labs
# PR: Multi-Facilitator FastAPI Example
# Author: ProtoJay4789 (GenTech Labs)
# Date: 2026-07-21
#
# AI Disclosure: Majority of this PR was generated with AI assistance
# (Hermes Agent / DeepSeek V4 Flash). Code was reviewed and verified
# against the x402 Python SDK v2 API before submission.
#
# Submission instructions:
#   1. Fork https://github.com/x402-foundation/x402
#   2. Copy 10-Labs/x402-multi-facilitator-example/ to examples/python/servers/multi-facilitator/
#   3. Run: gh pr create --repo x402-foundation/x402 --title "feat(py): add multi-facilitator FastAPI example" --body "$(cat PR_BODY.md)"
#   4. Add changelog entry: python/x402/changelog.d/20260721_multi_facilitator_example.md

## What this PR adds

A new FastAPI example demonstrating **multi-facilitator x402 v2** — a production pattern
from GenTech Labs' 16-endpoint gateway that uses **two facilitators** (CDP for EVM,
GoPlausible for Algorand AVM) with **multi-chain payment options** and **Bazaar discovery**.

### Key features

- **Multi-facilitator architecture** — separate `x402ResourceServer` instances per
  facilitator, each with its own scheme registration
- **Multi-chain payment options** — EVM (Base Sepolia via CDP) + AVM (Algorand TestNet
  via GoPlausible) in the same route config
- **Bazaar discovery endpoint** — `/.well-known/x402-bazaar` for automated agent discovery
- **Dynamic pricing** — per-endpoint pricing from $0.005 to $0.025
- **Unprotected endpoints** — `/health`, `/pricing`, `/.well-known/x402-bazaar` (no payment)
- **Protected endpoints** — DeFi price, analytics, agent search, security scan

### Why this matters

Most x402 examples show a single facilitator with a single chain. Production gateways
need to support multiple facilitators (CDP, GoPlausible, self-hosted) across multiple
chains simultaneously. This example fills that gap.

### Files

```
examples/python/servers/multi-facilitator/
├── main.py          # FastAPI server with multi-facilitator setup
├── .env.example     # Environment variable template
└── README.md        # Setup and usage instructions
```
