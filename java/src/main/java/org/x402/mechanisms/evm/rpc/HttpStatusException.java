package org.x402.mechanisms.evm.rpc;

import java.io.IOException;

/** The JSON-RPC endpoint answered with a non-2xx HTTP status, e.g. a gateway's 504. */
final class HttpStatusException extends IOException {

    private static final long serialVersionUID = 1L;

    private final int status;

    HttpStatusException(int status, String message) {
        super(message);
        this.status = status;
    }

    /** Returns the HTTP status code. */
    int status() {
        return status;
    }
}
