# Solana batch client

Set `SVM_PRIVATE_KEY` (base58 keypair), `RESOURCE_URL` (a batch-enabled route),
and optionally `SVM_RPC_URL` and `NUMBER_OF_REQUESTS` (default 3). The first
request deposits tokens; following requests use the same channel.

```sh
uv run python main.py
```

For operator-signed metering, set `TRUSTED_OPERATOR` to an independently verified
operator public key. This grants authority over the escrow, capped at $1 in this
example. Each request is capped at $0.10. The example uses memory storage; see
[the SDK guide](../../../../python/x402/mechanisms/svm/batch_settlement/README.md)
for persistent adapters, refunds, and server/facilitator setup.
