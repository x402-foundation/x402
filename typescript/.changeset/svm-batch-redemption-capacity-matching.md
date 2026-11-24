---
"@x402/svm": patch
---

SVM batch-settlement leaves `extra.maxClaimChannels` and `extra.maxSettleChannels` out of requirements matching, as it already does `recentBlockhash` and `recentSlot`. The server copies the two fields from the facilitator's `/supported` kind. They size only the server's own claim and settle batches: no message the payer signs includes them, and the facilitator checks requests against its own capacity. Previously, when a facilitator changed the capacity it advertised, a server running several processes refused a batch payment whose 402 came from a process holding the other value. The resource server answered "No matching payment requirements", and the facilitator's `/verify` answered `invalid_payment_requirements`, until every process had read `/supported` again. Both checks now ignore the two fields.
