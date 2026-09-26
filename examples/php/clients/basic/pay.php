<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Nyholm\Psr7\Factory\Psr17Factory;
use Symfony\Component\HttpClient\Psr18Client;
use X402\Client\PaymentClient;
use X402\Client\Signer;
use X402\Exception\ClientException;
use X402\Http\Headers;
use X402\Types\PaymentRequirements;
use X402\Types\ResourceInfo;

$url = $argv[1] ?? 'http://127.0.0.1:8080/premium';

/**
 * Replace this with a real implementation. See the README.
 */
final class UnimplementedSigner implements Signer
{
    public function schemes(): array
    {
        return ['exact'];
    }

    public function networks(): array
    {
        return [];
    }

    public function sign(PaymentRequirements $requirements, ?ResourceInfo $resource): array
    {
        throw new ClientException(sprintf(
            'no signer configured: this example cannot sign %s on %s for %s of %s',
            $requirements->scheme,
            $requirements->network,
            $requirements->amount,
            $requirements->asset,
        ));
    }
}

$inner = new Psr18Client();
$factory = new Psr17Factory();
$client = new PaymentClient($inner, new UnimplementedSigner());

try {
    $response = $client->sendRequest($factory->createRequest('GET', $url));

    echo "HTTP {$response->getStatusCode()}\n";
    echo $response->getBody(), "\n";

    $settlement = $client->settlementFrom($response);
    if ($settlement !== null) {
        echo "settled: {$settlement->transaction} on {$settlement->network}\n";
    }
} catch (ClientException $e) {
    // Show what the server asked for even though we cannot pay it.
    $probe = $inner->sendRequest($factory->createRequest('GET', $url));
    $header = $probe->getHeaderLine(Headers::PAYMENT_REQUIRED);

    echo "could not pay: {$e->getMessage()}\n\n";

    if ($header !== '') {
        $required = Headers::decodePaymentRequired($header);
        echo "the server accepts:\n";
        foreach ($required->accepts as $requirement) {
            printf(
                "  %s on %s, %s of %s to %s\n",
                $requirement->scheme,
                $requirement->network,
                $requirement->amount,
                $requirement->asset,
                $requirement->payTo,
            );
        }
    }

    exit(1);
}
