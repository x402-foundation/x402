import "dotenv/config";
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";

const app = express();
app.use(express.json());

const {
	PAY_TO_ADDRESS,
	FACILITATOR_URL = "https://x402.org/facilitator",
	SPRAAY_GATEWAY_URL = "https://gateway.spraay.app",
	PORT = "4021",
	NETWORK = "eip155:84532",
} = process.env;

if (!PAY_TO_ADDRESS) {
	console.error("PAY_TO_ADDRESS is required in .env");
	process.exit(1);
}

// ---------------------------------------------------------
// Route pricing – mirrors Spraay's live gateway categories
// ---------------------------------------------------------
// Spraay exposes 76+ paid endpoints across 16 categories and
// 13 chains (Base, Ethereum, Arbitrum, Polygon, BNB, Avalanche,
// Unichain, Plasma, BOB, Solana, Bittensor, Stacks, Bitcoin).
//
// This example demonstrates a representative subset so agents
// can discover and pay for DeFi primitives, payroll, robot
// hiring (RTP), and AI inference — all via x402.
// ---------------------------------------------------------

const routePricing: Record<string, object> = {
	// Category 1 – Batch Payments (core primitive)
	"POST /batch-payment": {
		accepts: {
			scheme: "exact",
			price: "$0.01",
			network: NETWORK,
			payTo: PAY_TO_ADDRESS,
		},
		description:
			"Send USDC to multiple recipients in a single transaction on any supported chain",
		mimeType: "application/json",
	},

	// Category 4 – Token Transfers
	"POST /token-transfer": {
		accepts: {
			scheme: "exact",
			price: "$0.01",
			network: NETWORK,
			payTo: PAY_TO_ADDRESS,
		},
		description: "Transfer any ERC-20 token between addresses",
		mimeType: "application/json",
	},

	// Category 6 – Payroll
	"POST /payroll": {
		accepts: {
			scheme: "exact",
			price: "$0.05",
			network: NETWORK,
			payTo: PAY_TO_ADDRESS,
		},
		description:
			"Process recurring payroll for multiple employees in one transaction",
		mimeType: "application/json",
	},

	// Category 13 – AI Inference
	"POST /ai/inference": {
		accepts: {
			scheme: "exact",
			price: "$0.03",
			network: NETWORK,
			payTo: PAY_TO_ADDRESS,
		},
		description:
			"Run AI inference via Spraay's BlockRun multi-provider gateway (43+ models)",
		mimeType: "application/json",
	},

	// Category 15 – Robot Task Protocol (RTP)
	"POST /rtp/task": {
		accepts: {
			scheme: "exact",
			price: "$0.05",
			network: NETWORK,
			payTo: PAY_TO_ADDRESS,
		},
		description:
			"Hire a robot to perform a physical task via RTP (Robot Task Protocol)",
		mimeType: "application/json",
	},

	// Discovery – free endpoint (no payment required)
	"GET /discover": {
		accepts: {
			scheme: "exact",
			price: "$0.00",
			network: NETWORK,
			payTo: PAY_TO_ADDRESS,
		},
		description: "List all available Spraay gateway endpoints and pricing",
		mimeType: "application/json",
	},
};

// ---------------------------------------------------------
// x402 middleware – one line to protect all routes
// ---------------------------------------------------------
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
	NETWORK,
	new ExactEvmScheme(),
);

app.use(paymentMiddleware(routePricing, resourceServer));

// ---------------------------------------------------------
// Route handlers – proxy to the live Spraay gateway
// ---------------------------------------------------------

// Helper to forward requests to Spraay
async function proxyToSpraay(path: string, body?: object) {
	const res = await fetch(`${SPRAAY_GATEWAY_URL}${path}`, {
		method: body ? "POST" : "GET",
		headers: { "Content-Type": "application/json" },
		...(body && { body: JSON.stringify(body) }),
	});
	return res.json();
}

// Batch payment – send to multiple recipients
app.post("/batch-payment", async (req, res) => {
	try {
		const result = await proxyToSpraay("/batch-payment", req.body);
		res.json(result);
	} catch (error) {
		res.status(500).json({ error: "Failed to process batch payment" });
	}
});

// Token transfer
app.post("/token-transfer", async (req, res) => {
	try {
		const result = await proxyToSpraay("/token-transfer", req.body);
		res.json(result);
	} catch (error) {
		res.status(500).json({ error: "Failed to process token transfer" });
	}
});

