import { HTTPAdapter } from "@x402/core/server";
import type { Context } from "koa";

/**
 * Koa adapter implementation.
 *
 * Maps Koa's Context to the x402 HTTPAdapter interface.
 */
export class KoaAdapter implements HTTPAdapter {
  /**
   * Creates a new KoaAdapter instance.
   *
   * @param ctx - The Koa context object
   */
  constructor(private ctx: Context) {}

  /**
   * Gets a header value from the request.
   *
   * @param name - The header name
   * @returns The header value or undefined
   */
  getHeader(name: string): string | undefined {
    const value = this.ctx.get(name);
    return value || undefined;
  }

  /**
   * Gets the HTTP method of the request.
   *
   * @returns The HTTP method
   */
  getMethod(): string {
    return this.ctx.method;
  }

  /**
   * Gets the path of the request.
   *
   * Uses ctx.path which is mount-relative under koa-mount.
   * For the full external URL, use getUrl() instead.
   *
   * @returns The request path (mount-relative)
   */
  getPath(): string {
    return this.ctx.path;
  }

  /**
   * Gets the full URL of the request.
   *
   * Uses ctx.originalUrl (not ctx.path) to include the full external path,
   * even when mounted under koa-mount. This is the URL clients actually requested.
   *
   * @returns The full request URL
   */
  getUrl(): string {
    // ctx.path is mount-relative; ctx.originalUrl is the full external path.
    // The resource field must use the external URL that clients see.
    return this.ctx.origin + this.ctx.originalUrl;
  }

  /**
   * Gets the Accept header from the request.
   *
   * @returns The Accept header value or empty string
   */
  getAcceptHeader(): string {
    return this.ctx.get("Accept") || "";
  }

  /**
   * Gets the User-Agent header from the request.
   *
   * @returns The User-Agent header value or empty string
   */
  getUserAgent(): string {
    return this.ctx.get("User-Agent") || "";
  }

  /**
   * Gets all query parameters from the request URL.
   *
   * @returns Record of query parameter key-value pairs
   */
  getQueryParams(): Record<string, string | string[]> {
    return this.ctx.query as Record<string, string | string[]>;
  }

  /**
   * Gets a specific query parameter by name.
   *
   * @param name - The query parameter name
   * @returns The query parameter value(s) or undefined
   */
  getQueryParam(name: string): string | string[] | undefined {
    const value = this.ctx.query[name];
    return value as string | string[] | undefined;
  }

  /**
   * Gets the parsed request body.
   * Requires a body parser middleware (e.g., koa-bodyparser).
   *
   * @returns The parsed request body
   */
  getBody(): unknown {
    // Body is added by body parser middleware (e.g., koa-bodyparser)
    return (this.ctx.request as { body?: unknown }).body;
  }
}
