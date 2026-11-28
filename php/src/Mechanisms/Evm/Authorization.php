<?php

declare(strict_types=1);

namespace X402\Mechanisms\Evm;

use X402\Exception\ParseException;

/**
 * EIP-3009 transferWithAuthorization parameters.
 *
 * Timestamps are strings on the wire because they are uint256 on chain and would lose precision
 * as JSON numbers.
 */
final class Authorization implements \JsonSerializable
{
    public function __construct(
        public readonly string $from,
        public readonly string $to,
        public readonly string $value,
        public readonly string $validAfter,
        public readonly string $validBefore,
        public readonly string $nonce,
    ) {
        self::assertAddress($from, 'from');
        self::assertAddress($to, 'to');

        if (preg_match('/^\d+$/', $value) !== 1) {
            throw new ParseException('authorization.value must be atomic units as a decimal string');
        }
        foreach (['validAfter' => $validAfter, 'validBefore' => $validBefore] as $field => $ts) {
            if (preg_match('/^\d+$/', $ts) !== 1) {
                throw new ParseException("authorization.{$field} must be a unix timestamp string");
            }
        }
        if (self::compare($validAfter, $validBefore) >= 0) {
            throw new ParseException('authorization.validAfter must be before validBefore');
        }
        if (preg_match('/^0x[0-9a-fA-F]{64}$/', $nonce) !== 1) {
            throw new ParseException('authorization.nonce must be a 32-byte hex value');
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        foreach (['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as $required) {
            if (!isset($data[$required])) {
                throw new ParseException("authorization is missing \"{$required}\"");
            }
        }

        return new self(
            from: (string) $data['from'],
            to: (string) $data['to'],
            value: (string) $data['value'],
            validAfter: (string) $data['validAfter'],
            validBefore: (string) $data['validBefore'],
            nonce: (string) $data['nonce'],
        );
    }

    /**
     * @return array<string, string>
     */
    public function toArray(): array
    {
        return [
            'from' => $this->from,
            'to' => $this->to,
            'value' => $this->value,
            'validAfter' => $this->validAfter,
            'validBefore' => $this->validBefore,
            'nonce' => $this->nonce,
        ];
    }

    public function isActive(?int $now = null): bool
    {
        $now ??= time();

        return self::compare((string) $now, $this->validAfter) >= 0
            && self::compare((string) $now, $this->validBefore) < 0;
    }

    /**
     * Compare decimal strings that may exceed PHP_INT_MAX, without needing ext-bcmath.
     */
    private static function compare(string $a, string $b): int
    {
        $a = ltrim($a, '0');
        $b = ltrim($b, '0');

        return strlen($a) <=> strlen($b) ?: strcmp($a, $b);
    }

    private static function assertAddress(string $value, string $field): void
    {
        if (preg_match('/^0x[0-9a-fA-F]{40}$/', $value) !== 1) {
            throw new ParseException("authorization.{$field} must be a 20-byte hex address");
        }
    }

    /**
     * @return array<string, string>
     */
    public function jsonSerialize(): array
    {
        return $this->toArray();
    }
}
