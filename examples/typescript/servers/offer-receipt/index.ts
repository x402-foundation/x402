import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  createOfferReceiptExtension,
  createJWSOfferReceiptIssuer,
  createEIP712OfferReceiptIssuer,
  declareOfferReceiptExtension,
} from "@x402/extensions/offer-receipt";
import { createJWSSignerFromPrivateKey } from "./jws-signer";
import { createEIP712SignerFromPrivateKey } from "./eip712-signer";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const svmAddress = process.env.SVM_ADDRESS;
if (!evmAddress || !svmAddress) {
  console.error("Missing EVM_ADDRESS or SVM_ADDRESS environment variable");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

// For production, use a proper key management solution (HSM, KMS, etc.)
// This example uses a simple private key for demonstration
const signingPrivateKey = process.env.SIGNING_PRIVATE_KEY;
if (!signingPrivateKey) {
  console.error("❌ SIGNING_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

// Signing format: "jws" (default) or "eip712"
const signingFormat = (process.env.SIGNING_FORMAT || "jws").toLowerCase();
if (signingFormat !== "jws" && signingFormat !== "eip712") {
  console.error('❌ SIGNING_FORMAT must be "jws" or "eip712"');
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Create the appropriate issuer based on signing format
let offerReceiptIssuer;
let kid: string;
let didDocument: object | null = null;

if (signingFormat === "eip712") {
  // EIP-712 signing using Ethereum private key
  const { signTypedData, address } = createEIP712SignerFromPrivateKey(signingPrivateKey);

  // Use did:pkh for EIP-712 (identifies the Ethereum address)
  // Format: did:pkh:eip155:<chainId>:<address>
  // Using chainId 1 (mainnet) as the canonical identifier
  kid = `did:pkh:eip155:1:${address}#key-1`;
  offerReceiptIssuer = createEIP712OfferReceiptIssuer(kid, signTypedData);

  console.log(`Using EIP-712 signing with address: ${address}`);
} else {
  // JWS signing using PKCS#8 private key
  const serverDomain = process.env.SERVER_DOMAIN;
  if (!serverDomain) {
    console.error(
      "❌ SERVER_DOMAIN environment variable is required for JWS signing (e.g., localhost%3A4021)",
    );
    process.exit(1);
  }

  const did = `did:web:${serverDomain}`;
  kid = `${did}#key-1`;
  const { signer: jwsSigner, publicKeyJwk } = createJWSSignerFromPrivateKey(signingPrivateKey, kid);
  offerReceiptIssuer = createJWSOfferReceiptIssuer(kid, jwsSigner);

  // Build DID document for /.well-known/did.json (only needed for JWS)
  didDocument = {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id: did,
    verificationMethod: [
      {
        id: kid,
        type: "JsonWebKey2020",
        controller: did,
        publicKeyJwk,
      },
    ],
    assertionMethod: [kid],
  };

  console.log(`Using JWS signing with did:web: ${did}`);
}

const app = express();

// Create the resource server with the offer-receipt extension registered
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme())
  .registerExtension(createOfferReceiptExtension(offerReceiptIssuer));

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          {
            scheme: "exact",
            // Note: "price" is SDK syntactic sugar that converts to "amount" in atomic units
            // The wire protocol uses "amount" per the x402 spec
            price: "$0.001",
            network: "eip155:84532",
            payTo: evmAddress,
          },
          {
            scheme: "exact",
            price: "$0.001",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            payTo: svmAddress,
          },
        ],
        description: "Weather data",
        mimeType: "application/json",
        extensions: {
          // Declare the offer-receipt extension for this route
          // includeTxHash: false (default) for privacy, true for verifiability
          ...declareOfferReceiptExtension({ includeTxHash: false }),
        },
      },
    },
    resourceServer,
  ),
);

app.get("/weather", (req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

// Serve DID document for JWS verification (only needed for JWS format)
// did:web resolves to /.well-known/did.json
if (didDocument) {
  app.get("/.well-known/did.json", (req, res) => {
    res.setHeader("Content-Type", "application/did+json");
    res.json(didDocument);
  });
}

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
  console.log("Offer-receipt extension enabled - responses will include signed offers/receipts");
  console.log(`Signing format: ${signingFormat.toUpperCase()}`);
  console.log(`Key ID: ${kid}`);
  if (didDocument) {
    console.log(`DID document available at http://localhost:4021/.well-known/did.json`);
  }
});
