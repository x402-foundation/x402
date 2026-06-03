export interface FacilitatorInfo {
  baseUrl: string;
  networks: string[];
  schemes: string[];
  assets: string[];
  addresses: {
    [key: string]: string[];
  };
  supports: {
    verify: boolean;
    settle: boolean;
    supported: boolean;
    list: boolean;
  };
}

export interface Partner {
  name: string;
  description: string;
  logoUrl: string; // Path to the logo, e.g., /images/ecosystem/logos/project-logo.png
  websiteUrl: string;
  category: string; // Main category name as defined in categories array
  typeLabel?: string;
  top_section?: boolean;
  // Additional fields like a slug for directory name can be added if needed for linking or lookup
  slug?: string;
  // Facilitator-specific data (only present for facilitators)
  facilitator?: FacilitatorInfo;
}

export interface CategoryInfo {
  id: string; // e.g., "client-side-integrations"
  name: string; // e.g., "Client-Side Integrations"
}

export interface FoundationMember {
  name: string;
  tier: "Premier" | "General";
  websiteUrl: string;
  logoUrl?: string;
  description?: string;
}

export interface ImplementationPath {
  title: string;
  description: string;
  href: string;
  cta: string;
}

// These categories will be used for filtering and can be referenced in partner metadata.json
export const categories: CategoryInfo[] = [
  {
    id: "client-side-integrations",
    name: "Client-Side Integrations",
  },
  {
    id: "services-endpoints",
    name: "Services/Endpoints",
  },
  {
    id: "ecosystem-infrastructure",
    name: "Infrastructure & Tooling",
  },
  {
    id: "learning-community",
    name: "Learning & Community Resources",
  },
  {
    id: "facilitators",
    name: "Facilitators",
  },
];

