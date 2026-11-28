<?php

declare(strict_types=1);

namespace X402\Facilitator;

use X402\Types\PaymentPayload;
use X402\Types\PaymentRequirements;
use X402\Types\SettleResponse;
use X402\Types\SupportedResponse;
use X402\Types\VerifyResponse;

/**
 * The service that talks to the chain on a resource server's behalf.
 *
 * Kept as an interface so a server can point at a hosted facilitator, run its own, or
 * self-facilitate in process without the rest of the SDK caring which.
 */
interface Facilitator
{
    /**
     * Read-only. Must not commit payment state or write on chain.
     */
    public function verify(PaymentPayload $payload, PaymentRequirements $requirements): VerifyResponse;

    /**
     * Commits payment state. May be called more than once for flows that settle in steps.
     */
    public function settle(PaymentPayload $payload, PaymentRequirements $requirements): SettleResponse;

    public function supported(): SupportedResponse;
}
