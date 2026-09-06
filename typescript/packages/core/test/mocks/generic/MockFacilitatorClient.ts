import { FacilitatorClient } from "../../../src/http/httpFacilitatorClient";
import {
  SupportedResponse,
  VerifyResponse,
  SettleResponse,
  VerifyRequest,
  SettleRequest,
} from "../../../src/types/facilitator";
import { PaymentPayload, PaymentRequirements } from "../../../src/types/payments";

/**
 * Mock facilitator client for testing.
 * Allows configuration of responses and tracking of calls.
 */
export class MockFacilitatorClient implements FacilitatorClient {
  private supportedResponse: SupportedResponse;
  private verifyResponseOrError: VerifyResponse | Error;
  private settleResponseOrError: SettleResponse | Error;

  // Call tracking
  public verifyCalls: Array<{ payload: PaymentPayload; requirements: PaymentRequirements }> = [];
  public settleCalls: Array<{ payload: PaymentPayload; requirements: PaymentRequirements }> = [];
  public getSupportedCalls: number = 0;

  /**
   *
   * @param supportedResponse
   * @param verifyResponse
   * @param settleResponse
   */
  constructor(
    supportedResponse: SupportedResponse,
    verifyResponse: VerifyResponse | Error = { isValid: true },
    settleResponse: SettleResponse | Error = { success: true },
  ) {
    this.supportedResponse = supportedResponse;
    this.verifyResponseOrError = verifyResponse;
    this.settleResponseOrError = settleResponse;
  }

  /**
   *
   */
  async getSupported(): Promise<SupportedResponse> {
    this.getSupportedCalls++;
    return this.supportedResponse;
  }

  /**
   *
   */
  async verify(request: VerifyRequest): Promise<VerifyResponse>;
  /**
   *
   */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  /**
   *
   * @param payloadOrRequest
   * @param requirements
   */
  async verify(
    payloadOrRequest: PaymentPayload | VerifyRequest,
    requirements?: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const payload =
      "paymentPayload" in payloadOrRequest ? payloadOrRequest.paymentPayload : payloadOrRequest;
    const reqs =
      requirements ??
      ("paymentRequirements" in payloadOrRequest
        ? payloadOrRequest.paymentRequirements
        : undefined)!;

    this.verifyCalls.push({ payload, requirements: reqs });

    if (this.verifyResponseOrError instanceof Error) {
      throw this.verifyResponseOrError;
    }
    return this.verifyResponseOrError;
  }

  /**
   *
   */
  async settle(request: SettleRequest): Promise<SettleResponse>;
  /**
   *
   */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  /**
   *
   * @param payloadOrRequest
   * @param requirements
   */
  async settle(
    payloadOrRequest: PaymentPayload | SettleRequest,
    requirements?: PaymentRequirements,
  ): Promise<SettleResponse> {
    const payload =
      "paymentPayload" in payloadOrRequest ? payloadOrRequest.paymentPayload : payloadOrRequest;
    const reqs =
      requirements ??
      ("paymentRequirements" in payloadOrRequest
        ? payloadOrRequest.paymentRequirements
        : undefined)!;

    this.settleCalls.push({ payload, requirements: reqs });

    if (this.settleResponseOrError instanceof Error) {
      throw this.settleResponseOrError;
    }
    return this.settleResponseOrError;
  }

  // Helper methods for test configuration
  /**
   *
   * @param response
   */
  setVerifyResponse(response: VerifyResponse | Error): void {
    this.verifyResponseOrError = response;
  }

  /**
   *
   * @param response
   */
  setSettleResponse(response: SettleResponse | Error): void {
    this.settleResponseOrError = response;
  }

  /**
   *
   */
  reset(): void {
    this.verifyCalls = [];
    this.settleCalls = [];
    this.getSupportedCalls = 0;
  }
}
