<?php

declare(strict_types=1);

namespace X402\Types;

use X402\Exception\ParseException;

/**
 * Read-only verdict from a facilitator's /verify. Commits no state.
 */
final class VerifyResponse implements \JsonSerializable
{
    /**
     * @param array<string, mixed> $extensions
     * @param array<string, mixed> $extra
     */
    public function __construct(
        public readonly bool $isValid,
        public readonly ?string $invalidReason = null,
        public readonly ?string $payer = null,
        public readonly array $extensions = [],
        public readonly array $extra = [],
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        if (!array_key_exists('isValid', $data)) {
            throw new ParseException('verifyResponse is missing "isValid"');
        }

        $extensions = $data['extensions'] ?? [];
        $extra = $data['extra'] ?? [];
        if (!is_array($extensions) || !is_array($extra)) {
            throw new ParseException('extensions and extra must be objects');
        }

        /** @var array<string, mixed> $extensions */
        /** @var array<string, mixed> $extra */
        return new self(
            isValid: (bool) $data['isValid'],
            invalidReason: isset($data['invalidReason']) ? (string) $data['invalidReason'] : null,
            payer: isset($data['payer']) ? (string) $data['payer'] : null,
            extensions: $extensions,
            extra: $extra,
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        $out = ['isValid' => $this->isValid];

        foreach (['invalidReason', 'payer'] as $optional) {
            if ($this->{$optional} !== null) {
                $out[$optional] = $this->{$optional};
            }
        }
        if ($this->extensions !== []) {
            $out['extensions'] = $this->extensions;
        }
        if ($this->extra !== []) {
            $out['extra'] = $this->extra;
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
