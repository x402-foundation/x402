package org.x402.types;

import java.util.List;

/**
 * Describes the protected resource a payment is for.
 *
 * @param url the resource URL
 * @param description optional human-readable description
 * @param mimeType optional MIME type of the resource response
 * @param serviceName optional service name, at most 32 printable ASCII characters
 * @param tags optional tags, at most 5 entries
 * @param iconUrl optional absolute http(s) icon URL
 */
public record ResourceInfo(
        String url,
        String description,
        String mimeType,
        String serviceName,
        List<String> tags,
        String iconUrl) {

    /** Creates a resource description, copying {@code tags}. */
    public ResourceInfo {
        tags = Immutables.list(tags);
    }

    /**
     * Creates a resource description with only the required URL and the common optional fields.
     *
     * @param url the resource URL
     * @param description human-readable description, or {@code null}
     * @param mimeType MIME type of the resource response, or {@code null}
     * @return the resource description
     */
    public static ResourceInfo of(String url, String description, String mimeType) {
        return new ResourceInfo(url, description, mimeType, null, null, null);
    }
}
