<?php

declare(strict_types=1);

namespace X402\Facilitator;

use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;
use X402\Exception\FacilitatorException;
use X402\Types\PaymentPayload;
use X402\Types\PaymentRequirements;
use X402\Types\SettleResponse;
use X402\Types\SupportedResponse;
use X402\Types\VerifyResponse;
use X402\Version;

/**
 * Facilitator over HTTP.
 *
 * Settlement can take longer than a normal API call because it waits on a chain confirmation,
 * so the default timeout is deliberately generous. A client timeout during settle does not mean
 * the payment failed, only that the result is unknown, which is why a short one is dangerous.
 */
final class HttpFacilitator implements Facilitator
{
    public const EXTENSION_RESPONSES_HEADER = 'EXTENSION-RESPONSES';

    /** @var array<string, string> */
    private array $extensionResponses = [];

    /**
     * @param array<string, string> $headers sent on every call, for example an API key
     */
    public function __construct(
        private readonly ClientInterface $http,
        private readonly RequestFactoryInterface $requests,
        private readonly StreamFactoryInterface $streams,
        private readonly string $baseUrl,
        private readonly array $headers = [],
    ) {
    }

    public function verify(PaymentPayload $payload, PaymentRequirements $requirements): VerifyResponse
    {
        return VerifyResponse::fromArray($this->post('/verify', $payload, $requirements));
    }

    public function settle(PaymentPayload $payload, PaymentRequirements $requirements): SettleResponse
    {
        return SettleResponse::fromArray($this->post('/settle', $payload, $requirements));
    }

    public function supported(): SupportedResponse
    {
        return SupportedResponse::fromArray($this->get('/supported'));
    }

    /**
     * Extension outcomes from the last call. Sidechannel only, never forwarded to buyers.
     *
     * @return array<string, string>
     */
    public function lastExtensionResponses(): array
    {
        return $this->extensionResponses;
    }

    /**
     * @return array<string, mixed>
     */
    private function post(string $path, PaymentPayload $payload, PaymentRequirements $requirements): array
    {
        $body = json_encode([
            'x402Version' => Version::V2,
            'paymentPayload' => $payload->toArray(),
            'paymentRequirements' => $requirements->toArray(),
        ], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);

        $request = $this->requests->createRequest('POST', $this->url($path))
            ->withHeader('Content-Type', 'application/json')
            ->withHeader('Accept', 'application/json')
            ->withBody($this->streams->createStream($body));

        return $this->send($request, $path);
    }

    /**
     * @return array<string, mixed>
     */
    private function get(string $path): array
    {
        return $this->send(
            $this->requests->createRequest('GET', $this->url($path))->withHeader('Accept', 'application/json'),
            $path,
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function send(\Psr\Http\Message\RequestInterface $request, string $path): array
    {
        foreach ($this->headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }

        try {
            $response = $this->http->sendRequest($request);
        } catch (ClientExceptionInterface $e) {
            throw new FacilitatorException("facilitator {$path} was unreachable: " . $e->getMessage(), 0, $e);
        }

        $this->extensionResponses = [];
        $sidechannel = $response->getHeaderLine(self::EXTENSION_RESPONSES_HEADER);
        if ($sidechannel !== '') {
            $decoded = json_decode((string) base64_decode($sidechannel, true), true);
            if (is_array($decoded)) {
                foreach ($decoded as $k => $v) {
                    $this->extensionResponses[(string) $k] = is_string($v) ? $v : json_encode($v, JSON_THROW_ON_ERROR);
                }
            }
        }

        $status = $response->getStatusCode();
        $raw = (string) $response->getBody();

        if ($status >= 400) {
            throw new FacilitatorException("facilitator {$path} returned HTTP {$status}: " . substr($raw, 0, 200));
        }

        $decoded = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($decoded)) {
            throw new FacilitatorException("facilitator {$path} did not return a JSON object");
        }

        /** @var array<string, mixed> $decoded */
        return $decoded;
    }

    private function url(string $path): string
    {
        return rtrim($this->baseUrl, '/') . $path;
    }
}
