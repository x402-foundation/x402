import express from "express";
import { Network, paymentMiddleware, SolanaAddress } from "x402-express";
import dotenv from "dotenv";

dotenv.config();

const evmNetwork = process.env.EVM_NETWORK as Network;
const svmNetwork = process.env.SVM_NETWORK as Network;
const payToEvm = process.env.EVM_PAYEE_ADDRESS as `0x${string}`;
const payToSvm = process.env.SVM_PAYEE_ADDRESS as SolanaAddress;
const port = process.env.PORT || "4021";
const facilitatorUrl = process.env.FACILITATOR_URL;

if (!payToEvm || !evmNetwork) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// Create facilitator config if URL is provided
const facilitatorConfig = facilitatorUrl
  ? { url: facilitatorUrl as `${string}://${string}` }
  : undefined as any;

if (facilitatorUrl) {
  console.log(`Using remote facilitator at: ${facilitatorUrl}`);
} else {
  console.log(`Using default facilitator`);
}

const app = express();

app.use(
  paymentMiddleware(
    payToEvm,
    {
      "GET /protected": {
        price: "$0.001",
        network: evmNetwork,
      },
    },
    facilitatorConfig
  ),
);

app.use(
  paymentMiddleware(
    payToSvm,
    {
      "GET /protected-svm": {
        price: "$0.001",
        network: svmNetwork,
      },
    },
    facilitatorConfig
  ),
);

app.get("/protected", (req, res) => {
  res.json({
    message: "Protected endpoint accessed successfully",
    timestamp: new Date().toISOString(),
  });
});

app.get("/protected-svm", (req, res) => {
  res.json({
    message: "Protected endpoint #2 accessed successfully",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/close", (req, res) => {
  res.json({ message: "Server shutting down" });
  console.log("Received shutdown request");
  process.exit(0);
});

app.listen(parseInt(port), () => {
  console.log(`Server listening at http://localhost:${port}`);
}); 