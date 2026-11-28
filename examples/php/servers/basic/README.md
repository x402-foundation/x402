# Basic server

Gates `/premium` behind a payment and leaves `/` free.

```bash
composer install
X402_PAY_TO=0xYourWallet \
X402_FACILITATOR=https://your-facilitator.example.com \
php -S 127.0.0.1:8080 index.php
```

```bash
curl -i http://127.0.0.1:8080/premium     # 402 with a PAYMENT-REQUIRED header
curl -i http://127.0.0.1:8080/            # 200, free
```

Decode the challenge to see what it is asking for:

```bash
curl -si http://127.0.0.1:8080/premium | grep -i '^payment-required:' \
  | cut -d' ' -f2 | base64 -d | jq
```

Set `X402_NETWORK` and `X402_ASSET` to move off Base Sepolia. The defaults are testnet USDC.
