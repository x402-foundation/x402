<?php

declare(strict_types=1);

namespace X402\Http;

use X402\Exception\ParseException;
use X402\Types\PaymentPayload;
use X402\Types\PaymentRequired;
use X402\Types\SettleResponse;

/**
 * The HTTP transport. Every protocol object travels as base64 JSON in a header; response bodies
 * are the server's own business.
 */
final class Headers
{
    public const PAYMENT_REQUIRED = 'PAYMENT-REQUIRED';
    public const PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE';
    public const PAYMENT_RESPONSE = 'PAYMENT-RESPONSE';

    public static function encodePaymentRequired(PaymentRequired $value): string
    {
        return self::encode($value->toArray());
    }

    public static function decodePaymentRequired(string $header): PaymentRequired
    {
        return PaymentRequired::fromArray(self::decode($header, self::PAYMENT_REQUIRED));
    }

    public static function encodePaymentPayload(PaymentPayload $value): string
    {
        return self::encode($value->toArray());
    }

    public static function decodePaymentPayload(string $header): PaymentPayload
    {
        return PaymentPayload::fromArray(self::decode($header, self::PAYMENT_SIGNATURE));
    }

    public static function encodeSettleResponse(SettleResponse $value): string
    {
        return self::encode($value->toArray());
    }

    public static function decodeSettleResponse(string $header): SettleResponse
    {
        return SettleResponse::fromArray(self::decode($header, self::PAYMENT_RESPONSE));
    }

    /**
     * @param array<string, mixed> $value
     */
    private static function encode(array $value): string
    {
        return base64_encode(json_encode($value, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    }

    /**
     * @return array<string, mixed>
     */
    private static function decode(string $header, string $name): array
    {
        $trimmed = trim($header);
        if ($trimmed === '') {
            throw new ParseException("{$name} header is empty");
        }

        $json = base64_decode($trimmed, true);
        if ($json === false) {
            throw new ParseException("{$name} header is not valid base64");
        }

        $decoded = json_decode($json, true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($decoded) || ($decoded !== [] && array_is_list($decoded))) {
            throw new ParseException("{$name} header must decode to a JSON object");
        }

        /** @var array<string, mixed> $decoded */
        return $decoded;
    }
}
