---
"@x402/svm": minor
---

Add `auth-capture` scheme support for SVM (Solana Virtual Machine) chains. The client builds an SPL Token `Approve` instruction delegating up to `requirements.amount` from the payer's ATA to the facilitator's delegate authority (`extra.delegate`). The facilitator verifies the hold statically and can settle `capture` (TransferChecked via delegate signature), `void` (Revoke), and `refund` (TransferChecked back to payer) with post-settlement TOCTOU verification. Includes `getExtra`/`getSigners` for facilitator registration and full error code coverage (`invalid_auth_capture_svm_*`).
