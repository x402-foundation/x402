<?php

declare(strict_types=1);

namespace X402\Types;

use X402\Exception\ParseException;
use X402\Version;

/**
 * What a facilitator will handle, from GET /supported.
 */
final class SupportedResponse
{
    /**
     * @param list<array{x402Version: int, scheme: string, network: string, extra?: array<string, mixed>}> $kinds
     * @param list<string>                                                                                 $extensions
     * @param array<string, list<string>>                                                                  $signers    CAIP-2 pattern to signer addresses
     */
    public function __construct(
        public readonly array $kinds,
        public readonly array $extensions = [],
        public readonly array $signers = [],
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        if (!isset($data['kinds']) || !is_array($data['kinds'])) {
            throw new ParseException('supportedResponse is missing "kinds"');
        }

        $kinds = [];
        foreach ($data['kinds'] as $i => $kind) {
            if (!is_array($kind) || !isset($kind['scheme'], $kind['network'])) {
                throw new ParseException("kinds[{$i}] needs scheme and network");
            }
            $entry = [
                'x402Version' => isset($kind['x402Version']) ? (int) $kind['x402Version'] : Version::V2,
                'scheme' => (string) $kind['scheme'],
                'network' => (string) $kind['network'],
            ];
            if (isset($kind['extra']) && is_array($kind['extra'])) {
                /** @var array<string, mixed> $extra */
                $extra = $kind['extra'];
                $entry['extra'] = $extra;
            }
            $kinds[] = $entry;
        }

        $extensions = [];
        foreach ((array) ($data['extensions'] ?? []) as $extension) {
            $extensions[] = (string) $extension;
        }

        $signers = [];
        foreach ((array) ($data['signers'] ?? []) as $pattern => $addresses) {
            $signers[(string) $pattern] = array_values(array_map(strval(...), (array) $addresses));
        }

        /** @var list<array{x402Version: int, scheme: string, network: string, extra?: array<string, mixed>}> $kinds */
        return new self($kinds, $extensions, $signers);
    }

    public function supports(string $scheme, string $network): bool
    {
        foreach ($this->kinds as $kind) {
            if ($kind['scheme'] === $scheme && $kind['network'] === $network) {
                return true;
            }
        }

        return false;
    }
}
