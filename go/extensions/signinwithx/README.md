# Sign-In-With-X Extension

This package provides Go helpers for the `sign-in-with-x` extension.

It includes:

- Extension declaration helpers
- `SIGN-IN-WITH-X` header encoding and parsing
- SIWE message construction for `eip155:*` chains
- SIWX payload validation
- EVM EOA EIP-191 signature verification

Server/client middleware integration, Solana SIWS verification, EIP-1271, and
EIP-6492 support are intentionally out of scope for this helper package.

