<?php

declare(strict_types=1);

namespace X402\Exception;

/**
 * The facilitator could not be reached or did not answer usefully. Distinct from a payment that
 * was reached and rejected, which comes back as a VerifyResponse or SettleResponse.
 */
final class FacilitatorException extends X402Exception
{
}
