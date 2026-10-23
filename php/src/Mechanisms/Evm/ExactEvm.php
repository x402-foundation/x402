<?php

declare(strict_types=1);

namespace X402\Mechanisms\Evm;

use X402\Exception\ParseException;
use X402\Types\PaymentPayload;
use X402\Types\PaymentRequirements;

/**
 * `exact` on EVM via EIP-3009, per specs/schemes/exact/scheme_exact_evm.md.
 *
 * Checks everything that can be checked without a node. Signature recovery, balances and
 * simulation are the facilitator's job.
 */
final class ExactEvm
{
    public const SCHEME = 'exact';
    public const ASSET_TRANSFER_METHOD = 'eip3009';
    public const NETWORK_PREFIX = 'eip155:';

    public static function handles(PaymentRequirements $requirements): bool
    {
        if ($requirements->scheme !== self::SCHEME) {
            return false;
        }
        if (!str_starts_with($requirements->network, self::NETWORK_PREFIX)) {
            return false;
        }

        $method = $requirements->assetTransferMethod();

        return $method === null || $method === self::ASSET_TRANSFER_METHOD;
    }

    /**
     * eip3009 needs the token's EIP-712 domain to reconstruct the signed message, so a
     * requirement without name and version cannot be paid.
     */
    public static function assertRequirements(PaymentRequirements $requirements): void
    {
        if (!self::handles($requirements)) {
            throw new ParseException('not an exact/eip3009 EVM requirement');
        }

        foreach (['name', 'version'] as $field) {
            if (!isset($requirements->extra[$field]) || !is_string($requirements->extra[$field])) {
                throw new ParseException("extra.{$field} is required for eip3009 and must be a string");
            }
        }

        if (preg_match('/^0x[0-9a-fA-F]{40}$/', $requirements->asset) !== 1) {
            throw new ParseException('asset must be a 20-byte hex token address');
        }
        if (preg_match('/^0x[0-9a-fA-F]{40}$/', $requirements->payTo) !== 1) {
            throw new ParseException('payTo must be a 20-byte hex address');
        }
    }

    /**
     * @param array<string, mixed> $payload
     */
    public static function parsePayload(array $payload): ExactEvmPayload
    {
        if (!isset($payload['signature']) || !is_string($payload['signature'])) {
            throw new ParseException('payload.signature is required');
        }
        if (preg_match('/^0x[0-9a-fA-F]{130}$/', $payload['signature']) !== 1) {
            throw new ParseException('payload.signature must be a 65-byte hex signature');
        }
        if (!isset($payload['authorization']) || !is_array($payload['authorization'])) {
            throw new ParseException('payload.authorization is required');
        }

        /** @var array<string, mixed> $authorization */
        $authorization = $payload['authorization'];

        return new ExactEvmPayload($payload['signature'], Authorization::fromArray($authorization));
    }

    /**
     * Offline checks a resource server should make before spending a facilitator call.
     */
    public static function assertPayloadMatches(PaymentPayload $payment, PaymentRequirements $requirements, ?int $now = null): void
    {
        self::assertRequirements($requirements);

        $accepted = $payment->accepted;
        foreach (['scheme', 'network', 'amount', 'asset', 'payTo'] as $field) {
            if ($accepted->{$field} !== $requirements->{$field}) {
                throw new ParseException("accepted.{$field} does not match the requirement");
            }
        }

        $parsed = self::parsePayload($payment->payload);
        $authorization = $parsed->authorization;

        if (strcasecmp($authorization->to, $requirements->payTo) !== 0) {
            throw new ParseException('authorization.to is not the required recipient');
        }
        if ($authorization->value !== $requirements->amount) {
            throw new ParseException('authorization.value does not equal the required amount');
        }
        if (!$authorization->isActive($now)) {
            throw new ParseException('authorization is outside its validity window');
        }
    }
}
