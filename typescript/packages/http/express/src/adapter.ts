import { HTTPAdapter } from "@x402/core/server";
import { Request } from "express";

/**
 * Express adapter implementation
 */
export class ExpressAdapter implements HTTPAdapter {
  /**
   * Creates a new ExpressAdapter instance.
   *
   * @param req - The Express request object
   */
  constructor(private req: Request) {}

  /**
   * Gets a header value from the request.
   *
   * @param name - The header name
   * @returns The header value or undefined
   */
  getHeader(name: string): string | undefined {
    const value = this.req.header(name);
    return Array.isArray(value) ? value[0] : value;
  }

  /**
   * Gets the HTTP method of the request.
   *
   * @returns The HTTP method
   */
  getMethod(): string {
    return this.req.method;
  }

  /**
   * Gets the path of the request.
   *
   * @returns The request path
   */
  getPath(): string {
    return this.req.path;
  }

  /**
   * Gets the full URL of the request.
   *
   * @returns The full request URL
   */
  getUrl(): string {
    return `${this.req.protocol}://${this.req.headers.host}${this.req.originalUrl}`;
  }

  /**
   * Gets the Accept header from the request.
   *
   * @returns The Accept header value or empty string
   */
  getAcceptHeader(): string {
    return this.req.header("Accept") || "";
  }

  /**
   * Gets the User-Agent header from the request.
   *
   * @returns The User-Agent header value or empty string
   */
  getUserAgent(): string {
    return this.req.header("User-Agent") || "";
  }

  /**
   * Gets all query parameters from the request URL.
   *
   * @returns Record of query parameter key-value pairs
   */
  getQueryParams(): Record<string, string | string[]> {
    return this.req.query as Record<string, string | string[]>;
  }

  /**
   * Gets a specific query parameter by name.
   *
   * @param name - The query parameter name
   * @returns The query parameter value(s) or undefined
   */
  getQueryParam(name: string): string | string[] | undefined {
    const value = this.req.query[name];
    return value as string | string[] | undefined;
  }

  /**
   * Gets the parsed request body.
   * Requires express.json() or express.urlencoded() middleware.
   *
   * @returns The parsed request body
   */
  getBody(): unknown {
    return this.req.body;
  }
}
