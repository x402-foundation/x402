<?php

declare(strict_types=1);

namespace X402\Types;

use X402\Exception\ParseException;

/**
 * Describes the protected resource. The discovery-facing fields carry hard limits because the
 * Bazaar index silently drops resources that exceed them.
 */
final class ResourceInfo implements \JsonSerializable
{
    public const MAX_SERVICE_NAME = 32;
    public const MAX_TAGS = 5;
    public const MAX_TAG = 32;
    public const MAX_ICON_URL = 2048;

    /**
     * @param list<string> $tags
     */
    public function __construct(
        public readonly string $url,
        public readonly ?string $description = null,
        public readonly ?string $mimeType = null,
        public readonly ?string $serviceName = null,
        public readonly array $tags = [],
        public readonly ?string $iconUrl = null,
    ) {
        if ($url === '') {
            throw new ParseException('resource.url must not be empty');
        }

        if ($serviceName !== null) {
            self::assertPrintableAscii($serviceName, self::MAX_SERVICE_NAME, 'serviceName');
        }

        if (count($tags) > self::MAX_TAGS) {
            throw new ParseException('resource.tags allows at most ' . self::MAX_TAGS . ' entries');
        }
        foreach ($tags as $tag) {
            self::assertPrintableAscii($tag, self::MAX_TAG, 'tag');
        }

        if ($iconUrl !== null) {
            if (strlen($iconUrl) > self::MAX_ICON_URL) {
                throw new ParseException('resource.iconUrl is too long');
            }
            if (preg_match('#^https?://#i', $iconUrl) !== 1) {
                throw new ParseException('resource.iconUrl must be an absolute http or https URL');
            }
        }
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        if (!isset($data['url'])) {
            throw new ParseException('resource is missing "url"');
        }

        $tags = $data['tags'] ?? [];
        if (!is_array($tags)) {
            throw new ParseException('resource.tags must be an array');
        }

        return new self(
            url: (string) $data['url'],
            description: isset($data['description']) ? (string) $data['description'] : null,
            mimeType: isset($data['mimeType']) ? (string) $data['mimeType'] : null,
            serviceName: isset($data['serviceName']) ? (string) $data['serviceName'] : null,
            tags: array_values(array_map(strval(...), $tags)),
            iconUrl: isset($data['iconUrl']) ? (string) $data['iconUrl'] : null,
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        $out = ['url' => $this->url];

        foreach (['description', 'mimeType', 'serviceName', 'iconUrl'] as $optional) {
            if ($this->{$optional} !== null) {
                $out[$optional] = $this->{$optional};
            }
        }

        if ($this->tags !== []) {
            $out['tags'] = $this->tags;
        }

        return $out;
    }

    private static function assertPrintableAscii(string $value, int $max, string $field): void
    {
        if ($value === '' || strlen($value) > $max) {
            throw new ParseException("resource.{$field} must be 1 to {$max} characters");
        }
        if (preg_match('/^[\x20-\x7E]+$/', $value) !== 1) {
            throw new ParseException("resource.{$field} must be printable ASCII");
        }
    }

    /**
     * @return array<string, mixed>
     */
    public function jsonSerialize(): array
    {
        return $this->toArray();
    }
}
