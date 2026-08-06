import type Koa from "koa";

/**
 * Koa middleware function type for x402 payment middleware.
 *
 * The middleware returned by `paymentMiddleware` conforms to this type.
 */
export type KoaPaymentMiddleware = Koa.Middleware;
