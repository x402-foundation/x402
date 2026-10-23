# x402 PHP

PHP implementation of the [x402](https://x402.org) payment protocol, v2.

No framework dependency. PSR-7 messages, PSR-15 middleware for sellers, PSR-18 client for buyers.

```
GET /premium-data
  <- 402  PAYMENT-REQUIRED: <base64 PaymentRequired>
GET /premium-data  PAYMENT-SIGNATURE: <base64 PaymentPayload>
  -> 200  PAYMENT-RESPONSE: <base64 SettleResponse>
```

Requires PHP 8.2+.

## Selling

`PaymentMiddleware` gates a route. The priced callable returns the resource and what you will
accept for it, or `null` to let the request through free.

```php
use X402\Facilitator\HttpFacilitator;
use X402\Server\PaymentMiddleware;
use X402\Types\PaymentRequirements;
use X402\Types\ResourceInfo;

$facilitator = new HttpFacilitator($httpClient, $requestFactory, $streamFactory, 'https://facilitator.example.com');

$middleware = new PaymentMiddleware($facilitator, $responseFactory, function ($request) {
    if (!str_starts_with($request->getUri()->getPath(), '/premium/')) {
        return null;
    }

    return [
        new ResourceInfo('https://api.example.com/premium-data', 'Access to premium market data'),
        [new PaymentRequirements(
            scheme: 'exact',
            network: 'eip155:84532',
            amount: '10000',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
            maxTimeoutSeconds: 60,
            extra: ['name' => 'USDC', 'version' => '2'],
        )],
    ];
});
```

The verified `PaymentPayload` and `SettleResponse` are attached to the request as `x402.payment`
and `x402.settlement`.

Payment flow follows `extra.paymentFlow`. `authorization` (the default) verifies, runs the
handler, then settles. `upfront` settles first and skips verification, since the settle is the
check. A handler that returns a non-2xx is never settled. `escrow` needs durable per-payment
state and is refused rather than half-implemented.

## Buying

`PaymentClient` wraps any PSR-18 client and answers 402s. Signing stays with you.

```php
use X402\Client\PaymentClient;

$http = new PaymentClient($yourPsr18Client, $yourSigner);
$response = $http->sendRequest($request);
$settlement = $http->settlementFrom($response);
```

Implement `Signer` to produce the scheme payload. The SDK deliberately does not hold keys or
speak to a node.

## Facilitator

`HttpFacilitator` implements `POST /verify`, `POST /settle` and `GET /supported`, and exposes the
`EXTENSION-RESPONSES` sidechannel through `lastExtensionResponses()`. Swap in your own
`Facilitator` to self-facilitate.

## Scheme support

`exact` on EVM via EIP-3009. `ExactEvm` checks offline everything that can be checked offline:
that `accepted` matches the requirement, that the authorization pays the right recipient the
right amount, and that it is inside its validity window. Signature recovery, balances and
simulation belong to the facilitator.

Amounts, `validAfter` and `validBefore` are handled as strings throughout because they are
uint256 on chain and would lose precision as PHP integers.

## Development

```bash
composer install
composer test
composer stan
```

## License

Apache-2.0
