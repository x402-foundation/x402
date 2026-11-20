# Contributing to x402 .NET

This guide supplements the root contribution policy in `../CONTRIBUTING.md`.

## Requirements

- Follow all root repository contribution requirements.
- Review all AI-assisted output before requesting review.
- Keep code and docs concise; remove redundant generated content.
- Prioritize correctness for payment, signing, and settlement behavior.
- Use signed commits.
- Add tests for all user-facing behavior changes.

## Local Development

From `dotnet/`:

```bash
dotnet build X402.slnx
dotnet test X402.slnx
```

## Project Scope

Current package:
- `src/X402.Core`: shared protocol and utility foundation.

Planned packages:
- `X402.Http`
- `X402.AspNetCore`
- `X402.Mechanisms.Evm`

## Change Quality Checklist

- Protocol fields and header names are spec-aligned.
- v1/v2 compatibility behavior is explicitly tested.
- CAIP-2 network parsing/matching includes wildcard cases.
- New code is covered by unit or integration tests.