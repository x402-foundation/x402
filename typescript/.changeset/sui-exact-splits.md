---
"@x402/sui": minor
---

Add multi-payee splits to the Sui `exact` scheme. The facilitator accepts up to `maxSplits` (0 to 8, off by default) and advertises it in `/supported`, and checks that each recipient nets exactly its share. The server refuses splits the facilitator does not advertise. The client sends one `balance::send_funds` per recipient and refuses splits unless `approveSplits` consents.
