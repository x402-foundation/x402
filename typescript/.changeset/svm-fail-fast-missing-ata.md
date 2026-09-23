---
'@x402/svm': patch
---

Fail fast in the exact SVM client (v1 and v2) when the destination associated token account does not exist (#2395). Previously the payment only failed at settle time with an opaque `InstructionError: [.., InvalidAccountData]`. The client now checks the destination ATA — fetched in parallel with the blockhash, so no latency is added — requires it to exist **and** to be owned by the mint's token program (a lamport-only System account squatting the PDA would also fail TransferChecked), and throws an explicit error naming the missing/blocked ATA, the payTo owner, the mint, and the fix (the recipient self-provisions their ATA; facilitator-funded creation was rejected as a griefing vector in #1020/#2798). No instruction layout change; repeat payments are unaffected.
