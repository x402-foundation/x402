import { toJsonSafe } from "../shared";
import {
  ListDiscoveryResourcesRequest,
  ListDiscoveryResourcesResponse,
  FacilitatorConfig,
  SupportedPaymentKindsResponse,
} from "../types";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
  VerifyError,
  SettleError,
} from "../types/verify";

const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

export type CreateHeaders = () => Promise<{
  verify: Record<string, string>;
  settle: Record<string, string>;
  supported: Record<string, string>;
  list?: Record<string, string>;
}>;

/**
 * Creates a facilitator client for interacting with the X402 payment facilitator service
 *
 * @param facilitator - The facilitator config to use. If not provided, the default facilitator will be used.
 * @returns An object containing verify and settle functions for interacting with the facilitator
 */
export function useFacilitator(facilitator?: FacilitatorConfig) {
  /**
   * Verifies a payment payload with the facilitator service
   *
   * @param payload - The payment payload to verify
   * @param paymentRequirements - The payment requirements to verify against
   * @returns A promise that resolves to the verification response
   */
  async function verify(
    payload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const url = facilitator?.url || DEFAULT_FACILITATOR_URL;

    let headers = { "Content-Type": "application/json" };
    if (facilitator?.createAuthHeaders) {
      const authHeaders = await facilitator.createAuthHeaders();
      headers = { ...headers, ...authHeaders.verify };
    }

    const res = await fetch(`${url}/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        x402Version: payload.x402Version,
        paymentPayload: toJsonSafe(payload),
        paymentRequirements: toJsonSafe(paymentRequirements),
      }),
    });

    const data = await res.json();

    if (typeof data === "object" && data !== null && "isValid" in data) {
      const verifyResponse = data as VerifyResponse;
      if (res.status !== 200) {
        throw new VerifyError(res.status, verifyResponse);
      }
      return verifyResponse;
    }

    throw new Error(`Failed to verify payment: ${res.status} ${res.statusText}`);
  }

  /**
   * Settles a payment with the facilitator service
   *
   * @param payload - The payment payload to settle
   * @param paymentRequirements - The payment requirements for the settlement
   * @returns A promise that resolves to the settlement response
   */
  async function settle(
    payload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const url = facilitator?.url || DEFAULT_FACILITATOR_URL;

    let headers = { "Content-Type": "application/json" };
    if (facilitator?.createAuthHeaders) {
      const authHeaders = await facilitator.createAuthHeaders();
      headers = { ...headers, ...authHeaders.settle };
    }

    const res = await fetch(`${url}/settle`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        x402Version: payload.x402Version,
        paymentPayload: toJsonSafe(payload),
        paymentRequirements: toJsonSafe(paymentRequirements),
      }),
    });

    const data = await res.json();

    if (typeof data === "object" && data !== null && "success" in data) {
      const settleResponse = data as SettleResponse;
      if (res.status !== 200) {
        throw new SettleError(res.status, settleResponse);
      }
      return settleResponse;
    }

    throw new Error(`Failed to settle payment: ${res.status} ${res.statusText}`);
  }

  /**
   * Gets the supported payment kinds from the facilitator server.
   * Auto-detects V2 format and converts to V1 format for backward compatibility.
   *
   * @returns A promise that resolves to the supported payment kinds
   */
  async function supported(): Promise<SupportedPaymentKindsResponse> {
    const url = facilitator?.url || DEFAULT_FACILITATOR_URL;

    let headers = { "Content-Type": "application/json" };
    if (facilitator?.createAuthHeaders) {
      const authHeaders = await facilitator.createAuthHeaders();
      headers = { ...headers, ...authHeaders.supported };
    }

    const res = await fetch(`${url}/supported`, {
      method: "GET",
      headers,
    });

    if (res.status !== 200) {
      throw new Error(`Failed to get supported payment kinds: ${res.statusText}`);
    }

    const data = await res.json();

    // V1 format - return as is
    return data as SupportedPaymentKindsResponse;
  }

  /**
   * Lists the discovery items with the facilitator service
   *
   * @param config - The configuration for the discovery list request
   * @returns A promise that resolves to the discovery list response
   */
  async function list(
    config: ListDiscoveryResourcesRequest = {},
  ): Promise<ListDiscoveryResourcesResponse> {
    const url = facilitator?.url || DEFAULT_FACILITATOR_URL;

    let headers = { "Content-Type": "application/json" };
    if (facilitator?.createAuthHeaders) {
      const authHeaders = await facilitator.createAuthHeaders();
      if (authHeaders.list) {
        headers = { ...headers, ...authHeaders.list };
      }
    }

    const urlParams = new URLSearchParams(
      Object.entries(config)
        .filter(([_, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );

    const res = await fetch(`${url}/discovery/resources?${urlParams.toString()}`, {
      method: "GET",
      headers,
    });

    if (res.status !== 200) {
      const text = res.statusText;
      throw new Error(`Failed to list discovery: ${res.status} ${text}`);
    }

    const data = await res.json();
    return data as ListDiscoveryResourcesResponse;
  }

  return { verify, settle, supported, list };
}

export const { verify, settle, supported, list } = useFacilitator();
