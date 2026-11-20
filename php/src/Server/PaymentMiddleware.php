<?php

declare(strict_types=1);

namespace X402\Server;

use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use X402\Exception\X402Exception;
use X402\Facilitator\Facilitator;
use X402\Http\Headers;
use X402\Types\PaymentFlow;
use X402\Types\PaymentPayload;
use X402\Types\PaymentRequired;
use X402\Types\PaymentRequirements;
use X402\Types\ResourceInfo;
use X402\Types\SettleResponse;

/**
 * Gates a route behind payment.
 *
 * The priced callable returns the requirements for this request, or null to let it through free.
 * On success the PaymentPayload and SettleResponse are attached as request attributes.
 */
final class PaymentMiddleware implements MiddlewareInterface
{
    public const ATTR_PAYMENT = 'x402.payment';
    public const ATTR_SETTLEMENT = 'x402.settlement';

    /**
     * @param callable(ServerRequestInterface): ?array{0: ResourceInfo, 1: list<PaymentRequirements>} $priced
     */
    public function __construct(
        private readonly Facilitator $facilitator,
        private readonly ResponseFactoryInterface $responses,
        private $priced,
    ) {
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $priced = ($this->priced)($request);
        if ($priced === null) {
            return $handler->handle($request);
        }

        [$resource, $accepts] = $priced;

        $offered = $request->getHeaderLine(Headers::PAYMENT_SIGNATURE);
        if ($offered === '') {
            return $this->challenge($resource, $accepts, 'PAYMENT-SIGNATURE header is required');
        }

        try {
            $payment = Headers::decodePaymentPayload($offered);
            $requirements = $this->match($payment, $accepts);
        } catch (X402Exception $e) {
            return $this->challenge($resource, $accepts, $e->getMessage());
        }

        $flow = $requirements->paymentFlow();
        if ($flow === PaymentFlow::ESCROW) {
            return $this->challenge($resource, $accepts, 'escrow flow is not supported by this server');
        }

        // authorization verifies first and settles after the handler. upfront settles first and
        // skips verify entirely, because the settle is the check.
        if ($flow === PaymentFlow::AUTHORIZATION) {
            $verdict = $this->facilitator->verify($payment, $requirements);
            if (!$verdict->isValid) {
                return $this->challenge($resource, $accepts, $verdict->invalidReason ?? 'payment is not valid');
            }

            $response = $handler->handle($this->attach($request, $payment, null));
            if (!self::isSuccess($response)) {
                return $response;
            }

            $settlement = $this->facilitator->settle($payment, $requirements);

            return $settlement->success || $settlement->isPending()
                ? $response->withHeader(Headers::PAYMENT_RESPONSE, Headers::encodeSettleResponse($settlement))
                : $this->settlementFailed($resource, $accepts, $settlement);
        }

        $settlement = $this->facilitator->settle($payment, $requirements);
        if (!$settlement->success && !$settlement->isPending()) {
            return $this->settlementFailed($resource, $accepts, $settlement);
        }

        $response = $handler->handle($this->attach($request, $payment, $settlement));

        return self::isSuccess($response)
            ? $response->withHeader(Headers::PAYMENT_RESPONSE, Headers::encodeSettleResponse($settlement))
            : $response;
    }

    /**
     * @param list<PaymentRequirements> $accepts
     */
    private function match(PaymentPayload $payment, array $accepts): PaymentRequirements
    {
        foreach ($accepts as $requirement) {
            if ($payment->accepted->scheme === $requirement->scheme
                && $payment->accepted->network === $requirement->network
                && $payment->accepted->amount === $requirement->amount
                && $payment->accepted->asset === $requirement->asset
                && $payment->accepted->payTo === $requirement->payTo
            ) {
                return $requirement;
            }
        }

        throw new \X402\Exception\ParseException('accepted does not match any offered requirement');
    }

    /**
     * @param list<PaymentRequirements> $accepts
     */
    private function challenge(ResourceInfo $resource, array $accepts, string $error): ResponseInterface
    {
        $required = new PaymentRequired($resource, $accepts, $error);

        return $this->responses->createResponse(402)
            ->withHeader(Headers::PAYMENT_REQUIRED, Headers::encodePaymentRequired($required))
            ->withHeader('Cache-Control', 'no-store');
    }

    /**
     * @param list<PaymentRequirements> $accepts
     */
    private function settlementFailed(ResourceInfo $resource, array $accepts, SettleResponse $settlement): ResponseInterface
    {
        return $this->challenge($resource, $accepts, $settlement->errorReason ?? 'settlement failed')
            ->withHeader(Headers::PAYMENT_RESPONSE, Headers::encodeSettleResponse($settlement));
    }

    private function attach(ServerRequestInterface $request, PaymentPayload $payment, ?SettleResponse $settlement): ServerRequestInterface
    {
        $request = $request->withAttribute(self::ATTR_PAYMENT, $payment);

        return $settlement === null ? $request : $request->withAttribute(self::ATTR_SETTLEMENT, $settlement);
    }

    private static function isSuccess(ResponseInterface $response): bool
    {
        $status = $response->getStatusCode();

        return $status >= 200 && $status < 300;
    }
}
