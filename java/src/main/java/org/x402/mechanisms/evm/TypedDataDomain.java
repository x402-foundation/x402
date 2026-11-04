package org.x402.mechanisms.evm;

import java.math.BigInteger;

/**
 * An EIP-712 domain: the context a typed-data signature is bound to.
 *
 * <p>Each member is optional; a {@code null} member is left out of the {@code EIP712Domain} type, which is
 * built from the present members in the order {@code name, version, chainId, verifyingContract}. An EIP-3009
 * token domain sets all four, e.g. Base Sepolia USDC:
 *
 * <pre>{@code
 * new TypedDataDomain("USDC", "2", BigInteger.valueOf(84532), "0x036CbD53842c5426634e7929541eC2318f3dCF7e")
 * }</pre>
 *
 * @param name the signing domain name, e.g. the token's EIP-712 {@code name()}, or {@code null}
 * @param version the signing domain version, e.g. {@code "2"}, or {@code null}
 * @param chainId the EIP-155 chain id, or {@code null}
 * @param verifyingContract the address of the contract that verifies the signature, or {@code null}
 */
public record TypedDataDomain(String name, String version, BigInteger chainId, String verifyingContract) {

    /**
     * Creates a domain.
     *
     * @throws IllegalArgumentException if {@code chainId} is outside the {@code uint256} range or
     *     {@code verifyingContract} is not a well-formed address
     */
    public TypedDataDomain {
        if (chainId != null) {
            Uint256.requireInRange(chainId);
        }
        if (verifyingContract != null && !EvmAddress.isValid(verifyingContract)) {
            throw new IllegalArgumentException("verifyingContract is not an EVM address");
        }
    }
}
