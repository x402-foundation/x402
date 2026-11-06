# Stellar contracts

## `upto/` — x402 `upto` settlement contract

`x402-upto-stellar` settles payments of the x402 [`upto` scheme on Stellar](../../specs/schemes/upto/scheme_upto_stellar.md): the payer authorizes a maximum, and the settlement authority (the facilitator) later charges any amount from 0 up to that maximum. It is written against `soroban-sdk` 28.0.0 and has no admin, no upgrade path, no storage and no constructor.

### Interface

```rust
fn settle(env: Env, payer: Address, terms: UptoTerms, amount: i128) -> Result<i128, UptoError>;
fn version(env: Env) -> u32; // 1

struct UptoTerms {            // an ScMap on the wire, keys in this order
    expiration_ledger: u32,   // last ledger (inclusive) at which the terms can be settled
    facilitator: Address,     // the only address that can choose the amount
    max_amount: i128,         // maximum in atomic units of `token`, > 0
    recipient: Address,       // G… account or C… contract
    token: Address,           // SEP-41 token contract
    valid_after_ledger: u32,  // first ledger at which the terms can be settled
}
```

`settle` returns the settled amount and emits one `upto_settled` event (topics: `"upto_settled"`, payer, recipient; data: `token`, `amount`, `max_amount`, `facilitator`), also for a zero amount.

### Authorization

The payer signs one Soroban authorization entry whose tree is exactly:

```text
settle(terms)                                                            on the settlement contract
└── approve(payer, <settlement contract>, max_amount, expiration_ledger)   on terms.token
```

The amount is not part of the payer's signature. Instead `terms.facilitator` must authorize `settle(payer, terms, amount)`, so only the settlement authority the payer named can choose the amount, and it can choose only a value in `0..=max_amount`. For a positive amount the contract then calls the signed `approve` and pulls the amount with `transfer_from`, which the token authorizes because the contract is the direct invoker. A zero amount makes no token calls.

Single use comes from the payer's authorization nonce, which the Soroban host consumes when the entry is used and keeps until the signature expires. A failed settlement rolls back everything, nonce included. The allowance that a partial settlement leaves (at most `max_amount − amount`) expires at `expiration_ledger`, can only be spent by the settlement contract itself, and is overwritten by the next settlement's `approve` before anything is spent.

### Errors

| Code | Name               | When                                              |
| ---- | ------------------ | ------------------------------------------------- |
| 1    | `InvalidMaxAmount` | `max_amount` is zero or negative                  |
| 2    | `NegativeAmount`   | `amount` is negative                              |
| 3    | `AmountExceedsMax` | `amount` is larger than `max_amount`              |
| 4    | `NotYetValid`      | the current ledger is before `valid_after_ledger` |
| 5    | `Expired`          | the current ledger is after `expiration_ledger`   |
| 6    | `InvalidRecipient` | `recipient` is the settlement contract itself     |

Authorization failures surface as host errors: `Error(Auth, InvalidAction)` when an authorization is missing or does not match, `Error(Auth, ExistingValue)` when the payer's entry was already used.

### Deployments

| Network           | Contract                                                   | WASM sha256                                                        | Record                                                 |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `stellar:testnet` | `CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U` | `cc2d2fefe77d1a470abe88be8563679a9d40f49c127683947784c0cb2d0ca797` | [`deployments/testnet.json`](deployments/testnet.json) |

`@x402/stellar/upto/*` uses this deployment on `stellar:testnet` unless a contract is configured. There is no pubnet deployment yet.

The address depends only on the network, the deployer and the salt `sha256("x402-upto-stellar/v1.1")` (`37971407…f7330b`), so it can be computed before anything is sent, and only the deployer can create a contract there. The contract has no admin and cannot be upgraded, so the deployer holds no privilege over it afterwards. The deployment record holds the WASM and source-archive hashes, the build image, options and CLI, the deployer, the salt, the hash and ledger of every deployment transaction (upload, deploy, both TTL extensions), the ledgers until which the instance and the code live, the CLI version that sent them, and under `previous` the deployment it replaced (`CCNU3CYA…AYPB`, salt `sha256("x402-upto-stellar/v1")`: the same source built without the `source_repo` metadata, still on chain and unchanged). Its `commit` is the revision of the repository the contract was deployed from; the crate directory here is byte-identical to it, which the source-archive hash below proves.

### Tests

```sh
cd contracts/stellar/upto
cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked
```

