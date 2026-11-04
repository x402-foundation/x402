/**
 * The {@code exact} payment scheme on EVM networks: the client signs an EIP-3009
 * {@code TransferWithAuthorization} for exactly the required amount and the facilitator submits it onchain.
 *
 * <p>Wire format of {@code PaymentPayload.payload} ({@link org.x402.mechanisms.evm.exact.ExactEvmPayload}):
 * <pre>{@code
 * {"signature":"0x<65 bytes>",
 *  "authorization":{"from":"0x..","to":"0x..","value":"1000","validAfter":"0","validBefore":"1740672154",
 *                   "nonce":"0x<32 bytes>"}}
 * }</pre>
 * {@link org.x402.mechanisms.evm.exact.ExactEvmClientScheme} creates the payload,
 * {@link org.x402.mechanisms.evm.exact.ExactEvmServerScheme} prices routes and
 * {@link org.x402.mechanisms.evm.exact.ExactEvmFacilitatorScheme} verifies and settles it. Reason codes are in
 * {@link org.x402.mechanisms.evm.exact.ExactEvmErrors}.
 *
 * <p>Unless noted, methods and constructors throw {@link java.lang.NullPointerException} for {@code null}
 * arguments.
 */
package org.x402.mechanisms.evm.exact;
