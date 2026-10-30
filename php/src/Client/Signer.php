<?php

declare(strict_types=1);

namespace X402\Client;

use X402\Types\PaymentRequirements;
use X402\Types\ResourceInfo;

/**
 * Produces the scheme-specific payload for a chosen requirement.
 *
 * The SDK does not sign. EIP-712 over secp256k1 needs a keystore and a curve library, both of
 * which belong to the integrator rather than to a protocol package.
 */
interface Signer
{
    /**
     * Schemes this signer can satisfy, most preferred first.
     *
     * @return list<string>
     */
    public function schemes(): array;

    /**
     * Networks this signer can pay on, CAIP-2. Empty means any.
     *
     * @return list<string>
     */
    public function networks(): array;

    /**
     * @return array<string, mixed> the PaymentPayload `payload` object
     *
     * @throws \X402\Exception\X402Exception if the requirement cannot be paid
     */
    public function sign(PaymentRequirements $requirements, ?ResourceInfo $resource): array;
}
