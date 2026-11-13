<?php

declare(strict_types=1);

namespace X402\Tests\Server;

use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7\Response;
use Nyholm\Psr7\ServerRequest;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use X402\Facilitator\Facilitator;
use X402\Http\Headers;
use X402\Server\PaymentMiddleware;
use X402\Types\PaymentFlow;
use X402\Types\PaymentPayload;
use X402\Types\PaymentRequirements;
use X402\Types\ResourceInfo;
use X402\Types\SettleResponse;
use X402\Types\SupportedResponse;
use X402\Types\VerifyResponse;

final class PaymentMiddlewareTest extends TestCase
{
    private const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    private const PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';

    public function testFreeRoutesPassThrough(): void
    {
        $facilitator = new FakeFacilitator();
        $response = $this->dispatch(new ServerRequest('GET', '/free'), $facilitator, priced: false);

        self::assertSame(200, $response->getStatusCode());
        self::assertSame(['handler'], $facilitator->calls, 'the facilitator must not be touched for a free route');
    }

    public function testChallengesWhenNoPaymentIsOffered(): void
    {
        $response = $this->dispatch(new ServerRequest('GET', '/paid'), new FakeFacilitator());

        self::assertSame(402, $response->getStatusCode());
        self::assertSame('no-store', $response->getHeaderLine('Cache-Control'));

        $required = Headers::decodePaymentRequired($response->getHeaderLine(Headers::PAYMENT_REQUIRED));
        self::assertSame('PAYMENT-SIGNATURE header is required', $required->error);
        self::assertSame('exact', $required->accepts[0]->scheme);
    }

    public function testAuthorizationFlowVerifiesThenSettlesAfterTheHandler(): void
    {
        $facilitator = new FakeFacilitator();
        $response = $this->dispatch($this->paidRequest(), $facilitator);

        self::assertSame(200, $response->getStatusCode());
        self::assertSame(['verify', 'handler', 'settle'], $facilitator->calls);

        $settlement = Headers::decodeSettleResponse($response->getHeaderLine(Headers::PAYMENT_RESPONSE));
        self::assertTrue($settlement->success);
    }

    public function testFailedVerificationRechallengesWithoutSettling(): void
    {
        $facilitator = new FakeFacilitator(verdict: new VerifyResponse(false, 'insufficient_funds'));
        $response = $this->dispatch($this->paidRequest(), $facilitator);

        self::assertSame(402, $response->getStatusCode());
        self::assertNotContains('settle', $facilitator->calls);

        $required = Headers::decodePaymentRequired($response->getHeaderLine(Headers::PAYMENT_REQUIRED));
        self::assertSame('insufficient_funds', $required->error);
    }

    public function testFailedSettlementRechallengesAndReportsWhy(): void
    {
        $facilitator = new FakeFacilitator(settlement: new SettleResponse(false, '', 'eip155:84532', 'insufficient_funds'));
        $response = $this->dispatch($this->paidRequest(), $facilitator);

        self::assertSame(402, $response->getStatusCode());
        self::assertSame('insufficient_funds', Headers::decodeSettleResponse($response->getHeaderLine(Headers::PAYMENT_RESPONSE))->errorReason);
    }

    /**
     * settlement_pending is not a failure. The transaction may still confirm, so the resource
     * is released and the hash handed back for reconciliation.
     */
    public function testPendingSettlementStillReleasesTheResource(): void
    {
        $facilitator = new FakeFacilitator(
            settlement: new SettleResponse(false, '0xabc', 'eip155:84532', SettleResponse::SETTLEMENT_PENDING),
        );
        $response = $this->dispatch($this->paidRequest(), $facilitator);

        self::assertSame(200, $response->getStatusCode());
        self::assertTrue(Headers::decodeSettleResponse($response->getHeaderLine(Headers::PAYMENT_RESPONSE))->isPending());
    }

    public function testUpfrontFlowSettlesBeforeTheHandlerAndSkipsVerify(): void
    {
        $facilitator = new FakeFacilitator();
        $response = $this->dispatch($this->paidRequest(PaymentFlow::UPFRONT), $facilitator, flow: PaymentFlow::UPFRONT);

        self::assertSame(200, $response->getStatusCode());
        self::assertSame(['settle', 'handler'], $facilitator->calls);
    }

