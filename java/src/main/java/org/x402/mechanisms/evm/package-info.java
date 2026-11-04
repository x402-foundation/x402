/**
 * EVM building blocks shared by the EVM payment schemes: hex and Keccak-256 encoding, secp256k1 signing and
 * recovery, EIP-55 addresses, EIP-712 typed-data hashing, client signers, CAIP-2 chain ids, the default
 * stablecoin table and decimal-to-atomic amount conversion.
 *
 * <p>Everything here is immutable and thread-safe. Invalid caller input is rejected with
 * {@link java.lang.IllegalArgumentException} and, unless noted, a {@code null} argument with
 * {@link java.lang.NullPointerException}; error messages never echo private keys or signatures.
 */
package org.x402.mechanisms.evm;
