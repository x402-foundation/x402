<?php

declare(strict_types=1);

namespace X402\Client;

use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use X402\Exception\ClientException;
use X402\Http\Headers;
use X402\Types\PaymentPayload;
use X402\Types\PaymentRequired;
use X402\Types\SettleResponse;

/**
 * PSR-18 decorator that answers 402s.
 */
final class PaymentClient implements ClientInterface
{
    public function __construct(
        private readonly ClientInterface $inner,
        private readonly Signer $signer,
        private readonly int $maxPayments = 3,
    ) {
    }

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $response = $this->inner->sendRequest($request);

        // A server can re-challenge with a fresh nonce or a changed price, so keep answering
        // until it stops asking or the ceiling is hit.
        for ($attempt = 0; $attempt < $this->maxPayments; ++$attempt) {
            if ($response->getStatusCode() !== 402) {
                return $response;
            }

            $header = $response->getHeaderLine(Headers::PAYMENT_REQUIRED);
            if ($header === '') {
                throw new ClientException('402 carried no PAYMENT-REQUIRED header');
            }

            $required = Headers::decodePaymentRequired($header);
            $requirements = $required->select($this->signer->schemes(), $this->signer->networks());
            if ($requirements === null) {
                throw new ClientException('no offered payment requirement is supported by this signer');
            }

            $payment = new PaymentPayload(
                accepted: $requirements,
                payload: $this->signer->sign($requirements, $required->resource),
                resource: $required->resource,
                extensions: $required->extensions,
            );

            $request = $request->withHeader(Headers::PAYMENT_SIGNATURE, Headers::encodePaymentPayload($payment));
            $response = $this->inner->sendRequest($request);
        }

        if ($response->getStatusCode() === 402) {
            throw new ClientException("server still requires payment after {$this->maxPayments} attempts");
        }

        return $response;
    }

    public function settlementFrom(ResponseInterface $response): ?SettleResponse
    {
        $header = $response->getHeaderLine(Headers::PAYMENT_RESPONSE);

        return $header === '' ? null : Headers::decodeSettleResponse($header);
    }
}
