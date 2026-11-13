# Scheme: `knos-order` `svm`

## Summary

The `knos-order` scheme on Solana locks the client's payment in a **work order**: an account of the open-source [`knos_pay`](https://github.com/drexthealpha/Knos/tree/main/programs-v2/knos_pay) escrow program. The order pays `payTo` when a GitHub Actions OIDC token, signed by GitHub for the workflow the order pins, is verified on chain by [`knos-oidc`](https://github.com/drexthealpha/Knos/tree/main/programs-v2/knos_oidc). After the order's deadline anyone can send `RefundOrder`, which returns the amount and the fee to the client.

The facilitator signs nothing and pays no fee. `/verify` and `/settle` are reads of one account.

| | |
| --- | --- |
| Networks | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet) only. The programs are not deployed on mainnet. |
| Escrow program | `5y7iWJ1VAMJjnnWbbdo2a2PsWJEwTExSNpzrvQSEnS8k` (`knos_pay`) |
| Verifier program | `FkwZdsYCmzicJMtHLTkPK76bYNVG4WNwkWJBiVWNtF3W` (`knos-oidc`) |
| Assets | SPL Token mints with 6 decimals. On devnet: Circle's test USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. |
| Status | Proposal. Both programs are upgradeable through a 2-of-3 multisig whose three keys one person holds, with a 48-hour delay, and have had no outside audit. |

## `PaymentRequirements`

