# socseal-verify

Reference client: x402-exact USDC payment -> `https://socseal.xyz` `/data/*`
(or `/verify`) -> **ML-DSA-87 signed receipt** proving the settlement MINED
on-chain. Zero-trust verification — the receipt verifies offline against the
published public key; no account, no KYC.

Prices: `/data/price` $0.09 · `/data/spike` $0.09 · `/data/nem` $0.18 ·
`/data/brief` $0.27 · `/data/market-scan` $0.45 (Polygon + Base; SOC-denominated
payment supported at 1 SOC = 10 USDC).

All tools are declared in `https://socseal.xyz/openapi.json` with x-payment-info.
