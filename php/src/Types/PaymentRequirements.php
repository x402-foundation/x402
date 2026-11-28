<?php

declare(strict_types=1);

namespace X402\Types;

use X402\Exception\ParseException;

/**
 * One acceptable way to pay, as advertised in PaymentRequired.accepts and echoed back in
 * PaymentPayload.accepted.
 */
final class PaymentRequirements implements \JsonSerializable
{
    /** Reserved keys in `extra`, per spec section 6.1. */
    public const EXTRA_ASSET_TRANSFER_METHOD = 'assetTransferMethod';
    public const EXTRA_PAYMENT_FLOW = 'paymentFlow';

    /**
     * @param array<string, mixed> $extra
     */
    public function __construct(
        public readonly string $scheme,
        public readonly string $network,
        public readonly string $amount,
        public readonly string $asset,
        public readonly string $payTo,
        public readonly int $maxTimeoutSeconds,
        public readonly array $extra = [],
    ) {
        foreach (['scheme' => $scheme, 'network' => $network, 'amount' => $amount, 'asset' => $asset, 'payTo' => $payTo] as $field => $value) {
            if ($value === '') {
                throw new ParseException("paymentRequirements.{$field} must not be empty");
            }
        }

        if (preg_match('/^\d+$/', $amount) !== 1) {
            throw new ParseException('amount must be atomic units as a decimal string');
        }

        // CAIP-2: namespace:reference.
        if (preg_match('/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/', $network) !== 1) {
            throw new ParseException("network must be a CAIP-2 identifier, got \"{$network}\"");
        }

        if ($maxTimeoutSeconds <= 0) {
            throw new ParseException('maxTimeoutSeconds must be positive');
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        foreach (['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds'] as $required) {
            if (!isset($data[$required])) {
                throw new ParseException("paymentRequirements is missing \"{$required}\"");
            }
        }

        $extra = $data['extra'] ?? [];
        if (!is_array($extra)) {
            throw new ParseException('extra must be an object');
        }

        /** @var array<string, mixed> $extra */
        return new self(
            scheme: (string) $data['scheme'],
            network: (string) $data['network'],
            amount: (string) $data['amount'],
            asset: (string) $data['asset'],
            payTo: (string) $data['payTo'],
            maxTimeoutSeconds: (int) $data['maxTimeoutSeconds'],
            extra: $extra,
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        $out = [
            'scheme' => $this->scheme,
            'network' => $this->network,
            'amount' => $this->amount,
            'asset' => $this->asset,
            'payTo' => $this->payTo,
            'maxTimeoutSeconds' => $this->maxTimeoutSeconds,
        ];

        if ($this->extra !== []) {
            $out['extra'] = $this->extra;
        }

        return $out;
    }

    public function assetTransferMethod(): ?string
    {
        $value = $this->extra[self::EXTRA_ASSET_TRANSFER_METHOD] ?? null;

        return is_string($value) ? $value : null;
    }

    /**
     * Defaults to `authorization` when unset, per section 6.1.
     */
    public function paymentFlow(): string
    {
        $value = $this->extra[self::EXTRA_PAYMENT_FLOW] ?? null;

        return is_string($value) ? $value : PaymentFlow::AUTHORIZATION;
    }

    /**
     * @return array<string, mixed>
     */
    public function jsonSerialize(): array
    {
        return $this->toArray();
    }
}
