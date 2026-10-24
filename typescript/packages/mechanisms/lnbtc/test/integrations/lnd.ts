import { readFileSync } from "node:fs";
import { request } from "node:https";
import type { Network } from "@x402/core/types";
import type {
  CreateInvoiceParams,
  LightningPayer,
  LightningPayment,
  LightningReceiver,
} from "../../src";

/**
 * Connection to one LND node's REST API.
 */
export interface LndNode {
  rest: string;
  macaroon: string;
  cert: Buffer;
}

/**
 * Loads an LND node from its REST URL, admin macaroon path, and TLS cert path.
 *
 * @param rest - REST base URL
 * @param macaroonPath - Admin macaroon file
 * @param certPath - TLS certificate file
 * @returns The node connection
 */
export function lndNode(rest: string, macaroonPath: string, certPath: string): LndNode {
  return {
    rest,
    macaroon: readFileSync(macaroonPath).toString("hex"),
    cert: readFileSync(certPath),
  };
}

/**
 * Calls an LND REST endpoint and returns the response body text.
 *
 * @param node - LND node
 * @param method - HTTP method
 * @param path - Request path
 * @param body - JSON body
 * @returns Response text
 */
export function lnd(node: LndNode, method: string, path: string, body?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, node.rest),
      { method, ca: node.cert, headers: { "Grpc-Metadata-macaroon": node.macaroon } },
      res => {
        let text = "";
        res.on("data", chunk => (text += chunk));
        res.on("end", () =>
          res.statusCode && res.statusCode < 300
            ? resolve(text)
            : reject(new Error(`LND ${path}: ${res.statusCode} ${text}`)),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const hex = (b64value: string) => Buffer.from(b64value, "base64").toString("hex");

/**
 * Receiver adapter: `AddInvoice` with a description hash.
 *
 * @param node - Receiver LND node
 * @returns The receiver adapter
 */
export function lndReceiver(node: LndNode): LightningReceiver {
  return {
    async createInvoice(params: CreateInvoiceParams): Promise<string> {
      const res = JSON.parse(
        await lnd(node, "POST", "/v1/invoices", {
          value_msat: params.amountMsat.toString(),
          description_hash: b64(params.descriptionHash),
          expiry: String(params.expirySeconds),
        }),
      );
      return res.payment_request;
    },
  };
}

/**
 * Payer adapter: router `SendPaymentV2`, reading the final streamed status.
 *
 * @param node - Payer LND node
 * @returns The payer adapter
 */
export function lndPayer(node: LndNode): LightningPayer {
  return {
    async payInvoice(invoice: string, _network: Network): Promise<LightningPayment> {
      const decoded = JSON.parse(await lnd(node, "GET", `/v1/payreq/${invoice}`));
      const base = {
        invoice,
        paymentHash: decoded.payment_hash as string,
        amountMsat: BigInt(decoded.num_msat),
      };
      let text: string;
      try {
        text = await lnd(node, "POST", "/v2/router/send", {
          payment_request: invoice,
          timeout_seconds: 30,
          fee_limit_sat: "1000",
        });
      } catch {
        return { ...base, status: "unpaid" };
      }
      const updates = text
        .trim()
        .split("\n")
        .map(line => JSON.parse(line).result ?? {});
      const last = updates[updates.length - 1];
      if (last.status === "SUCCEEDED")
        return { ...base, status: "paid", preimage: last.payment_preimage };
      if (last.status === "IN_FLIGHT") return { ...base, status: "in_flight" };
      return { ...base, status: "unpaid" };
    },
  };
}

/**
 * Looks up an invoice's state on the receiver.
 *
 * @param node - Receiver LND node
 * @param paymentHash - Payment hash, hex
 * @returns The invoice state and paid amount
 */
export async function lookupInvoice(
  node: LndNode,
  paymentHash: string,
): Promise<{ state: string; amtPaidMsat: string }> {
  const res = JSON.parse(await lnd(node, "GET", `/v1/invoice/${paymentHash}`));
  return { state: res.state, amtPaidMsat: res.amt_paid_msat };
}

/**
 * Decodes an invoice with LND.
 *
 * @param node - Any LND node
 * @param invoice - BOLT11 invoice
 * @returns Destination, amount, and description hash
 */
export async function decodeWithLnd(
  node: LndNode,
  invoice: string,
): Promise<{ destination: string; numMsat: string; descriptionHash: string }> {
  const res = JSON.parse(await lnd(node, "GET", `/v1/payreq/${invoice}`));
  return {
    destination: res.destination,
    numMsat: res.num_msat,
    descriptionHash: res.description_hash,
  };
}

export { hex };
