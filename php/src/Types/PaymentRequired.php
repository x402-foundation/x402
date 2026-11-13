<?php

declare(strict_types=1);

namespace X402\Types;

use X402\Exception\ParseException;
use X402\Version;

/**
 * What a server sends with a 402: the resource, and every way it will accept payment for it.
 */
final class PaymentRequired implements \JsonSerializable
{
    /**
     * @param list<PaymentRequirements> $accepts
     * @param array<string, mixed>      $extensions
     */
    public function __construct(
        public readonly ResourceInfo $resource,
        public readonly array $accepts,
        public readonly ?string $error = null,
        public readonly array $extensions = [],
        public readonly int $x402Version = Version::V2,
    ) {
        if ($accepts === []) {
            throw new ParseException('accepts must offer at least one payment requirement');
        }
        if ($x402Version !== Version::V2) {
            throw new ParseException("unsupported x402Version {$x402Version}");
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        if (!isset($data['resource']) || !is_array($data['resource'])) {
            throw new ParseException('paymentRequired is missing "resource"');
        }
        if (!isset($data['accepts']) || !is_array($data['accepts'])) {
            throw new ParseException('paymentRequired is missing "accepts"');
        }

        $accepts = [];
        foreach ($data['accepts'] as $i => $entry) {
            if (!is_array($entry)) {
                throw new ParseException("accepts[{$i}] must be an object");
            }
            /** @var array<string, mixed> $entry */
            $accepts[] = PaymentRequirements::fromArray($entry);
        }

        $extensions = $data['extensions'] ?? [];
        if (!is_array($extensions)) {
            throw new ParseException('extensions must be an object');
        }

        /** @var array<string, mixed> $resource */
        $resource = $data['resource'];
        /** @var array<string, mixed> $extensions */

        return new self(
            resource: ResourceInfo::fromArray($resource),
            accepts: $accepts,
            error: isset($data['error']) ? (string) $data['error'] : null,
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

        if ($this->error !== null) {
            $out['error'] = $this->error;
        }

        $out['resource'] = $this->resource->toArray();
        $out['accepts'] = array_map(static fn (PaymentRequirements $r): array => $r->toArray(), $this->accepts);

        if ($this->extensions !== []) {
            $out['extensions'] = $this->extensions;
        }

        return $out;
    }

    /**
     * First requirement the caller is willing and able to pay, in the caller's order of
     * preference rather than the server's.
     *
     * @param list<string> $schemes
     * @param list<string> $networks
     */
    public function select(array $schemes, array $networks = []): ?PaymentRequirements
    {
        foreach ($schemes as $scheme) {
            foreach ($this->accepts as $requirement) {
                if ($requirement->scheme !== $scheme) {
                    continue;
                }
                if ($networks !== [] && !in_array($requirement->network, $networks, true)) {
                    continue;
                }

                return $requirement;
            }
        }

        return null;
    }

    /**
     * @return array<string, mixed>
     */
    public function jsonSerialize(): array
    {
        return $this->toArray();
    }
}
