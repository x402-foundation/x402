<?php

declare(strict_types=1);

namespace X402\Tests\Mechanisms\Evm;

use PHPUnit\Framework\TestCase;
use X402\Exception\ParseException;
use X402\Mechanisms\Evm\Authorization;
use X402\Mechanisms\Evm\ExactEvm;
use X402\Types\PaymentPayload;
use X402\Types\PaymentRequirements;

final class ExactEvmTest extends TestCase
{
    private const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    private const PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
    private const FROM = '0x857b06519E91e3A54538791bDbb0E22373e36b66';
    private const SIGNATURE = '0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c';
    private const NONCE = '0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480';

    public function testHandlesExactEip3009OnEvm(): void
    {
        self::assertTrue(ExactEvm::handles(self::requirements()));
        self::assertTrue(ExactEvm::handles(self::requirements(['assetTransferMethod' => 'eip3009'])));
        self::assertFalse(ExactEvm::handles(self::requirements(['assetTransferMethod' => 'permit2'])));
        self::assertFalse(ExactEvm::handles(new PaymentRequirements('exact', 'solana:abc', '1', self::ASSET, self::PAY_TO, 60)));
        self::assertFalse(ExactEvm::handles(new PaymentRequirements('upto', 'eip155:8453', '1', self::ASSET, self::PAY_TO, 60)));
    }

    /**
     * The EIP-712 domain is needed to rebuild the signed message, so a requirement without it
     * cannot be paid at all.
     */
    public function testRequiresTheEip712Domain(): void
    {
        $this->expectException(ParseException::class);
        ExactEvm::assertRequirements(new PaymentRequirements('exact', 'eip155:8453', '1', self::ASSET, self::PAY_TO, 60));
    }

    public function testParsesTheSpecPayload(): void
    {
        $parsed = ExactEvm::parsePayload(self::payload());

        self::assertSame(self::SIGNATURE, $parsed->signature);
        self::assertSame(self::FROM, $parsed->authorization->from);
        self::assertSame('10000', $parsed->authorization->value);
    }

    public function testRejectsAShortSignature(): void
    {
        $this->expectException(ParseException::class);
        ExactEvm::parsePayload(['signature' => '0xdeadbeef', 'authorization' => self::authorization()]);
    }

    public function testAcceptsAMatchingPayment(): void
    {
        $this->expectNotToPerformAssertions();

        ExactEvm::assertPayloadMatches(
            new PaymentPayload(self::requirements(), self::payload()),
            self::requirements(),
            now: 1740672100,
        );
    }

    public function testRejectsAnAmountThatDoesNotEqualTheRequirement(): void
    {
        $payload = self::payload(['value' => '9999']);

        $this->expectException(ParseException::class);
        ExactEvm::assertPayloadMatches(new PaymentPayload(self::requirements(), $payload), self::requirements(), now: 1740672100);
    }

    public function testRejectsPaymentToTheWrongRecipient(): void
    {
        $payload = self::payload(['to' => '0x1111111111111111111111111111111111111111']);

        $this->expectException(ParseException::class);
        ExactEvm::assertPayloadMatches(new PaymentPayload(self::requirements(), $payload), self::requirements(), now: 1740672100);
    }

    public function testRejectsAnExpiredAuthorization(): void
    {
        $this->expectException(ParseException::class);
        ExactEvm::assertPayloadMatches(
            new PaymentPayload(self::requirements(), self::payload()),
            self::requirements(),
            now: 1740672200,
        );
    }

    public function testRejectsAnAuthorizationThatIsNotYetValid(): void
    {
        $this->expectException(ParseException::class);
        ExactEvm::assertPayloadMatches(
            new PaymentPayload(self::requirements(), self::payload()),
            self::requirements(),
            now: 1740672000,
        );
    }

    public function testValidityWindowMustBeOrdered(): void
    {
        $this->expectException(ParseException::class);
        new Authorization(self::FROM, self::PAY_TO, '1', '200', '100', self::NONCE);
    }

    public function testNonceMustBe32Bytes(): void
    {
        $this->expectException(ParseException::class);
        new Authorization(self::FROM, self::PAY_TO, '1', '1', '2', '0xdead');
    }

    /**
     * Timestamps and values are strings because they are uint256 on chain.
     */
    public function testHandlesValuesBeyondPhpIntMax(): void
    {
        $huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
        $authorization = new Authorization(self::FROM, self::PAY_TO, $huge, '1', $huge, self::NONCE);

        self::assertSame($huge, $authorization->value);
        self::assertTrue($authorization->isActive(1740672100));
    }

    /**
     * @param array<string, string> $extra
     */
    private static function requirements(array $extra = []): PaymentRequirements
    {
        return new PaymentRequirements(
            'exact',
            'eip155:84532',
            '10000',
            self::ASSET,
            self::PAY_TO,
            60,
            $extra === [] ? ['name' => 'USDC', 'version' => '2'] : $extra + ['name' => 'USDC', 'version' => '2'],
        );
    }

    /**
     * @param array<string, string> $overrides
     *
     * @return array<string, string>
     */
    private static function authorization(array $overrides = []): array
    {
        return $overrides + [
            'from' => self::FROM,
            'to' => self::PAY_TO,
            'value' => '10000',
            'validAfter' => '1740672089',
            'validBefore' => '1740672154',
            'nonce' => self::NONCE,
        ];
    }

    /**
     * @param array<string, string> $overrides
     *
     * @return array<string, mixed>
     */
    private static function payload(array $overrides = []): array
    {
        return ['signature' => self::SIGNATURE, 'authorization' => self::authorization($overrides)];
    }
}
