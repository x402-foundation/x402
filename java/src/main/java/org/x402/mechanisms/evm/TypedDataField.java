package org.x402.mechanisms.evm;

import java.util.Objects;

/**
 * One member of an EIP-712 struct type, e.g. {@code new TypedDataField("value", "uint256")}.
 *
 * <p>The field order of a struct is significant: it determines both the type string, such as
 * {@code TransferWithAuthorization(address from,address to,...)}, and the encoding of the data.
 *
 * @param name the member name, e.g. {@code "from"}
 * @param type the Solidity type, e.g. {@code "address"}; see {@link Eip712} for the supported types
 */
public record TypedDataField(String name, String type) {

    /**
     * Creates a field.
     *
     * @throws IllegalArgumentException if {@code name} or {@code type} is empty
     */
    public TypedDataField {
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(type, "type");
        if (name.isEmpty() || type.isEmpty()) {
            throw new IllegalArgumentException("Field name and type must not be empty");
        }
    }
}