See `PaymentRequirements` in [x402-specification-v2.md](../../x402-specification-v2.md#5-types). Scheme-specific fields are in `extra`.

```json
{
  "scheme": "knos-order",
  "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "amount": "20000000",
  "asset": "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1",
  "payTo": "6JhaGdekBjU2RfiYWSjYdQAibx4LfSfTNFEeMUHnUVz7",
  "maxTimeoutSeconds": 604800,
  "extra": {
    "program": "5y7iWJ1VAMJjnnWbbdo2a2PsWJEwTExSNpzrvQSEnS8k",
    "order": "J222WNWuZwhfgRBMc4jDu9MjGG6eCc2Up8P4FFADWVYp",
    "repoId": "987654321",
    "issue": "77",
    "seq": 0,
    "mode": 0,
    "terms": "{\"accept\":\"\",\"checks\":[{\"app\":15368,\"name\":\"test\"}],\"deny\":[\".github/**\",\".knos/**\"],\"mode\":\"merge\",\"paths\":[],\"reserve\":0,\"v\":1}",
    "termsHash": "92aeb2ac236fe3581aa4366a8729c5c772044a23c87ce5fe9d0cf9697c964b57",
    "workflows": {
      "repository": "drexthealpha/Knos",
      "sha": "cccccccccccccccccccccccccccccccccccccccc"
    },
    "fee": "60000",
    "payee": {
      "githubId": "5550123"
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `amount` | What `payTo` receives, in the mint's atomic units. The client pays `extra.fee` on top. |
| `payTo` | The resource server's wallet. The escrow pays it; the client never does. |
| `maxTimeoutSeconds` | The order's work time. Its deadline is the funding time plus this. |
| `extra.program` | The escrow program. A client MUST refuse a program it does not know. |
| `extra.order` | The order's address for the payer named in the optional `Attested-Payer` request header, or `null`. The client MUST derive the address itself. |
| `extra.repoId`, `extra.issue`, `extra.seq` | What the order is for. `scope = sha256("knos3:scope" || u64le(repoId) || u64le(issue))`; the order's address is the PDA of `["ord", scope, payer, u32le(seq)]`. |
| `extra.terms`, `extra.termsHash`, `extra.mode` | The acceptance terms (a JSON document), their SHA-256 (hex), and how they are judged (`0`: merge with the named checks passing). |
| `extra.workflows` | The repository and commit of the workflows whose GitHub-signed run is the acceptance. |
| `extra.fee` | The escrow's fee for `amount`, as the escrow program's build computes it at funding; paid by the client on top and returned on refund. |
| `extra.payee.githubId` | The account the acceptance must name as payee. |

## Payment payload

The client funds the order with the escrow's `FundOrderWallet` instruction (discriminator `15`), signed and submitted by the client itself. The `PaymentPayload.payload` then names the order:

```json
{
  "order": "J222WNWuZwhfgRBMc4jDu9MjGG6eCc2Up8P4FFADWVYp",
  "transaction": "4PLCWA8vhAvzNgfaBpmtMnsgy232VuqhcLEkR3hXZtN2zZXFKvDxaYbrurxFtXwrTR6Bo1VSh8p1n2kCWgoHv64Y"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `order` | yes | The address of the funded Order account. This is the proof. |
| `transaction` | no | The signature of the funding transaction. For the record only: verification reads the account, not the transaction. |

Over the HTTP transport the client sends it in the `PAYMENT-SIGNATURE` header and the server advertises requirements in `PAYMENT-REQUIRED`; see [transports-v2/http.md](../../transports-v2/http.md).

## Verification

The facilitator MUST fetch the account at `payload.order` at `confirmed` commitment or better and MUST reject unless all of the following hold:

1. `paymentPayload.accepted.scheme` and `requirements.scheme` are `knos-order`, and both name the same supported network.
2. `requirements.extra.program` is an escrow program the facilitator allows.
3. The account exists and its owner is `requirements.extra.program`.
4. The account is an Order: 512 bytes, version byte `2` at offset 0.
5. The address derived from the order's own fields, `PDA(["ord", scope, source, u32le(seq)], program)`, equals `payload.order`, and `scope` equals the scope of `extra.repoId` and `extra.issue`.
6. The order is open (state `1`).
7. The order's amount is at least `requirements.amount`, and its mint is `requirements.asset`.
8. The order's terms hash equals `extra.termsHash`, `sha256(extra.terms)` equals `extra.termsHash`, and its mode equals `extra.mode`.
9. The order pins `sha256(extra.workflows.repository)` and `extra.workflows.sha`.
10. The order is a plain one: not private, not standing, and with no holdback.
11. The order's deadline is at least `minSecondsToDeliver` (facilitator policy, default 3600) in the future.

On success `VerifyResponse.payer` is the order's `source` (the wallet that funded it).

### Order account layout (the fields read)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | version (`2`) |
| 1 | 1 | state (`1`: open) |
| 2 | 1 | mode |
| 4 | 1 | flags (`0x02` private, `0x08` standing) |
| 24 | 32 | scope |
| 56 | 4 | seq (u32 LE) |
| 60 | 2 | holdback, in basis points (u16 LE) |
| 64 | 8 | amount (u64 LE) |
| 72 | 8 | fee (u64 LE) |
| 96 | 8 | deadline, Unix seconds (i64 LE) |
| 192 | 32 | source (the funding wallet) |
| 288 | 32 | mint |
| 320 | 32 | terms hash |
| 352 | 32 | SHA-256 of the workflows' repository name |
| 384 | 40 | the workflows' commit (ASCII hex) |

## Settlement

`/settle` in this scheme moves no funds. The facilitator MUST run verification again (with `minSecondsToDeliver` of `0`: the resource has been served, so only an expired or closed order is refused) and, on success, return:

```json
{
  "success": true,
  "payer": "5WcE8o73vmsSZXeeWTLm3ty3fAJKCnBWRF6VuKUme5nu",
  "transaction": "4PLCWA8vhAvzNgfaBpmtMnsgy232VuqhcLEkR3hXZtN2zZXFKvDxaYbrurxFtXwrTR6Bo1VSh8p1n2kCWgoHv64Y",
  "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "amount": "20000000",
  "extensions": {
    "knos-order": {
      "info": {
        "order": "J222WNWuZwhfgRBMc4jDu9MjGG6eCc2Up8P4FFADWVYp",
        "state": "escrowed",
        "deadline": 1790604800
      }
    }
  }
}
```

`transaction` is `payload.transaction` when the client gave one, otherwise the empty string. `amount` is the order's amount. `extensions["knos-order"].info.state` is `escrowed`.

The seller is paid later, by the escrow program, in the transaction that carries the verified acceptance (`PayOrder`); or the client is refunded by `RefundOrder` after `deadline`. Anyone can read which happened from the chain: the order account is closed by either, and the closing transaction's log line starts with `knos3:paid` or `knos3:refunded`.

## Error Codes

| `invalidReason` / `errorReason` | Condition |
| --- | --- |
| `unsupported_scheme` | rule 1 |
| `invalid_network` | rule 1 |
| `invalid_knos_order_payload` | `payload.order` is missing or not an address |
| `invalid_knos_order_program_not_allowed` | rule 2 |
| `invalid_knos_order_not_found` | rule 3: no account (never funded, or already paid out or refunded) |
| `invalid_knos_order_wrong_owner` | rule 3 |
| `invalid_knos_order_not_an_order` | rule 4 |
| `invalid_knos_order_scope_mismatch` | rule 5 |
| `invalid_knos_order_not_open` | rule 6 |
| `invalid_knos_order_amount_too_low` | rule 7 |
| `invalid_knos_order_asset_mismatch` | rule 7 |
| `invalid_knos_order_terms_mismatch` | rule 8 |
| `invalid_knos_order_judge_mismatch` | rule 9 |
| `invalid_knos_order_not_plain` | rule 10 |
| `invalid_knos_order_deadline_too_close` | rule 11 |

## Security Considerations

- **Replay.** An order's address is derived from its scope, payer and sequence number, and the account is closed when it pays or refunds, so one order cannot be presented after it has settled. While it is open, the same order is valid proof for the same resource only (rule 5). A resource server that must not deliver twice against one open order MUST remember the orders it has delivered for.
- **Authorization scope.** The client signs one instruction that moves `amount + fee` into the order's own token account. Nothing the client signs lets the facilitator or the resource server move funds.
- **Settlement atomicity.** None between delivery and payment: see the scheme overview. Payment and the acceptance check are atomic with each other (one transaction: the verified token is read and the transfer made).
- **Trust that remains.** GitHub's token-signing key and hosted runners; the pinned workflow's code at the pinned commit; the administrators of the repository named in the terms; and the upgrade authority of the two programs.
- **Facilitator.** Holds no key for this scheme. A dishonest facilitator can only lie about what an account contains, and the resource server can read the same account.

## Appendix

- Reference client and resource server (Node, no dependency): <https://github.com/drexthealpha/Knos/tree/main/examples/x402_attested>
- The programs, their IDL and tests: <https://github.com/drexthealpha/Knos>
- The example objects in this document are the ones that reference implementation exchanges; the Order account used by the unit tests was written by the escrow program in a local validator.