// Payroll
app.post("/payroll", async (req, res) => {
	try {
		const result = await proxyToSpraay("/payroll", req.body);
		res.json(result);
	} catch (error) {
		res.status(500).json({ error: "Failed to process payroll" });
	}
});

// AI Inference
app.post("/ai/inference", async (req, res) => {
	try {
		const result = await proxyToSpraay("/ai/inference", req.body);
		res.json(result);
	} catch (error) {
		res.status(500).json({ error: "Failed to run AI inference" });
	}
});

// RTP – Robot Task Protocol
app.post("/rtp/task", async (req, res) => {
	try {
		const result = await proxyToSpraay("/rtp/task", req.body);
		res.json(result);
	} catch (error) {
		res.status(500).json({ error: "Failed to submit robot task" });
	}
});

// Discovery – list all endpoints
app.get("/discover", (_req, res) => {
	res.json({
		name: "Spraay x402 Gateway",
		description:
			"Multi-chain batch payment protocol + AI inference + Robot Task Protocol (RTP). 76+ endpoints across 13 chains.",
		version: "3.5.0",
		docs: "https://docs.spraay.app",
		mcp_server: "npm: @plagtech/spraay-x402-mcp",
		categories: [
			{ id: 1, name: "Batch Payments", endpoints: 8, price: "$0.01" },
			{ id: 2, name: "Token Swaps", endpoints: 6, price: "$0.01" },
			{ id: 3, name: "Bridge", endpoints: 4, price: "$0.05" },
			{ id: 4, name: "Token Transfers", endpoints: 6, price: "$0.01" },
			{ id: 5, name: "NFT Operations", endpoints: 5, price: "$0.01" },
			{ id: 6, name: "Payroll", endpoints: 4, price: "$0.05" },
			{ id: 7, name: "Escrow", endpoints: 4, price: "$0.05" },
			{ id: 8, name: "Governance", endpoints: 4, price: "$0.01" },
			{ id: 9, name: "Oracle", endpoints: 4, price: "$0.005" },
			{ id: 10, name: "DeFi Analytics", endpoints: 5, price: "$0.01" },
			{ id: 11, name: "Gas Optimization", endpoints: 3, price: "$0.005" },
			{ id: 12, name: "ENS", endpoints: 3, price: "$0.01" },
			{ id: 13, name: "AI Inference", endpoints: 6, price: "$0.03" },
			{ id: 14, name: "Agent Utilities", endpoints: 5, price: "$0.01" },
			{ id: 15, name: "Robot Task Protocol", endpoints: 8, price: "$0.05" },
			{ id: 16, name: "Staking", endpoints: 4, price: "$0.01" },
			{ id: 17, name: "Agent Wallets", endpoints: 7, price: "$0.01" },
		],
		chains: [
			"Base",
			"Ethereum",
			"Arbitrum",
			"Polygon",
			"BNB Chain",
			"Avalanche",
			"Unichain",
			"Plasma",
			"BOB",
			"Solana",
			"Bittensor",
			"Stacks",
			"Bitcoin",
		],
		payment_address: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8",
	});
});

// ---------------------------------------------------------
// Start
// ---------------------------------------------------------
app.listen(Number(PORT), () => {
	console.log(`\n💧 Spraay x402 Gateway Example`);
	console.log(`   Server:      http://localhost:${PORT}`);
	console.log(`   Pay to:      ${PAY_TO_ADDRESS}`);
	console.log(`   Network:     ${NETWORK}`);
	console.log(`   Facilitator: ${FACILITATOR_URL}`);
	console.log(`   Spraay API:  ${SPRAAY_GATEWAY_URL}\n`);
	console.log(`   Endpoints:`);
	console.log(`     POST /batch-payment   $0.01  – Multi-recipient USDC sends`);
	console.log(`     POST /token-transfer  $0.01  – ERC-20 transfers`);
	console.log(`     POST /payroll         $0.05  – Recurring crypto payroll`);
	console.log(`     POST /ai/inference    $0.03  – AI model inference`);
	console.log(`     POST /rtp/task        $0.05  – Hire a robot (RTP)`);
	console.log(`     GET  /discover        free   – Endpoint discovery\n`);
});
