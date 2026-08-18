---
"@x402/core": minor
"@x402/evm": minor
"@x402/svm": minor
"@x402/avm": minor
"@x402/tvm": minor
"@x402/near": minor
"@x402/hedera": minor
"@x402/aptos": minor
"@x402/stellar": minor
"@x402/keeta": minor
"@x402/xrpl": minor
"@x402/concordium": minor
---

Keep public `Money` as `string | number`, but parse and convert internally as decimal strings only. `parseMoney` / `parseMoneyString` return the extracted decimal substring; `MoneyParser` amount is `string | number` (`parsePrice` always passes a string). `convertToTokenAmount` pads/truncates toward zero including to `"0"` instead of throwing on dust.
