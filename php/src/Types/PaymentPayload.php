<?php

declare(strict_types=1);

namespace X402\Types;

use X402\Exception\ParseException;
use X402\Version;

/**
 * What a client sends back: which requirement it chose, and the scheme-specific proof.
 */
final class PaymentPayload implements \JsonSerializable
{
    /**
     * @param array<string, mixed> $payload    scheme-specific
     * @param array<string, mixed> $extensions
     */
    public function __construct(
        public readonly PaymentRequirements $accepted,
        public readonly array $payload,
        public readonly ?ResourceInfo $resource = null,
        public readonly array $extensions = [],
        public readonly int $x402Version = Version::V2,
    ) {
        if ($x402Version !== Version::V2) {
            throw new ParseException("unsupported x402Version {$x402Version}");
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        if (!isset($data['accepted']) || !is_array($data['accepted'])) {
            throw new ParseException('paymentPayload is missing "accepted"');
        }
        if (!isset($data['payload']) || !is_array($data['payload'])) {
            throw new ParseException('paymentPayload is missing "payload"');
        }

        $extensions = $data['extensions'] ?? [];
        if (!is_array($extensions)) {
            throw new ParseException('extensions must be an object');
        }

        $resource = $data['resource'] ?? null;
        if ($resource !== null && !is_array($resource)) {
            throw new ParseException('resource must be an object');
        }

        /** @var array<string, mixed> $accepted */
        $accepted = $data['accepted'];
        /** @var array<string, mixed> $payload */
        $payload = $data['payload'];
        /** @var array<string, mixed> $extensions */

        return new self(
            accepted: PaymentRequirements::fromArray($accepted),
            payload: $payload,
            resource: $resource === null ? null : ResourceInfo::fromArray($resource),
            extensions: $extensions,
            x402Version: isset($data['x402Version']) ? (int) $data['x402Version'] : Version::V2,
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        $out = ['x402Version' => $this->x402Version];

        if ($this->resource !== null) {
            $out['resource'] = $this->resource->toArray();
        }

        $out['accepted'] = $this->accepted->toArray();
        $out['payload'] = $this->payload;

        if ($this->extensions !== []) {
            $out['extensions'] = $this->extensions;
        }

        return $out;
    }

    /**
     * @return array<string, mixed>
     */
    public function jsonSerialize(): array
    {
        return $this->toArray();
    }
}