The tests cover partial, maximum and zero settlements with balance, event and authorization-tree checks; every error including both inclusive ledger bounds; the facilitator binding (missing, different amount, different submitter, different operation source); mutated terms and approve arguments; real ed25519 signatures through a contract account with V1 and V2 credentials, replay, expiry and a `SOURCE_ACCOUNT` authority; the residual allowance; the absence of contract storage; and a resource-cost snapshot.

The crate, its tests included, is frozen byte for byte: the deployment record names the SHA-256 of the crate's source archive, which covers every file in `upto/`, so changing even a test no longer matches the deployed contract's record and requires a new deployment under a new salt. New tests of the deployed contract belong in a separate crate that depends on it by path.

### Reproducible build

The crate directory `upto/` is the complete build input: `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.gitignore` and `src/`. The deployed WASM is built the way stellar.expert's release workflow ([`stellar-expert/soroban-build-workflow`](https://github.com/stellar-expert/soroban-build-workflow)) builds it: `stellar contract build --optimize` by stellar-cli 28.1.0 on Rust 1.98.0, with the [SEP-55](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0055.md) metadata `source_repo=github:tolgayayci/rail402`, the repository it is released and attested from. Only Docker and curl are needed:

```sh
cd contracts/stellar/upto
image="docker.io/stellar/stellar-cli:28.0.0-rust1.98.0-slim-trixie-amd64-0@sha256:3901802ef2324ff9563a50995279818ca4b98938b45e1dab0e1e7c5d69adb5a9"
out="$(mktemp -d)" && mkdir "$out/cargo"

# 1. The source archive: fixed order, timestamps, ownership and modes, made by the image's own tar and gzip.
docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" -v "$PWD:/work/source:ro" -v "$out:/out" -w /work \
  --entrypoint sh "$image" -c 'tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    --format=posix --mode=u=rwX,go=rX,ug-s \
    --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
    --exclude=source/target --exclude=source/test_snapshots -cf - source | gzip -9 -n > /out/source.tar.gz'
sha256sum "$out/source.tar.gz"                                        # c783ef0838c7…02343

# 2. The official stellar-cli 28.1.0 release binary.
curl -fsSL -o "$out/stellar-cli.tar.gz" \
  https://github.com/stellar/stellar-cli/releases/download/v28.1.0/stellar-cli-28.1.0-x86_64-unknown-linux-gnu.tar.gz
echo "c1680deee94301d33ada7a17f98411e642a4248c727afbd2e43050d345746462  $out/stellar-cli.tar.gz" | sha256sum -c -
tar -xzf "$out/stellar-cli.tar.gz" -C "$out" stellar

# 3. The WASM, built by that binary on the image's Rust 1.98.0.
docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" -v "$PWD:/source" -v "$out/cargo:/cargo" \
  -v "$out/stellar:/opt/stellar:ro" --entrypoint /opt/stellar -w /source \
  -e CARGO_HOME=/cargo -e CARGO_TARGET_DIR=/source/target -e RUSTUP_TOOLCHAIN=1.98.0 \
  "$image" contract build --locked --optimize --package x402-upto-stellar --meta source_repo=github:tolgayayci/rail402
sha256sum target/wasm32v1-none/release/x402_upto_stellar.wasm        # cc2d2fefe77d…ca797
```

The result depends neither on the host path nor on the host user or toolchain. The image is `linux/amd64` only; on an arm64 host Docker runs it under emulation, slower but with the same bytes. `stellar contract info meta --wasm target/wasm32v1-none/release/x402_upto_stellar.wasm` prints the embedded metadata (`rsver`, `rssdkver`, `cliver`, `source_repo`), and `stellar contract fetch --id CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U --network testnet | sha256sum` gives the same hash for the deployed contract.

### Contract TTL

The contract never extends its own instance or code. Since protocol 23 an invocation that touches an archived instance restores it automatically and pays for the restoration in the same transaction, so whoever operates the contract should keep both entries live and restore them explicitly if they were archived; facilitators refuse a payment whose settlement would restore them. Anyone may extend or restore the entries; the operations need no authorization from the contract.

```sh
# Extend the instance and the code (any funded account can send these).
stellar contract extend --id <contract> --durability persistent --ledgers-to-extend 3110399 --network testnet --source <account>
stellar contract extend --wasm-hash <wasm sha256> --ledgers-to-extend 3110399 --network testnet --source <account>
# After archival: restore both entries, then extend them as above.
stellar contract restore --id <contract> --durability persistent --network testnet --source <account>
stellar contract restore --wasm-hash <wasm sha256> --network testnet --source <account>
```

`3110399` is the largest extension testnet accepts today (`max_entry_ttl − 1`). The deployment record's `live_until_ledger` shows where the entries stood right after deployment.
