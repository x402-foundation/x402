<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7Server\ServerRequestCreator;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Symfony\Component\HttpClient\Psr18Client;
use X402\Facilitator\HttpFacilitator;
use X402\Server\PaymentMiddleware;
use X402\Types\PaymentRequirements;
use X402\Types\ResourceInfo;

$factory = new Psr17Factory();
$http = new Psr18Client();

$payTo = getenv('X402_PAY_TO') ?: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
$network = getenv('X402_NETWORK') ?: 'eip155:84532';
$asset = getenv('X402_ASSET') ?: '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

$facilitator = new HttpFacilitator(
    $http,
    $factory,
    $factory,
    getenv('X402_FACILITATOR') ?: 'https://facilitator.example.com',
);

$middleware = new PaymentMiddleware(
    $facilitator,
    $factory,
    static function (ServerRequestInterface $request) use ($payTo, $network, $asset): ?array {
        if ($request->getUri()->getPath() !== '/premium') {
            return null;
        }

        return [
            new ResourceInfo(
                url: (string) $request->getUri(),
                description: 'Premium market data',
                mimeType: 'application/json',
                serviceName: 'Example Market Data',
                tags: ['market-data', 'finance'],
            ),
            [new PaymentRequirements(
                scheme: 'exact',
                network: $network,
                amount: '10000',
                asset: $asset,
                payTo: $payTo,
                maxTimeoutSeconds: 60,
                extra: ['name' => 'USDC', 'version' => '2'],
            )],
        ];
    },
);

$handler = new class($factory) implements RequestHandlerInterface {
    public function __construct(private Psr17Factory $factory)
    {
    }

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        $payment = $request->getAttribute(PaymentMiddleware::ATTR_PAYMENT);

        $body = $payment === null
            ? ['message' => 'this endpoint is free']
            : ['data' => [42, 43, 44], 'paidBy' => $payment->payload['authorization']['from'] ?? null];

        $response = $this->factory->createResponse(200)->withHeader('Content-Type', 'application/json');
        $response->getBody()->write(json_encode($body, JSON_THROW_ON_ERROR));

        return $response;
    }
};

$creator = new ServerRequestCreator($factory, $factory, $factory, $factory);
$response = $middleware->process($creator->fromGlobals(), $handler);

http_response_code($response->getStatusCode());
foreach ($response->getHeaders() as $name => $values) {
    foreach ($values as $value) {
        header("{$name}: {$value}", false);
    }
}
echo $response->getBody();
