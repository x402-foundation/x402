---
"@x402/svm": minor
---

Allow injecting a pre-built RPC client into the SVM `upto` facilitator (`UptoSvmFacilitatorConfig.rpc`, and the rent cleanup manager's config). When provided it is preferred over constructing a client from `rpcUrl`, letting facilitators route channel claim/cleanup sends through their own paced or instrumented transport (e.g. to respect a provider's sendTransaction rate limit).
