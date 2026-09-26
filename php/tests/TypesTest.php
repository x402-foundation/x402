<?php

declare(strict_types=1);

namespace X402\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use X402\Exception\ParseException;
use X402\Types\PaymentFlow;
use X402\Types\PaymentRequired;
use X402\Types\PaymentRequirements;
use X402\Types\ResourceInfo;
use X402\Types\SettleResponse;
use X402\Types\SupportedResponse;
use X402\Types\VerifyResponse;

final class TypesTest extends TestCase
{
    private const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    private const PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';

    public function testPaymentRequirementsRoundTrip(): void
    {
        $requirements = self::requirements();

        self::assertEquals($requirements, PaymentRequirements::fromArray($requirements->toArray()));
    }

    #[DataProvider('badNetworks')]
    public function testRejectsNonCaip2Networks(string $network): void
    {
        $this->expectException(ParseException::class);
        new PaymentRequirements('exact', $network, '1', self::ASSET, self::PAY_TO, 60);
    }

    /** @return iterable<string, array{string}> */
    public static function badNetworks(): iterable
    {
        yield 'bare name' => ['base'];
        yield 'no reference' => ['eip155:'];
        yield 'uppercase namespace' => ['EIP155:1'];
        yield 'empty' => [''];
    }

    public function testRejectsNonAtomicAmount(): void
    {
        $this->expectException(ParseException::class);
        new PaymentRequirements('exact', 'eip155:8453', '1.50', self::ASSET, self::PAY_TO, 60);
    }

    public function testRejectsNonPositiveTimeout(): void
    {
        $this->expectException(ParseException::class);
        new PaymentRequirements('exact', 'eip155:8453', '1', self::ASSET, self::PAY_TO, 0);
    }

    public function testPaymentFlowDefaultsToAuthorization(): void
    {
        self::assertSame(PaymentFlow::AUTHORIZATION, self::requirements()->paymentFlow());
        self::assertFalse(PaymentFlow::settlesBeforeHandler(PaymentFlow::AUTHORIZATION));
        self::assertTrue(PaymentFlow::settlesBeforeHandler(PaymentFlow::UPFRONT));
        self::assertTrue(PaymentFlow::settlesBeforeHandler(PaymentFlow::ESCROW));
    }

    /**
     * Bazaar drops resources that exceed these, silently, so they are enforced here instead.
     */
    public function testResourceDiscoveryLimits(): void
    {
        $cases = [
            fn () => new ResourceInfo(''),
            fn () => new ResourceInfo('https://x', serviceName: str_repeat('a', 33)),
            fn () => new ResourceInfo('https://x', serviceName: 'caf' . "\u{00e9}"),
            fn () => new ResourceInfo('https://x', tags: ['a', 'b', 'c', 'd', 'e', 'f']),
            fn () => new ResourceInfo('https://x', tags: [str_repeat('t', 33)]),
            fn () => new ResourceInfo('https://x', iconUrl: '/relative.png'),
            fn () => new ResourceInfo('https://x', iconUrl: 'https://x/' . str_repeat('a', 2048)),
        ];

        foreach ($cases as $i => $case) {
            try {
                $case();
                self::fail("case {$i} should have been rejected");
            } catch (ParseException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function testPaymentRequiredNeedsAtLeastOneRequirement(): void
    {
        $this->expectException(ParseException::class);
        new PaymentRequired(new ResourceInfo('https://x'), []);
    }

    public function testRejectsUnsupportedProtocolVersion(): void
    {
        $this->expectException(ParseException::class);
        PaymentRequired::fromArray([
            'x402Version' => 1,
            'resource' => ['url' => 'https://x'],
            'accepts' => [self::requirements()->toArray()],
        ]);
    }

    public function testSelectUsesCallerPreferenceNotServerOrder(): void
    {
        $required = new PaymentRequired(new ResourceInfo('https://x'), [
            new PaymentRequirements('upto', 'eip155:8453', '1', self::ASSET, self::PAY_TO, 60),
            self::requirements(),
        ]);

        self::assertSame('exact', $required->select(['exact', 'upto'])?->scheme);
        self::assertSame('upto', $required->select(['upto', 'exact'])?->scheme);
        self::assertNull($required->select(['exact'], ['solana:abc']));
        self::assertNull($required->select(['batch-settlement']));
    }

    public function testSettlementPendingMustCarryATransactionHash(): void
    {
        $this->expectException(ParseException::class);
        new SettleResponse(false, '', 'eip155:1', SettleResponse::SETTLEMENT_PENDING);
    }

    public function testSettlementPendingIsNotTerminal(): void
    {
        $pending = new SettleResponse(false, '0xabc', 'eip155:1', SettleResponse::SETTLEMENT_PENDING);

        self::assertTrue($pending->isPending());
        self::assertFalse($pending->success);
    }

    public function testVerifyResponseOmitsEmptyOptionals(): void
    {
        self::assertSame(['isValid' => true], (new VerifyResponse(true))->toArray());
        self::assertSame(
            ['isValid' => false, 'invalidReason' => 'insufficient_funds'],
            VerifyResponse::fromArray(['isValid' => false, 'invalidReason' => 'insufficient_funds'])->toArray(),
        );
    }

    public function testSupportedResponse(): void
    {
        $supported = SupportedResponse::fromArray([
            'kinds' => [
                ['x402Version' => 2, 'scheme' => 'exact', 'network' => 'eip155:84532'],
                ['scheme' => 'exact', 'network' => 'eip155:8453'],
            ],
            'extensions' => [],
            'signers' => ['eip155:*' => ['0x1234567890abcdef1234567890abcdef12345678']],
        ]);

        self::assertTrue($supported->supports('exact', 'eip155:8453'));
        self::assertFalse($supported->supports('exact', 'solana:abc'));
        self::assertSame(2, $supported->kinds[1]['x402Version']);
    }

    private static function requirements(): PaymentRequirements
    {
        return new PaymentRequirements(
            'exact',
            'eip155:84532',
            '10000',
            self::ASSET,
            self::PAY_TO,
            60,
            ['name' => 'USDC', 'version' => '2'],
        );
    }
}
