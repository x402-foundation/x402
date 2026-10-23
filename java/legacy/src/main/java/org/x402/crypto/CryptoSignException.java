package org.x402.crypto;

/**
 * Exception thrown when cryptographic signing operations fail.
 */
public class CryptoSignException extends Exception {
    
    /**
     * Constructs a new CryptoSignException with the specified detail message.
     *
     * @param message the detail message
     */
    public CryptoSignException(String message) {
        super(message);
    }
    
    /**
     * Constructs a new CryptoSignException with the specified detail message and cause.
     *
     * @param message the detail message
     * @param cause the cause
     */
    public CryptoSignException(String message, Throwable cause) {
        super(message, cause);
    }
}