import { HTTPAdapter } from "@x402/core/server";
import { FastifyRequest } from "fastify";

/**
 * Fastify adapter implementation for the x402 HTTP protocol.
 */
export class FastifyAdapter implements HTTPAdapter {
  /**
   * Creates a new FastifyAdapter instance.
   *
   * @param request - The Fastify request object
   */
  constructor(private request: FastifyRequest) {}

  /**
   * Gets a header value from the request.
   *
   * @param name - The header name
   * @returns The header value or undefined
   */
  getHeader(name: string): string | undefined {
    const value = this.request.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  /**
   * Gets the HTTP method of the request.
   *
   * @returns The HTTP method
   */
  getMethod(): string {
    return this.request.method;
  }

  /**
   * Gets the path of the request.
   *
   * @returns The request path without query string
   */
  getPath(): string {
    return this.request.url.split("?")[0];
  }

  /**
   * Gets the full URL of the request.
   *
   * @returns The full request URL
   */
  getUrl(): string {
    return `${this.request.protocol}://${this.request.host || this.request.hostname}${this.request.url}`;
  }

  /**
   * Gets the Accept header from the request.
   *
   * @returns The Accept header value or empty string
   */
  getAcceptHeader(): string {
    return this.getHeader("accept") || "";
  }

  /**
   * Gets the User-Agent header from the request.
   *
   * @returns The User-Agent header value or empty string
   */
  getUserAgent(): string {
    return this.getHeader("user-agent") || "";
  }

  /**
   * Gets all query parameters from the request URL.
   *
   * @returns Record of query parameter key-value pairs
   */
  getQueryParams(): Record<string, string | string[]> {
    return (this.request.query as Record<string, string | string[]>) || {};
  }

  /**
   * Gets a specific query parameter by name.
   *
   * @param name - The query parameter name
   * @returns The query parameter value(s) or undefined
   */
  getQueryParam(name: string): string | string[] | undefined {
    return this.getQueryParams()[name];
  }

  /**
   * Gets the parsed request body.
   * Fastify automatically parses JSON bodies.
   *
   * @returns The parsed request body
   */
  getBody(): unknown {
    return this.request.body;
  }
}
