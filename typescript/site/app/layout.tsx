import type { Metadata, Viewport } from "next";
import { Inter, DM_Mono, Inconsolata, Instrument_Serif } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const dmMono = DM_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

const inconsolata = Inconsolata({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-code-ui",
});

const instrumentSerif = Instrument_Serif({
  weight: ["400"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "x402 - Payment Required | Internet-Native Payments Standard",
  description:
    "x402 is the internet's payment standard. An open standard for internet-native payments that empowers agentic payments at scale. Build a more free and fair internet.",
  openGraph: {
    title: "x402 - Payment Required",
    description: "x402 is the internet's payment standard for agentic payments at scale.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${dmMono.variable} ${instrumentSerif.variable} ${inconsolata.variable}`}
    >
      <head>
        <link rel="icon" type="image/svg+xml" href="/images/icons/x_group8.svg" />
        <link rel="apple-touch-icon" href="/images/icons/x_group8.png" />
        <meta name="apple-mobile-web-app-title" content="x402" />
        <link rel="manifest" href="/site.webmanifest" />
      </head>
      <body className="antialiased bg-background text-foreground font-sans">
        <a href="#main-content" className="skip-to-content">
          Skip to main content
        </a>
        <main id="main-content">{children}</main>
        <Script id="webmcp" strategy="afterInteractive">{`
(function() {
  if (typeof navigator === 'undefined') return;
  var mc = navigator.modelContext;
  if (!mc) return;
  var tools = [
    {
      name: "get-x402-info",
      description: "Get information about the x402 internet-native payment protocol",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Topic to learn about",
            enum: ["overview", "how-it-works", "integration", "ecosystem"]
          }
        },
        required: ["topic"]
      },
      execute: function(inputs) {
        var info = {
          overview: "x402 is an open standard for internet-native payments using HTTP 402. It enables agents and services to pay for API access instantly with stablecoins. Zero fees, zero friction, zero centralization.",
          "how-it-works": "1. Client sends HTTP request. 2. Server responds with 402 Payment Required including price and payment details. 3. Client pays with stablecoins. 4. Client retries with payment proof. 5. Server verifies and grants access.",
          integration: "Install @x402/express or @x402/next, add paymentMiddleware to your server with endpoint pricing config. Supports Base, Ethereum, Arbitrum, and Solana networks with USDC.",
          ecosystem: "x402 has 250+ ecosystem partners including facilitators, wallets, and API providers. Visit x402.org/ecosystem to explore."
        };
        return Promise.resolve({ result: info[inputs.topic] || info.overview });
      }
    },
    {
      name: "navigate-x402",
      description: "Navigate to pages on x402.org",
      inputSchema: {
        type: "object",
        properties: {
          page: {
            type: "string",
            enum: ["home", "ecosystem", "blog"],
            description: "Page to navigate to"
          }
        },
        required: ["page"]
      },
      execute: function(inputs) {
        var urls = { home: "/", ecosystem: "/ecosystem", blog: "/writing/x402-v2-launch" };
        window.location.href = urls[inputs.page] || "/";
        return Promise.resolve({ navigated: inputs.page });
      }
    }
  ];
  if (typeof mc.registerTool === 'function') {
    tools.forEach(function(t) { mc.registerTool(t); });
  } else if (typeof mc.provideContext === 'function') {
    mc.provideContext({ tools: tools });
  }
})();
`}</Script>
      </body>
    </html>
  );
}
