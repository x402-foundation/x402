package org.x402.mechanisms.evm.rpc;

import java.io.IOException;
import java.util.Objects;

/**
 * The EVM executed a call or a gas estimation and it reverted, e.g. a token rejected
 * {@code transferWithAuthorization} because the authorization was already used.
 *
 * <p>Unlike other {@link IOException}s, which say nothing about the call, a revert is the contract's answer: the
 * exact scheme maps the revert message to a reason code such as {@code invalid_exact_evm_nonce_already_used}.
 * {@link FacilitatorEvmSigner} implementations must therefore throw this type, not a plain {@code IOException},
 * when the node reports a revert.
 */
public class ContractRevertException extends IOException {

    private static final long serialVersionUID = 1L;

    private final byte[] revertData;

    /**
     * Creates an exception.
     *
     * @param message the revert description including the decoded reason when one is known, e.g.
     *     {@code "execution reverted: FiatTokenV2: authorization is used or canceled"}
     * @param revertData the raw revert data returned by the contract, possibly empty; copied
     */
    public ContractRevertException(String message, byte[] revertData) {
        super(Objects.requireNonNull(message, "message"));
        this.revertData = Objects.requireNonNull(revertData, "revertData").clone();
    }

    /**
     * Returns the raw revert data, e.g. an ABI-encoded {@code Error(string)} or a custom error.
     *
     * @return a copy of the data, empty when the contract reverted without data
     */
    public byte[] revertData() {
        return revertData.clone();
    }
}
