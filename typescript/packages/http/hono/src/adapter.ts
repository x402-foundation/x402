import { HTTPAdapter } from "@x402/core/server";
import { Context } from "hono";

/**
 * Hono adapter implementation
 */
export class HonoAdapter implements HTTPAdapter {
  /**
   * Creates a new HonoAdapter instance.
   *
   * @param c - The Hono context object
   */
  constructor(private c: Context) {}

  /**
   * Gets a header value from the request.
   *
   * @param name - The header name
   * @returns The header value or undefined
   */
  getHeader(name: string): string | undefined {
    return this.c.req.header(name);
  }

  /**
   * Gets the HTTP method of the request.
   *
   * @returns The HTTP method
   */
  getMethod(): string {
    return this.c.req.method;
  }

  /**
   * Gets the path of the request.
   *
   * @returns The request path
   */
  getPath(): string {
    return this.c.req.path;
  }

  /**
   * Gets the full URL of the request.
   *
   * @returns The full request URL
   */
  getUrl(): string {
    return this.c.req.url;
  }

  /**
   * Gets the Accept header from the request.
   *
   * @returns The Accept header value or empty string
   */
  getAcceptHeader(): string {
    return this.c.req.header("Accept") || "";
  }

  /**
   * Gets the User-Agent header from the request.
   *
   * @returns The User-Agent header value or empty string
   */
  getUserAgent(): string {
    return this.c.req.header("User-Agent") || "";
  }

  /**
   * Gets all query parameters from the request URL.
   *
   * @returns Record of query parameter key-value pairs
   */
  getQueryParams(): Record<string, string | string[]> {
    const query = this.c.req.query();
    // Convert single values to match the interface
    const result: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(query)) {
      result[key] = value;
    }
    return result;
  }

  /**
   * Gets a specific query parameter by name.
   *
   * @param name - The query parameter name
   * @returns The query parameter value(s) or undefined
   */
  getQueryParam(name: string): string | string[] | undefined {
    return this.c.req.query(name);
  }

  /**
   * Gets the parsed request body.
   * Requires appropriate body parsing middleware.
   *
   * @returns The parsed request body
   */
  async getBody(): Promise<unknown> {
    try {
      return await this.c.req.json();
    } catch {
      return undefined;
    }
  }
}