export const foundationMembers: FoundationMember[] = [
  {
    name: "Adyen",
    tier: "Premier",
    websiteUrl: "https://www.adyen.com",
    logoUrl: "/logos/adyen-cropped.svg",
    description:
      "Adyen joined the x402 Foundation to shape open, interoperable payment standards for agentic commerce, with a focus on the merchant outcomes that come from a shared protocol.",
  },
  {
    name: "Amazon",
    tier: "Premier",
    websiteUrl: "https://www.amazon.com",
  },
  {
    name: "American Express",
    tier: "Premier",
    websiteUrl: "https://www.americanexpress.com",
    logoUrl: "/logos/amex.png",
    description:
      "American Express joined the x402 Foundation as a Premier member, bringing a global card brand to the standard.",
  },
  {
    name: "Circle",
    tier: "Premier",
    websiteUrl: "https://www.circle.com",
    logoUrl: "/logos/circle.svg",
    description:
      "Circle issues USDC and built the Circle Agent Stack on x402 to power gas-free, sub-cent USDC payments for autonomous AI agents.",
  },
  { name: "Cloudflare", tier: "Premier", websiteUrl: "https://www.cloudflare.com" },
  { name: "Coinbase", tier: "Premier", websiteUrl: "https://www.coinbase.com" },
  {
    name: "Fiserv",
    tier: "Premier",
    websiteUrl: "https://www.fiserv.com",
    logoUrl: "/logos/Fiserv_logo.svg",
    description:
      "Fiserv joined the x402 Foundation as a Premier member to make agent-driven commerce adoptable by existing merchants without major re-engineering.",
  },
  {
    name: "Google",
    tier: "Premier",
    websiteUrl: "https://www.google.com",
    logoUrl: "/logos/google.png",
    description:
      "Google joined the x402 Foundation as a Premier member, aligning cloud and internet infrastructure with the standard.",
  },
  {
    name: "MasterCard",
    tier: "Premier",
    websiteUrl: "https://www.mastercard.com",
    logoUrl: "/logos/Mastercard-logo.svg",
    description:
      "Mastercard joined the x402 Foundation as a Premier member, adding card-network and payment infrastructure to the standard.",
  },
  {
    name: "Shopify",
    tier: "Premier",
    websiteUrl: "https://www.shopify.com",
    logoUrl: "/logos/shopify.svg",
    description:
      "Shopify joined the x402 Foundation as a Premier member, connecting the standard to commerce and merchant infrastructure.",
  },
  {
    name: "Solana",
    tier: "Premier",
    websiteUrl: "https://solana.com",
    logoUrl: "/logos/solana.svg",
    description:
      "Solana supports x402 with guides and infrastructure for fast, low-cost agent and API payments.",
  },
  { name: "Stripe", tier: "Premier", websiteUrl: "https://stripe.com" },
  {
    name: "Visa Inc.",
    tier: "Premier",
    websiteUrl: "https://usa.visa.com",
    logoUrl: "/logos/visa-logo.png",
    description:
      "Visa joined the x402 Foundation as a Premier member, putting the world's largest card network behind the standard.",
  },
  {
    name: "Aleo",
    tier: "General",
    websiteUrl: "https://aleo.org",
    logoUrl: "/logos/aleo.png",
    description:
      "Aleo joined the x402 Foundation as a General member, aligning privacy-oriented blockchain infrastructure with the standard.",
  },
  {
    name: "Fireblocks",
    tier: "General",
    websiteUrl: "https://www.fireblocks.com",
    logoUrl: "/logos/fireblocks.svg",
    description:
      "Fireblocks joined the x402 Foundation as a General member, bringing digital asset custody and stablecoin operations expertise to the standard.",
  },
  {
    name: "Kakaopay inc.",
    tier: "General",
    websiteUrl: "https://www.kakaopay.com",
    logoUrl: "/logos/kakaoPay.svg",
    description:
      "KakaoPay joined the x402 Foundation as a General member, bringing Korean fintech into the standard.",
  },
  {
    name: "Kite AI",
    tier: "General",
    websiteUrl: "https://www.gokite.ai",
    logoUrl: "/logos/Kite_Logo_Dark.svg",
    description:
      "Kite supports x402 with agent payment infrastructure built around budgets, permissions, and stablecoin-native settlement, with x402 protocol work backed by Coinbase Ventures.",
  },
  {
    name: "LayerZero Labs",
    tier: "General",
    websiteUrl: "https://layerzero.network",
    logoUrl: "/logos/LayerZero_logo.svg",
    description:
      "LayerZero Labs joined the x402 Foundation as a General member, adding cross-chain infrastructure to the standard.",
  },
  {
    name: "Merit Systems",
    tier: "General",
    websiteUrl: "https://meritsystems.com",
    logoUrl: "/logos/MeritLogo.svg",
    description:
      "Merit Systems builds x402 tooling for the ecosystem, including x402scan and x402email — discovery and consumption tools that help agents find and use paid resources.",
  },
  { name: "Polygon Labs Services", tier: "General", websiteUrl: "https://polygon.technology" },
  {
    name: "Quant Network",
    tier: "General",
    websiteUrl: "https://quant.network",
    logoUrl: "/logos/Quant Black Logo.svg",
    description:
      "Quant Network joined the x402 Foundation as a General member, bringing interoperability and programmable-money infrastructure to the standard.",
  },
  { name: "t54 labs", tier: "General", websiteUrl: "https://t54.io" },
  {
    name: "utexo",
    tier: "General",
    websiteUrl: "https://utexo.com",
    logoUrl: "/logos/utexo-logotype.svg",
    description:
      "utexo supports x402 with a release enabling USDT payments for the agent economy at near-instant settlement.",
  },
];

export const highlightedIntegrationSlugs = [
  "stripe",
  "cloudflare",
  "aws",
  "exa",
  "vercel",
  "venice",
  "alchemy",
  "nansen",
  "world",
];

export const discoveryDirectorySlugs = ["x402scan", "agentic-market", "pay-sh", "ampersend"];

export const implementationPaths: ImplementationPath[] = [
  {
    title: "Use a facilitator",
    description:
      "Start with providers that expose verify and settle endpoints for production x402 flows.",
    href: "/ecosystem?filter=facilitators",
    cta: "Browse facilitators",
  },
  {
    title: "Build from examples",
    description:
      "Use the maintained client, server, and middleware examples to add x402 to an existing app.",
    href: "https://github.com/x402-foundation/x402/tree/main/examples/typescript",
    cta: "View examples",
  },
  {
    title: "Read the protocol",
    description:
      "Understand the HTTP 402 flow, payment requirements, and facilitator interface before shipping.",
    href: "https://github.com/x402-foundation/x402",
    cta: "Open docs",
  },
];
