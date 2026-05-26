import type { CloudFrontRequest } from 'aws-lambda';
import type { HTTPAdapter } from '@x402/core/server';

/**
 * CloudFront HTTPAdapter implementation for x402HTTPResourceServer
 */
export class CloudFrontHTTPAdapter implements HTTPAdapter {
  constructor(
    private request: CloudFrontRequest,
    private distributionDomain: string
  ) { }

  getHeader(name: string): string | undefined {
    const headerName = name.toLowerCase();
    return this.request.headers[headerName]?.[0]?.value;
  }

  getMethod(): string {
    return this.request.method;
  }

  getPath(): string {
    return this.request.uri;
  }

  getUrl(): string {
    return `https://${this.distributionDomain}${this.request.uri}${this.request.querystring ? '?' + this.request.querystring : ''}`;
  }

  /**
   * Override to always return 'application/json' to prevent browser detection.
   * This ensures x402HTTPResourceServer returns JSON 402 responses instead of HTML paywall.
   * Lambda@Edge responses are limited to 1MB, making HTML paywalls impractical.
   * For browser payment flows, consider uploading paywall HTML to S3 and using origin routing.
   */
  getAcceptHeader(): string {
    return 'application/json';
  }

  getUserAgent(): string {
    return this.getHeader('user-agent') || '';
  }

  getQueryParams(): Record<string, string | string[]> {
    const params: Record<string, string | string[]> = {};
    if (this.request.querystring) {
      const searchParams = new URLSearchParams(this.request.querystring);
      searchParams.forEach((value, key) => {
        params[key] = value;
      });
    }
    return params;
  }
}
