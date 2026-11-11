package org.x402.extensions.bazaar;

import java.util.Map;
import java.util.Objects;

/** Configuration of an MCP tool discovery declaration. */
public final class McpDiscoveryConfig {

  private final String toolName;
  private final Map<String, Object> inputSchema;
  private String description;
  private String transport;
  private Map<String, Object> example;
  private DiscoveryOutput output;

  private McpDiscoveryConfig(String toolName, Map<String, Object> inputSchema) {
    this.toolName = Objects.requireNonNull(toolName, "toolName");
    this.inputSchema = Objects.requireNonNull(inputSchema, "inputSchema");
  }

  /**
   * A configuration for one tool.
   *
   * @param toolName the MCP tool name
   * @param inputSchema JSON schema of the tool arguments
   * @return the configuration
   */
  public static McpDiscoveryConfig of(String toolName, Map<String, Object> inputSchema) {
    return new McpDiscoveryConfig(toolName, inputSchema);
  }

  /**
   * Sets the tool description.
   *
   * @param value the description
   * @return this
   */
  public McpDiscoveryConfig description(String value) {
    this.description = value;
    return this;
  }

  /**
   * Sets the MCP transport, normally {@code streamable-http} or {@code sse}.
   *
   * @param value the transport
   * @return this
   */
  public McpDiscoveryConfig transport(String value) {
    this.transport = value;
    return this;
  }

  /**
   * Sets example tool arguments.
   *
   * @param value the example
   * @return this
   */
  public McpDiscoveryConfig example(Map<String, Object> value) {
    this.example = value;
    return this;
  }

  /**
   * Sets the output example and schema.
   *
   * @param value the output, may be {@code null}
   * @return this
   */
  public McpDiscoveryConfig output(DiscoveryOutput value) {
    this.output = value;
    return this;
  }

  String toolName() {
    return toolName;
  }

  Map<String, Object> inputSchema() {
    return inputSchema;
  }

  String description() {
    return description;
  }

  String transport() {
    return transport;
  }

  Map<String, Object> example() {
    return example;
  }

  DiscoveryOutput output() {
    return output;
  }
}
