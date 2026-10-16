<?php

declare(strict_types=1);

namespace X402\Types;

use X402\Exception\ParseException;

/**
 * Outcome of settlement, returned by a facilitator and echoed to the buyer in PAYMENT-RESPONSE.
 */
final class SettleResponse implements \JsonSerializable
{
    /**
     * Non-terminal: the transaction was broadcast but confirmation could not be established.
     * `transaction` carries the hash so the caller can reconcile on chain before retrying.
     */
    public const SETTLEMENT_PENDING = 'settlement_pending';

    /**
     * @param array<string, mixed> $extensions
     */
    public function __construct(
        public readonly bool $success,
        public readonly string $transaction,
        public readonly string $network,
        public readonly ?string $errorReason = null,
        public readonly ?string $payer = null,
        public readonly ?string $amount = null,
        public readonly array $extensions = [],
    ) {
        if ($errorReason === self::SETTLEMENT_PENDING && $transaction === '') {
            throw new ParseException('settlement_pending requires the broadcast transaction hash');
        }
    }

    public function isPending(): bool
    {
        return $this->errorReason === self::SETTLEMENT_PENDING;
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        foreach (['success', 'transaction', 'network'] as $required) {
            if (!array_key_exists($required, $data)) {
                throw new ParseException("settleResponse is missing \"{$required}\"");
            }
        }

        $extensions = $data['extensions'] ?? [];
        if (!is_array($extensions)) {
            throw new ParseException('extensions must be an object');
        }

        /** @var array<string, mixed> $extensions */
        return new self(
            success: (bool) $data['success'],
            transaction: (string) $data['transaction'],
            network: (string) $data['network'],
            errorReason: isset($data['errorReason']) ? (string) $data['errorReason'] : null,
            payer: isset($data['payer']) ? (string) $data['payer'] : null,
            amount: isset($data['amount']) ? (string) $data['amount'] : null,
            extensions: $extensions,
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        $out = ['success' => $this->success];

        if ($this->errorReason !== null) {
            $out['errorReason'] = $this->errorReason;
        }
        if ($this->payer !== null) {
            $out['payer'] = $this->payer;
        }

        $out['transaction'] = $this->transaction;
        $out['network'] = $this->network;

        if ($this->amount !== null) {
            $out['amount'] = $this->amount;
        }
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
