# Basic client

Calls a paid endpoint and lets `PaymentClient` answer the 402.

```bash
composer install
php pay.php http://127.0.0.1:8080/premium
```

## About the signer

`Signer` is where your keys live, so this example ships a stub that throws. The SDK will not
sign for you: EIP-3009 needs an EIP-712 struct hash signed with secp256k1, which means a
keystore and a curve library, neither of which belongs in a protocol package.

To make this actually pay, implement `sign()` with something like `simplito/elliptic-php` or
`kornrunner/secp256k1`, returning:

```php
[
    'signature' => '0x...',            // 65 bytes
    'authorization' => [
        'from' => '0x...',             // your address
        'to' => $requirements->payTo,
        'value' => $requirements->amount,
        'validAfter' => (string) (time() - 60),
        'validBefore' => (string) (time() + $requirements->maxTimeoutSeconds),
        'nonce' => '0x' . bin2hex(random_bytes(32)),
    ],
]
```

The EIP-712 domain comes from `extra.name` and `extra.version` on the requirement, with
`chainId` taken from the CAIP-2 network and `verifyingContract` set to `asset`.

Run it without a real signer and you will see the 402 and the decoded requirements, which is
enough to check that discovery and selection work.
