package org.x402.extensions.bazaar;

import java.util.Map;

/**
 * The output part of a discovery declaration.
 *
 * @param example an example response; a falsy value (null, false, 0, empty text) omits the whole
 *     output
 * @param schema JSON schema fields merged into the {@code example} schema, may be {@code null}
 */
public record DiscoveryOutput(Object example, Map<String, Object> schema) {}
