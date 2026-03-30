export type {
  VerifyRequest,
  VerifyResponse,
  SettleRequest,
  SettleResponse,
  SupportedResponse,
} from "./facilitator";
export {
  VerifyError,
  SettleError,
  FacilitatorResponseError,
  getFacilitatorResponseError,
} from "./facilitator";
export type {
  PaymentRequirements,
  PaymentPayload,
  PaymentRequired,
  ResourceInfo,
} from "./payments";
export type {
  SchemeNetworkClient,
  SchemeNetworkFacilitator,
  SchemeNetworkServer,
  MoneyParser,
  PaymentPayloadResult,
  PaymentPayloadContext,
  FacilitatorContext,
} from "./mechanisms";
export type { PaymentRequirementsV1, PaymentRequiredV1, PaymentPayloadV1 } from "./v1";
export type {
  FacilitatorExtension,
  ResourceServerExtension,
  PaymentRequiredContext,
  SettleResultContext,
} from "./extensions";

export type Network = `${string}:${string}`;

export type Money = string | number;
export type AssetAmount = {
  asset: string;
  amount: string;
  extra?: Record<string, unknown>;
};
export type Price = Money | AssetAmount;
