<?php

declare(strict_types=1);

namespace X402\Mechanisms\Evm;

/**
 * The `payload` object of an exact/eip3009 PaymentPayload.
 */
final class ExactEvmPayload implements \JsonSerializable
{
    public function __construct(
        public readonly string $signature,
        public readonly Authorization $authorization,
    ) {
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'signature' => $this->signature,
            'authorization' => $this->authorization->toArray(),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function jsonSerialize(): array
    {
        return $this->toArray();
    }
}