    public function testEscrowFlowIsRefusedRatherThanMishandled(): void
    {
        $response = $this->dispatch($this->paidRequest(PaymentFlow::ESCROW), new FakeFacilitator(), flow: PaymentFlow::ESCROW);

        self::assertSame(402, $response->getStatusCode());
        self::assertStringContainsString('escrow', Headers::decodePaymentRequired($response->getHeaderLine(Headers::PAYMENT_REQUIRED))->error ?? '');
    }

    public function testAFailingHandlerIsNotSettled(): void
    {
        $facilitator = new FakeFacilitator();
        $response = $this->dispatch($this->paidRequest(), $facilitator, handlerStatus: 500);

        self::assertSame(500, $response->getStatusCode());
        self::assertSame(['verify', 'handler'], $facilitator->calls);
        self::assertFalse($response->hasHeader(Headers::PAYMENT_RESPONSE));
    }

    public function testAPaymentForAnotherRequirementIsRejected(): void
    {
        $other = new PaymentRequirements('exact', 'eip155:84532', '999999', self::ASSET, self::PAY_TO, 60);
        $payment = new PaymentPayload($other, ['signature' => '0xab']);
        $request = (new ServerRequest('GET', '/paid'))
            ->withHeader(Headers::PAYMENT_SIGNATURE, Headers::encodePaymentPayload($payment));

        $response = $this->dispatch($request, new FakeFacilitator());

        self::assertSame(402, $response->getStatusCode());
    }

    private function paidRequest(string $flow = PaymentFlow::AUTHORIZATION): ServerRequestInterface
    {
        $payment = new PaymentPayload(self::requirements($flow), ['signature' => '0xab']);

        return (new ServerRequest('GET', '/paid'))
            ->withHeader(Headers::PAYMENT_SIGNATURE, Headers::encodePaymentPayload($payment));
    }

    private function dispatch(
        ServerRequestInterface $request,
        FakeFacilitator $facilitator,
        bool $priced = true,
        string $flow = PaymentFlow::AUTHORIZATION,
        int $handlerStatus = 200,
    ): ResponseInterface {
        $factory = new Psr17Factory();

        $middleware = new PaymentMiddleware(
            $facilitator,
            $factory,
            static fn (ServerRequestInterface $r): ?array => $priced
                ? [new ResourceInfo('https://api.example.com/paid'), [self::requirements($flow)]]
                : null,
        );

        $handler = new class($facilitator, $handlerStatus) implements RequestHandlerInterface {
            public function __construct(private FakeFacilitator $facilitator, private int $status)
            {
            }

            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->facilitator->calls[] = 'handler';

                return new Response($this->status);
            }
        };

        return $middleware->process($request, $handler);
    }

    private static function requirements(string $flow = PaymentFlow::AUTHORIZATION): PaymentRequirements
    {
        $extra = ['name' => 'USDC', 'version' => '2'];
        if ($flow !== PaymentFlow::AUTHORIZATION) {
            $extra['paymentFlow'] = $flow;
        }

        return new PaymentRequirements('exact', 'eip155:84532', '10000', self::ASSET, self::PAY_TO, 60, $extra);
    }
}

final class FakeFacilitator implements Facilitator
{
    /** @var list<string> */
    public array $calls = [];

    public function __construct(
        private readonly ?VerifyResponse $verdict = null,
        private readonly ?SettleResponse $settlement = null,
    ) {
    }

    public function verify(PaymentPayload $payload, PaymentRequirements $requirements): VerifyResponse
    {
        $this->calls[] = 'verify';

        return $this->verdict ?? new VerifyResponse(true, payer: '0x857b06519E91e3A54538791bDbb0E22373e36b66');
    }

    public function settle(PaymentPayload $payload, PaymentRequirements $requirements): SettleResponse
    {
        $this->calls[] = 'settle';

        return $this->settlement ?? new SettleResponse(true, '0xfeed', 'eip155:84532');
    }

    public function supported(): SupportedResponse
    {
        return new SupportedResponse([['x402Version' => 2, 'scheme' => 'exact', 'network' => 'eip155:84532']]);
    }
}
