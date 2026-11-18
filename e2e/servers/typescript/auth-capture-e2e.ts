import type { HTTPFacilitatorClient } from "@x402/core/server";
import type { AuthCaptureLifecycleManager } from "@x402/evm/auth-capture/server";
import { AUTH_CAPTURE_E2E_CAPTURE_PATH } from "../../src/mechanisms";

let lifecycleManager: AuthCaptureLifecycleManager | undefined;

export function setAuthCaptureLifecycleManager(manager: AuthCaptureLifecycleManager | undefined): void {
  lifecycleManager = manager;
}

export function createAuthCaptureLifecycleManager(
  scheme: { createLifecycleManager: (client: HTTPFacilitatorClient) => AuthCaptureLifecycleManager },
  facilitator: HTTPFacilitatorClient,
): AuthCaptureLifecycleManager {
  return scheme.createLifecycleManager(facilitator);
}

export async function runAuthCaptureE2eCapture(
  bodyPath?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!lifecycleManager) {
    return { status: 501, body: { error: "Auth-capture lifecycle is not configured on this server" } };
  }

  try {
    const payments = await lifecycleManager.listAuthorizedPayments();
    if (payments.length === 0) {
      return { status: 404, body: { error: "No authorized payments in storage" } };
    }

    const sorted = [...payments].sort((a, b) => b.createdAt - a.createdAt);
    const record = sorted[0];
    const response = await lifecycleManager.capture(record.paymentInfoHash);

    return {
      status: 200,
      body: {
        success: response.success,
        transaction: response.transaction,
        paymentInfoHash: record.paymentInfoHash,
        ...(bodyPath ? { path: bodyPath } : {}),
        ...(response.errorReason ? { errorReason: response.errorReason } : {}),
      },
    };
  } catch (error) {
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : "Unknown error" },
    };
  }
}

type JsonHandlerApp = {
  post: (
    path: string,
    handler: (
      req: { body?: { path?: string } },
      res: { status: (code: number) => { json: (body: unknown) => void } },
    ) => void | Promise<void>,
  ) => void;
};

/** Registers the harness-only deferred capture endpoint (no payment middleware). */
export function registerAuthCaptureE2eRoutes(app: JsonHandlerApp): void {
  app.post(AUTH_CAPTURE_E2E_CAPTURE_PATH, async (req, res) => {
    const result = await runAuthCaptureE2eCapture(req.body?.path);
    res.status(result.status).json(result.body);
  });
}

export { AUTH_CAPTURE_E2E_CAPTURE_PATH };
