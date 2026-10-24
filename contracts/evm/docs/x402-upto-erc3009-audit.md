# x402 Upto ERC-3009 Audit Notes

## Scope

The review scope is:

- `src/x402UptoERC3009Proxy.sol`
- `src/interfaces/IERC3009.sol`
- the EIP-3009 portions of `specs/schemes/upto/scheme_upto_evm.md`
- deployment scripts and tests that pin the proxy's CREATE2 bytecode and address

The proxy is immutable and has no owner, upgrade path, token allowlist, or recovery function.

## Intended flow

1. The payer signs an EIP-3009 `ReceiveWithAuthorization` for the maximum amount.
2. The signed `to` is the canonical `x402UptoERC3009Proxy`.
3. The signed nonce commits to `payTo`, `settler`, and a random salt:

   ```text
   keccak256(
     abi.encode(
       keccak256("x402UptoERC3009Nonce(address payTo,address settler,bytes32 salt)"),
       payTo,
       settler,
       salt
     )
   )
   ```

4. The bound settler calls `settle` with the actual amount.
5. The proxy receives the maximum, transfers the actual amount to `payTo`, and refunds the
   remainder to the payer in one transaction.

If any call fails, EVM atomicity rolls back the token transfer, nonce consumption, payment, and
refund.

## Roles and trust

| Role | Authority |
| --- | --- |
| Payer | Selects the token, maximum, time window, proxy, merchant, and settler through one token signature. |
| Settler | Chooses any non-zero amount up to the signed maximum and pays transaction gas. |
| Merchant | Receives the settled amount and has no contract privilege unless also selected as settler. |
| Facilitator | May be selected as settler; otherwise has no contract privilege. |

The payer trusts the selected settler to report usage honestly. This is the same bounded discretion
as the Permit2 `upto` path. Arbitrary relayers are not supported because the actual amount is not
independently signed.

## Security invariants

- Only the nonce-bound settler can call successfully.
- The payment destination and settler cannot be changed without invalidating the nonce commitment.
- The actual amount is greater than zero and no greater than the signed maximum.
- The refund always returns to the signed token owner.
- Each token authorization can settle at most once.
- A successful settlement does not increase the proxy's token balance.
- Pre-existing token donations are not consumed by a settlement.
- Reentrancy into `settle` is rejected.
- `receiveWithAuthorization` prevents a third party from transferring the maximum into the proxy
  without executing its payment and refund logic.

## Token assumptions

The token must:

- implement the `bytes signature` form of EIP-3009 `receiveWithAuthorization`;
- enforce `msg.sender == to`;
- consume nonces atomically;
- transfer exact requested amounts; and
- behave consistently with `SafeERC20` for outgoing transfers.

Fee-on-transfer and rebasing tokens are unsupported. Smart-wallet support is token-specific. The
payer must retain the full maximum until settlement even when the expected charge is lower.

Tokens may pause transfers, blacklist participants, cancel authorizations, or change balances
between verification and settlement. Those conditions cause settlement to revert without moving
funds.

## Deliberate exclusions

- zero-amount onchain settlement;
- multiple or partial uses of one authorization;
- arbitrary relayers with a second settlement signature;
- admin recovery of tokens sent directly to the proxy;
- token allowlisting in the contract; and
- protocol fees.

## Verification evidence

The test suite covers signature validation, nonce preimage tampering, unauthorized callers, time
bounds, replay, partial and full settlement, exact refund accounting, transfer rollback,
reentrancy, direct-call front-running, donated balances, fuzzed amount conservation, stateful
invariants, deterministic deployment, and real-USDC fork behavior.

Before audit handoff, record:

- the final commit;
- ABI and runtime bytecode hashes;
- CREATE2 deployer, salt, init-code hash, and canonical address;
- unit, fuzz, invariant, coverage, fork, and gas-report outputs; and
- any changes made after review begins.

Current pre-audit build:

- init-code hash: `0x363e9dbe63e0ee693a6862ecb15776d098496557e92465f8a472ceca5d14c3c4`
- runtime bytecode hash: `0x8fba4527663e9befb4f58880cbc22c60d3b9c7a98a271a7c6abed44e49b324cf`
- CREATE2 deployer: `0x4e59b44847b379578588920cA78FbF26c0B4956C`
- CREATE2 salt: `0x499f5f90c3d3a2a7d6d3923352743977103de15c64118ab7ba02679d5efb5e98`
- pre-audit address: `0x40208Cd083acD9559Ce44742c4BcD9Cf04850006`

Verification results:

- complete Foundry suite: 228 passed, 0 failed;
- proxy coverage: 100% lines, statements, branches, and functions;
- Base mainnet fork against USDC: 4 passed, 0 failed;
- optimized mock-token gas: 104,911 for full settlement and 108,974 for partial settlement with refund;
- CREATE2 address computation and deployment regressions: passed;
- changed-file formatting, whitespace checks, ABI generation, and Rust miner tests: passed.

Repository-wide coverage instruments contracts without the production optimizer settings, so
CREATE2 canonical-address tests fail under that mode because the creation bytecode changes. Scoped
proxy coverage passes and the canonical-address regressions pass under the production Foundry
profile.
