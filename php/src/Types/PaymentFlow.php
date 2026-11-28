<?php

declare(strict_types=1);

namespace X402\Types;

/**
 * Where settlement sits relative to running the resource, per spec section 6.1.
 */
final class PaymentFlow
{
    /** verify, resource, settle. The default. */
    public const AUTHORIZATION = 'authorization';

    /** settle, resource, respond. For networks with no pull-settlement primitive. */
    public const UPFRONT = 'upfront';

    /** settle a deposit, resource, settle the final charge. */
    public const ESCROW = 'escrow';

    public const ALL = [self::AUTHORIZATION, self::UPFRONT, self::ESCROW];

    /**
     * Clients should prefer post-handler settlement when a resource offers both.
     */
    public static function settlesBeforeHandler(string $flow): bool
    {
        return $flow === self::UPFRONT || $flow === self::ESCROW;
    }
}
