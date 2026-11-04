package org.x402.mechanisms.evm.rpc;

import java.io.IOException;

/**
 * A JSON-RPC node answered a request with an error object, e.g. {@code {"code":-32000,"message":"nonce too
 * low"}}.
 *
 * <p>The request reached the node and was rejected, as opposed to a plain {@link IOException}, which means the
 * node could not be reached or sent something that is not a JSON-RPC response. The exception message joins the
 * method, the node's message and the code, e.g. {@code "eth_sendRawTransaction: nonce too low (code -32000)"}; it
 * never contains the endpoint URL or the request parameters.
 */
public class JsonRpcException extends IOException {

    private static final long serialVersionUID = 1L;

    private final int code;
    private final String rpcMessage;
    private final String data;

    /**
     * Creates an exception from a JSON-RPC error object.
     *
     * @param method the JSON-RPC method that failed, e.g. {@code "eth_sendRawTransaction"}
     * @param code the error code, e.g. {@code -32000} for a generic server error or {@code 3} for a revert
     * @param rpcMessage the error message reported by the node
     * @param data the {@code data} member as text, e.g. hex revert data, or {@code null} when absent
     */
    public JsonRpcException(String method, int code, String rpcMessage, String data) {
        super(method + ": " + rpcMessage + " (code " + code + ")");
        this.code = code;
        this.rpcMessage = rpcMessage;
        this.data = data;
    }

    /**
     * Returns the JSON-RPC error code.
     *
     * @return the code, e.g. {@code -32601} when the method does not exist
     */
    public int code() {
        return code;
    }

    /**
     * Returns the message the node reported, without the method name and code.
     *
     * @return the node's message
     */
    public String rpcMessage() {
        return rpcMessage;
    }

    /**
     * Returns the {@code data} member of the error object.
     *
     * @return the data as text, e.g. {@code "0x08c379a0..."} for a revert, or {@code null} when absent
     */
    public String data() {
        return data;
    }
}
