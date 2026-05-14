# x402 Grant Conformance Test Suite

**Version:** 1.0  
**Status:** Live  
**Companion Spec:** [specs/grants.md](../specs/grants.md)  
**Test Vectors:** [specs/test-vectors.json](../specs/test-vectors.json)

---

## One-command conformance test

Any implementer can validate their grant verifier in under 30 seconds:

```bash
# 1. Clone the x402 repo
git clone https://github.com/shawnhvac/x402.git
cd x402/test

# 2. Install & run
npm install
npm test
```

If all tests pass → your implementation is **conformant** with the x402 Grant spec.

---

## What it tests

| Vector ID | Description | Expected |
|-----------|-------------|----------|
| `valid-grant` | Happy path — fully valid grant | `verifyGrant: true` |
| `expired-grant` | Past expiration timestamp | `verifyGrant: false` |
| `wrong-agent` | Caller is not the authorized agent | `verifyGrant: false` |
| `revocation-window` | Final 30% of grant lifetime reached | `shouldCheckRevocation: true` |
| `clock-skew` | Timestamp within ±30s grace window | `verifyGrant: true` |
| `unlimited-cap` | `perRequestCap = 0` means no per-request limit | `verifyGrant: true` |

All signatures were generated with the canonical reference `signGrant` function  
and the [published test private key](../specs/test-vectors.json) (Hardhat account #0).

---

## How to run against your own code

1. Copy `test/conformance.test.ts` into your project
2. Import **your own** `verifyGrant` and `shouldCheckRevocation` implementations
3. Point the import to your local copy of `specs/test-vectors.json`
4. Run the tests

```bash
npm install
npm test
```

If your implementation passes all vectors, add your project to the **Community Implementations** section in `grants.md` — we'll link it from the official spec.

---

## Future extensions

This runner will grow with the spec:

- [ ] Full HTTP header parsing + `receiptHash` validation
- [ ] Revocation registry integration tests  
- [ ] End-to-end payment flow tests (ships with `payment-flow.md`)

---

## Test runner setup

The test suite uses [Vitest](https://vitest.dev/) with minimal dependencies:

| Dependency | Version | Purpose |
|------------|---------|---------|
| `vitest` | `^2.0.0` | Test runner |
| `typescript` | `^5.0.0` | Type checking |
| `ethers` | `^6.13.0` | EIP-712 signature verification |

See `test/package.json` for the full dependency manifest.
