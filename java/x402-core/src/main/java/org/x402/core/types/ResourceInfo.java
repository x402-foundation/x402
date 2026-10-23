package org.x402.core.types;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.List;

/**
 * Describes the protected resource.
 *
 * @param url the resource URL
 * @param description optional human-readable description
 * @param mimeType optional response MIME type
 * @param serviceName optional service name
 * @param tags optional discovery tags
 * @param iconUrl optional icon URL
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"url", "description", "mimeType", "serviceName", "tags", "iconUrl"})
public record ResourceInfo(
    String url,
    String description,
    String mimeType,
    String serviceName,
    List<String> tags,
    String iconUrl) {

  /** Copies the tag list. */
  public ResourceInfo {
    tags = Collections2.copyList(tags);
  }

  /**
   * Creates a resource with only a URL.
   *
   * @param url the resource URL
   * @return the resource info
   */
  public static ResourceInfo of(String url) {
    return new ResourceInfo(url, null, null, null, null, null);
  }
}
