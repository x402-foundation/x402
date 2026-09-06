import { HTTPAdapter } from "@x402/core/server";
import { NextRequest } from "next/server";

/**
 * Next.js adapter implementation
 */
export class NextAdapter implements HTTPAdapter {
  /**
   * Creates a new NextAdapter instance.
   *
   * @param req - The Next.js request object
   */
  constructor(private req: NextRequest) {}

  /**
   * Gets a header value from the request.
   *
   * @param name - The header name
   * @returns The header value or undefined
   */
  getHeader(name: string): string | undefined {
    return this.req.headers.get(name) || undefined;
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
    return this.req.nextUrl.pathname;
  }

  /**
   * Gets the full URL of the request.
   *
   * @returns The full request URL
   */
  getUrl(): string {
    return this.req.url;
  }

  /**
   * Gets the Accept header from the request.
   *
   * @returns The Accept header value or empty string
   */
  getAcceptHeader(): string {
    return this.req.headers.get("Accept") || "";
  }

  /**
   * Gets the User-Agent header from the request.
   *
   * @returns The User-Agent header value or empty string
   */
  getUserAgent(): string {
    return this.req.headers.get("User-Agent") || "";
  }

  /**
   * Gets all query parameters from the request URL.
   *
   * @returns Record of query parameter key-value pairs
   */
  getQueryParams(): Record<string, string | string[]> {
    const params: Record<string, string | string[]> = {};
    this.req.nextUrl.searchParams.forEach((value, key) => {
      const existing = params[key];
      if (existing) {
        if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          params[key] = [existing, value];
        }
      } else {
        params[key] = value;
      }
    });
    return params;
  }

  /**
   * Gets a specific query parameter by name.
   *
   * @param name - The query parameter name
   * @returns The query parameter value(s) or undefined
   */
  getQueryParam(name: string): string | string[] | undefined {
    const all = this.req.nextUrl.searchParams.getAll(name);
    if (all.length === 0) return undefined;
    if (all.length === 1) return all[0];
    return all;
  }

  /**
   * Gets the parsed request body.
   *
   * @returns Promise resolving to the parsed request body
   */
  async getBody(): Promise<unknown> {
    try {
      return await this.req.json();
    } catch {
      return undefined;
    }
  }
}
