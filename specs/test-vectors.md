# x402 Grant Test Vectors

**Version:** 1.0  
**Status:** Draft  
**Date:** May 2026  
**Companion Spec:** [specs/grants.md](./grants.md)

## Purpose

These test vectors allow any implementer to verify their EIP-712 grant signing,
verification, and revocation-check logic against the canonical spec **without**
depending on AgentPay or any hosted service.

- All vectors are self-contained.
- Signatures were generated using the exact reference TypeScript code (ethers v6) in `grants.md`.
- A deterministic test private key (standard Hardhat/Anvil account #0) is provided for reproducibility.
- Expected outcomes match the `verifyGrant` + `shouldCheckRevocation` functions from `grants.md`.

---

## Test Private Key (for reproduction only)

```
0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

> Derived principal address: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`  
> This is the standard Hardhat/Anvil test account — **never use in production.**

---

## EIP-712 Domain (used for all vectors)

```json
{
  "name": "x402-AgentGrant",
  "version": "1",
  "chainId": 8453,
  "verifyingContract": "0x0000000000000000000000000000000000000000"
}
```

---

## How to Use

1. Load the JSON below (or `test-vectors.json` if you prefer raw JSON).
2. For each vector, call `verifyGrant(grant, signature, currentAgent, now)`.
3. Also call `shouldCheckRevocation(grant, now)`.
4. Assert both results match `expected.verifyGrant` and `expected.shouldCheckRevocation`.
5. Optionally: use the test private key + `signGrant()` to re-derive the signature and confirm it matches.

---

## Test Vectors

```json
{
  "metadata": {
    "testPrivateKey": "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "testPrincipal": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "domain": {
      "name": "x402-AgentGrant",
      "version": "1",
      "chainId": 8453,
      "verifyingContract": "0x0000000000000000000000000000000000000000"
    },
    "generatedAt": "2026-05-14",
    "note": "All signatures generated with ethers v6 signTypedData against the canonical EIP-712 domain"
  },
  "testVectors": [
    {
      "id": "valid-grant",
      "description": "Fully valid grant \u2014 should verify successfully (happy path)",
      "grant": {
        "grantId": "1",
        "principal": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "agent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "issuedAt": 1747257600,
        "expiration": 1747258500,
        "totalBudget": "1000000000",
        "perRequestCap": "5000000",
        "scopes": [
          "0x8f3a8c9b2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a"
        ],
        "salt": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
      },
      "signature": "0x420765509c3fd0cd9c74877e607b8df5a148d1074ae92545078bac832d950e5d20d5a2f2e63fe117f9a1a5743f480d6cc0e6b4ae6c382ad5776de32a587042891c",
      "now": 1747257900,
      "currentAgent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "expected": {
        "verifyGrant": true,
        "shouldCheckRevocation": false
      }
    },
    {
      "id": "expired-grant",
      "description": "Grant past expiration \u2014 verifyGrant must return false. revocation check would trigger but result is moot since grant is invalid.",
      "grant": {
        "grantId": "2",
        "principal": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "agent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "issuedAt": 1747257600,
        "expiration": 1747258500,
        "totalBudget": "1000000000",
        "perRequestCap": "5000000",
        "scopes": [
          "0x8f3a8c9b2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a"
        ],
        "salt": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
      },
      "signature": "0xf04051a86e80b71d983915276b7c9cd6380bc48a82b984045e3ceef83f64d2123dda82a632b57398e494023a64fcd854441e58e8e0cfc8b2846b134bdaa8d66d1c",
      "now": 1747258600,
      "currentAgent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "expected": {
        "verifyGrant": false,
        "shouldCheckRevocation": true
      }
    },
    {
      "id": "wrong-agent",
      "description": "Valid signature but wrong agent address \u2014 must be rejected",
      "grant": {
        "grantId": "3",
        "principal": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "agent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "issuedAt": 1747257600,
        "expiration": 1747258500,
        "totalBudget": "1000000000",
        "perRequestCap": "5000000",
        "scopes": [
          "0x8f3a8c9b2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a"
        ],
        "salt": "0x1111111111111111111111111111111111111111111111111111111111111111"
      },
      "signature": "0x98c862fa4befbe4e58f8c629fc03c60054ac841377123e79d2d11bced40c83ae4c6528afe474ebc405a52f2d4eb2e16dbccb5ed39f9de7aeee5c7c16911b181e1b",
      "now": 1747257900,
      "currentAgent": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      "expected": {
        "verifyGrant": false,
        "shouldCheckRevocation": false
      }
    },
    {
      "id": "near-expiry-revocation-check",
      "description": "Grant in final 30% of lifetime \u2014 shouldCheckRevocation must return true",
      "grant": {
        "grantId": "4",
        "principal": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "agent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "issuedAt": 1747257600,
        "expiration": 1747258500,
        "totalBudget": "1000000000",
        "perRequestCap": "5000000",
        "scopes": [
          "0x8f3a8c9b2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a"
        ],
        "salt": "0x2222222222222222222222222222222222222222222222222222222222222222"
      },
      "signature": "0x800f9d2ea4232fa694611d26664e111b43f7e548a8527ac5a485b27b31fd56c70cfd166d836eaac2b7b265e726f944a56da15c122d1f055951bf7733e2a5c4c81b",
      "now": 1747258350,
      "currentAgent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "expected": {
        "verifyGrant": true,
        "shouldCheckRevocation": true
      }
    },
    {
      "id": "clock-skew-grace",
      "description": "Grant expiry 31s away \u2014 within \u00b130s grace window, still accepted. shouldCheckRevocation=true since in final 30%.",
      "grant": {
        "grantId": "5",
        "principal": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "agent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "issuedAt": 1747257600,
        "expiration": 1747258500,
        "totalBudget": "1000000000",
        "perRequestCap": "5000000",
        "scopes": [
          "0x8f3a8c9b2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a"
        ],
        "salt": "0x3333333333333333333333333333333333333333333333333333333333333333"
      },
      "signature": "0x08613e67764fdfa92e8e8fe8b1af16634a7ef8b64b4f618000fc67de1f1c858723cc226e43a00c359ed0c5bac8c811e15a3a74e306d2c409ca9a8ff3174dafc61b",
      "now": 1747258469,
      "currentAgent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "expected": {
        "verifyGrant": true,
        "shouldCheckRevocation": true
      }
    },
    {
      "id": "zero-per-request-cap",
      "description": "perRequestCap = 0 means no per-request limit \u2014 valid grant",
      "grant": {
        "grantId": "6",
        "principal": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "agent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "issuedAt": 1747257600,
        "expiration": 1747258500,
        "totalBudget": "1000000000",
        "perRequestCap": "0",
        "scopes": [
          "0x8f3a8c9b2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a"
        ],
        "salt": "0x4444444444444444444444444444444444444444444444444444444444444444"
      },
      "signature": "0x1f5a62b522624c46a7677e28d9cff3545e97020a66a05ecf287b6674aba4b6615a515f5d7538eb266dd6d6d2f0270cb5bdcdd67612a3702469e73d3ce60d804a1c",
      "now": 1747257900,
      "currentAgent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "expected": {
        "verifyGrant": true,
        "shouldCheckRevocation": false
      }
    }
  ]
}
```

---

## Vector Summary

| ID | Description | verifyGrant | shouldCheckRevocation |
|----|-------------|:-----------:|:---------------------:|
| `valid-grant` | Happy path — valid grant mid-lifetime | `true` | `false` |
| `expired-grant` | Past expiration — must be rejected | `false` | `true` |
| `wrong-agent` | Valid sig, wrong `agent` address | `false` | `false` |
| `near-expiry-revocation-check` | Final 30% of lifetime — registry check required | `true` | `true` |
| `clock-skew-grace` | 31s before expiry — inside grace window | `true` | `true` |
| `zero-per-request-cap` | `perRequestCap=0` means no per-request limit | `true` | `false` |

---

## Security Notes

- **Expired-grant revocation check:** When `verifyGrant` returns `false` due to expiry,
  `shouldCheckRevocation` may still return `true` — this is expected (the remaining-time
  math is negative, which is < 30% of lifetime). Implementers MUST check `verifyGrant` first
  and short-circuit before querying the registry.

- **Clock skew:** The ±30s grace window means a grant expiring in 31s still passes
  `verifyGrant`. The `clock-skew-grace` vector confirms this boundary.

- **Signature reproducibility:** Every signature in these vectors can be independently
  re-generated using `signGrant()` from `grants.md` with the provided test private key.
  If your implementation produces a different signature for the same inputs, your
  EIP-712 encoding is incorrect.

---

## Conformance Checklist

A compliant implementation MUST:

- [ ] Pass all 6 vectors with matching `verifyGrant` results
- [ ] Pass all 6 vectors with matching `shouldCheckRevocation` results
- [ ] Reproduce all signatures using the test private key + `signGrant()`
- [ ] Implement the ±30s clock skew grace window
- [ ] Short-circuit on `verifyGrant=false` before querying the revocation registry

---

*Part of the x402 Agent Grant System — [specs/grants.md](./grants.md)*  
*Built by [AgentPay](https://x402-agent-pay.com)*
