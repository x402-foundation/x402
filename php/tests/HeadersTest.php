<?php

declare(strict_types=1);

namespace X402\Tests;

use PHPUnit\Framework\TestCase;
use X402\Exception\ParseException;
use X402\Http\Headers;

final class HeadersTest extends TestCase
{
    public function testDecodesThePaymentRequiredVector(): void
    {
        $required = Headers::decodePaymentRequired(SpecVectors::PAYMENT_REQUIRED);

        self::assertSame(2, $required->x402Version);
        self::assertSame('PAYMENT-SIGNATURE header is required', $required->error);
        self::assertSame('https://api.example.com/premium-data', $required->resource->url);
        self::assertCount(1, $required->accepts);
        self::assertSame('exact', $required->accepts[0]->scheme);
        self::assertSame('eip155:84532', $required->accepts[0]->network);
        self::assertSame('10000', $required->accepts[0]->amount);
        self::assertSame(['name' => 'USDC', 'version' => '2'], $required->accepts[0]->extra);
    }

    public function testDecodesThePaymentSignatureVector(): void
    {
        $payment = Headers::decodePaymentPayload(SpecVectors::PAYMENT_SIGNATURE);

        self::assertSame('exact', $payment->accepted->scheme);
        self::assertSame(
            '0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480',
            $payment->payload['authorization']['nonce'],
        );
    }

    public function testDecodesThePaymentResponseVector(): void
    {
        $settlement = Headers::decodeSettleResponse(SpecVectors::PAYMENT_RESPONSE);

        self::assertTrue($settlement->success);
        self::assertSame('eip155:84532', $settlement->network);
        self::assertStringStartsWith('0x1234567890abcdef', $settlement->transaction);
    }

    /**
     * Key order is not significant, so compare the decoded objects rather than the base64.
     */
    public function testReEncodingTheVectorsIsLossless(): void
    {
        $cases = [
            [SpecVectors::PAYMENT_REQUIRED, fn (string $h): string => Headers::encodePaymentRequired(Headers::decodePaymentRequired($h))],
            [SpecVectors::PAYMENT_SIGNATURE, fn (string $h): string => Headers::encodePaymentPayload(Headers::decodePaymentPayload($h))],
            [SpecVectors::PAYMENT_RESPONSE, fn (string $h): string => Headers::encodeSettleResponse(Headers::decodeSettleResponse($h))],
        ];

        foreach ($cases as [$vector, $roundTrip]) {
            self::assertEquals(
                json_decode((string) base64_decode($vector, true), true),
                json_decode((string) base64_decode($roundTrip($vector), true), true),
            );
        }
    }

    public function testRejectsEmptyHeader(): void
    {
        $this->expectException(ParseException::class);
        Headers::decodePaymentRequired('   ');
    }

    public function testRejectsNonBase64(): void
    {
        $this->expectException(ParseException::class);
        Headers::decodePaymentRequired('!!!!');
    }

    public function testRejectsAJsonArray(): void
    {
        $this->expectException(ParseException::class);
        Headers::decodePaymentRequired(base64_encode('[1,2]'));
    }
}
