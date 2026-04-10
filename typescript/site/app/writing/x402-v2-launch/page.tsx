import Image from "next/image";
import type { Metadata } from "next";
import Link from "next/link";
import { NavBar } from "../../components/NavBar";
import { Footer } from "../../components/Footer";

const pageTitle = "Introducing x402 V2: Evolving the Standard for Internet-native Payments";
const pageDescription =
  "Building on six months of real-world use, x402 V2 expands the protocol beyond single-call, exact payments."
export const metadata: Metadata = {
  title: pageTitle,
  description: pageDescription,
  openGraph: {
    title: pageTitle,
    description: pageDescription,
    url: "/writing/x402-v2-launch",
    type: "article",
    images: [
      {
        url: "/images/blog_intro.png",
        width: 1600,
        height: 900,
        alt: "x402 V2 launch announcement hero",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: pageTitle,
    description: pageDescription,
    images: ["/images/blog_intro.png"],
  },
};

export default function X402V2LaunchPage() {
  return (
    <div className="min-h-screen bg-white text-black flex flex-col">
      <NavBar />

      <div className="flex-1">
        <article className="pb-20">
          {/* Header */}
          <header className="max-w-4xl mx-auto px-4 sm:px-6 md:px-10 lg:px-16 pt-12 sm:pt-16 md:pt-20">
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold leading-tight mb-4">
              Introducing x402 V2: Evolving the Standard for Internet-native Payments
            </h1>
            <p className="text-base text-gray-60 mb-2">December 11, 2025</p>
            <p className="text-base text-gray-60 mb-8">By: Erik Reppel, Carson Roscoe, Josh Nickerson</p>
          </header>

          {/* Hero Image */}
          <div className="max-w-5xl mx-auto px-4 sm:px-6 md:px-10 lg:px-16 mb-12">
            <div className="relative w-full overflow-hidden rounded-lg border border-gray-10">
              <Image
                src="/images/blog_intro.png"
                alt="x402 V2 protocol illustration"
                width={1600}
                height={900}
                priority
                className="w-full h-auto"
                sizes="100vw"
              />
            </div>
          </div>

          {/* Article Body (intro + why) */}
          <section className="max-w-4xl mx-auto px-4 sm:px-6 md:px-10 lg:px-16 space-y-8">
            {/* TL;DR */}
            <div className="space-y-4">
              <p className="text-base leading-relaxed text-gray-70">
                <strong>TL;DR</strong>: Building on six months of real-world use, x402 V2 expands the protocol beyond single-call, exact payments. It adds wallet-based identity (skip repaying on every call), automatic API discovery, dynamic payment recipients, support for more chains and fiat via CAIP standards, and a fully modular SDK for custom networks and schemes. All aimed at making x402 cleaner, more extensible, and future-proof, enabling unified payment models and wallet-based access for agents and humans alike.
              </p>
            </div>

            {/* Note */}
            <div className="bg-gray-50 border-l-4 border-gray-300 p-4 text-sm text-gray-70 italic">
              <strong className="not-italic">Note:</strong> This update comes after a 2 week community feedback period on the proposed V2 spec. Huge thanks to the builders, researchers, and teams across ecosystems who reviewed early drafts and shared feedback. x402 is stronger because of you. We&apos;re excited to share more updates on the protocol and the launch of the independent{" "}
              <Link href="https://www.coinbase.com/blog/coinbase-and-cloudflare-will-launch-x402-foundation" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                x402 Foundation
              </Link>{" "}
              soon. x402&apos;s reference SDKs are fully backward-compatible with V1.
            </div>

            {/* Why x402 needed a V2 */}
            <section className="space-y-4">
              <h2 className="text-2xl font-semibold mt-8">Why x402 needed a V2</h2>
              <p className="text-base leading-relaxed text-gray-70">
                x402 launched in May 2025 with a simple idea: embed payments directly into HTTP using the long-dormant 402 status code. In just a few months, it has processed over 100M payments across APIs, apps, and AI agents, powering everything from paid API calls to autonomous agents buying compute and data on-demand.
              </p>
              <p className="text-base leading-relaxed text-gray-70">
                V2 evolves the specification based on learnings from 6 months of x402 performing real-world payments:
              </p>
              <ul className="list-disc pl-5 space-y-2 text-base leading-relaxed text-gray-70">
                <li>Clearer separation between clients, servers, facilitators, and the x402 reference SDK</li>
                <li>Tweaks to the data type declarations to increase clarity, reduce redundancy, and make x402 easier to implement on new chains</li>
                <li>Formalizing the concept of &quot;Extensions&quot; to make it easier to experiment and extend x402 without the need to fork</li>
                <li>Moving all payment data to headers for the HTTP transport, freeing up response body to be used alongside a 402 status code and Payment Required header</li>
                <li>Bottoms up rewrite of the x402 reference SDK for a modular, composable architecture</li>
                <li>Migrating reference SDK to <code className="bg-green-100 px-1 rounded">@x402</code> npm org</li>
              </ul>
              <p className="text-base leading-relaxed text-gray-70">
                At the same time, the mission of x402 remained constant:
              </p>
              <p className="text-base leading-relaxed text-gray-70 font-semibold">
                Enable value to move across the internet as seamlessly as information, whether the actor is a human, an app, or an agent.
              </p>
              <p className="text-base leading-relaxed text-gray-70">
                x402 V2 is designed to meet the demands of this next stage of the internet economy. It refactors the protocol to be cleaner, more interoperable, and more future-proof, while preserving everything that made V1 successful.
              </p>
            </section>
          </section>

          {/* Layers Diagram - breakout width */}
          <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-10 lg:px-16 my-12">
            <div className="relative w-full overflow-hidden rounded-lg border border-gray-10">
              <Image
                src="/images/blog_x402_layers.png"
                alt="Diagram of x402 V2 protocol layers"
                width={1536}
                height={864}
                className="w-full h-auto"
                sizes="100vw"
              />
            </div>
          </div>

          {/* Article Body (what's new onward) */}
          <section className="max-w-4xl mx-auto px-4 sm:px-6 md:px-10 lg:px-16 space-y-8">
            {/* What's New */}
            <section className="space-y-4">
              <h2 className="text-2xl font-semibold mt-8">What&apos;s New</h2>
              <p className="text-base leading-relaxed text-gray-70">
                V2 is a major upgrade that makes the protocol more universal, more flexible, and easier to extend across networks, transports, identity models, and payment types. The spec is cleaner, more modular, and aligned with modern standards including CAIP and IETF header conventions, enabling a single interface for onchain and offchain payments.
              </p>
            </section>

            {/* 1. Unified payment interface */}
            <section className="space-y-4">
              <h3 className="text-xl font-semibold">1. Unified payment interface</h3>
              <p className="text-base leading-relaxed text-gray-70">
                x402 V2 standardizes how networks and assets are identified, creating a single payment format that works across chains and with legacy payment rails.
              </p>
              <p className="text-base leading-relaxed text-gray-70 font-medium">Key upgrades:</p>
              <ul className="list-disc pl-5 space-y-2 text-base leading-relaxed text-gray-70">
                <li><strong>Multi-chain by default</strong>: Supports stablecoins & tokens across Base, Solana, other chains, and new L2s, with no custom logic required</li>
                <li><strong>Compatible with legacy payment rails</strong>: Facilitators for ACH, SEPA, or card networks fit into the same payment model</li>
                <li><strong>Dynamic &apos;payTo&apos; routing</strong>: Per-request routing to addresses, roles, or callback-based payout logic – perfect for marketplaces and multi-tenant APIs. This also adds dynamic pricing based on inputs.</li>
                <li><strong>No breaking changes</strong>: New ways to evolve functionality in extensions, rather than modifying the spec</li>
              </ul>
              <p className="text-base leading-relaxed text-gray-70">
                <strong>So what</strong>: x402 becomes a flexible economic layer with usage-based, subscription-like, prepaid, and multi-step workflows all possible without changing your API architecture or upgrading the core spec.
              </p>
            </section>

            {/* 2. Extensible architecture */}
            <section className="space-y-4">
              <h3 className="text-xl font-semibold">2. Extensible architecture & broad compatibility</h3>
              <p className="text-base leading-relaxed text-gray-70">
                V2 introduces a clear separation between the protocol specification, its SDK implementation, and facilitators, making the protocol plug-in-driven and future-proof.
              </p>
              <p className="text-base leading-relaxed text-gray-70 font-medium">Key upgrades:</p>
              <ul className="list-disc pl-5 space-y-2 text-base leading-relaxed text-gray-70">
                <li><strong>Stable spec</strong>: Adding new chains or payment behaviors requires zero changes to the standard of reference SDKs.</li>
                <li><strong>Plugin-driven SDK</strong>: Developers register chains, assets, and payment schemes instead of editing SDK internals.</li>
                <li><strong>Lifecycle hooks</strong>: Enable builders to inject custom logic at key points in the payment flow (e.g. before/after sending a payment, before/after settlement verification). This unlocks conditional payment routing, custom metrics, complex failure recovery mechanisms, and more.</li>
                <li>
                  <strong>Modernized HTTP headers</strong>:
                  <ul className="list-disc pl-5 mt-2 space-y-1">
                    <li>Removes deprecated X-* headers for improved compatibility</li>
                    <li>Uses more modern PAYMENT-SIGNATURE, PAYMENT-REQUIRED, PAYMENT-RESPONSE</li>
                    <li><em>[coming very soon]</em> New SIGN-IN-WITH-X header</li>
                  </ul>
                </li>
              </ul>
              <p className="text-base leading-relaxed text-gray-70">
                <strong>So what</strong>: x402 V2 becomes a plug-and-play platform. Anyone can add a new chain, facilitator, or payment model as a standalone package, without the overhead and coordination of modifying the underlying protocol.
              </p>
            </section>

            {/* 3. Wallet-based access */}
            <section className="space-y-4">
              <h3 className="text-xl font-semibold">3. Wallet-based access, reusable sessions, and modular paywalls</h3>
              <p className="text-base leading-relaxed text-gray-70">
                V2 refactors key components related to identity and access, setting the stage for more efficient session management and making the server-side architecture highly flexible.
              </p>
              <p className="text-base leading-relaxed text-gray-70 font-medium">Key upgrades:</p>
              <ul className="list-disc pl-5 space-y-2 text-base leading-relaxed text-gray-70">
                <li><strong>Modular Paywall Package</strong>: The paywall has been completely overhauled and extracted into a dedicated, modular package: <code className="bg-green-100 px-1 rounded">@x402/paywall</code>. This allows developers to easily contribute new payment backends and create custom paywall variations (with built-in support for EVM and Solana).</li>
                <li><strong>Foundation for Reusable Access</strong>: The V2 protocol now includes the logic to support wallet-controlled sessions or other forms of identity, allowing clients to <strong>skip the full payment flow</strong> and the need for <strong>onchain interactions for repeated access</strong> if the resource was previously purchased.</li>
                <li><strong>Enables Subscription and Session Patterns</strong>: This architecture makes subscription-like or session-based access patterns possible for both human users and autonomous agents.</li>
              </ul>
              <p className="text-base leading-relaxed text-gray-70">
                <strong>Note on Sign-In-With-X (SIWx)</strong>: The full wallet-based identity feature, including the dedicated Sign-In-With-X (SIWx) header (based on CAIP-122), will be an immediate fast-follow launch item. This finalizes the first extensions for proving wallet control to access reusable sessions.
              </p>
              <p className="text-base leading-relaxed text-gray-70">
                <strong>So what</strong>: This combination improves the server-side developer experience and unlocks the core benefits of lower latency, fewer round-trips, and cheaper repeated calls. These efficiencies make x402 viable for high-frequency workloads like LLM inference, multi-call agents, and complex applications where paying per request would be too slow or expensive.
              </p>
            </section>

            {/* 4. Automatic discovery */}
            <section className="space-y-4">
              <h3 className="text-xl font-semibold">4. Automatic discovery & dynamic service metadata</h3>
              <p className="text-base leading-relaxed text-gray-70">
                V2&apos;s Discovery extension lets x402-enabled services expose structured metadata that facilitators can crawl.
              </p>
              <p className="text-base leading-relaxed text-gray-70 font-medium">Key upgrades:</p>
              <ul className="list-disc pl-5 space-y-2 text-base leading-relaxed text-gray-70">
                <li>Facilitators automatically index available endpoints</li>
                <li>Pricing, routes, and metadata stay up-to-date automatically</li>
                <li>No manual updates or hardcoded catalogs</li>
              </ul>
              <p className="text-base leading-relaxed text-gray-70">
                <strong>So what</strong>: The Discovery extension creates a more autonomous ecosystem in which sellers publish their APIs once, and facilitators stay synchronized without developer intervention.
              </p>
            </section>

            {/* 5. Improved developer experience */}
            <section className="space-y-4">
              <h3 className="text-xl font-semibold">5. Improved developer experience & multi-facilitator support</h3>
              <p className="text-base leading-relaxed text-gray-70">
                V2 dramatically simplifies configuration while making multi-facilitator support first-class.
              </p>
              <p className="text-base leading-relaxed text-gray-70 font-medium">Key upgrades:</p>
              <ul className="list-disc pl-5 space-y-2 text-base leading-relaxed text-gray-70">
                <li>Register supported chains, assets, and payment models; no internal SDK hacking</li>
                <li>Express business preferences (&quot;prefer Solana,&quot; &quot;avoid mainnet,&quot; &quot;only use USDC&quot;)</li>
                <li>Use multiple facilitators simultaneously; the SDK chooses the best match</li>
                <li>Cleaner filtering and selection logic for complex payment environments</li>
              </ul>
              <p className="text-base leading-relaxed text-gray-70">
                <strong>So what</strong>: Developers write less glue code and more business logic. The SDK handles the complexity of chain selection, facilitator discovery, payment routing, and scheme selection.
              </p>
            </section>

            {/* Try it out */}
            <section className="space-y-4">
              <h2 className="text-2xl font-semibold mt-8">Try it out</h2>
              <p className="text-base leading-relaxed text-gray-70">
                V2 of the x402 protocol represents the next step in making value move across the internet as easily as information. By expanding compatibility, simplifying the developer experience, and enabling new payment and identity models, V2 turns x402 into a more flexible layer for human, app, and agent-driven payments. We&apos;re excited to see what builders create as the ecosystem grows.
              </p>
              <p className="text-base leading-relaxed text-gray-70">
                You can check out the repo{" "}
                <Link href="https://github.com/x402-foundation/x402" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                  here
                </Link>{" "}
                or{" "}
                <Link href="https://t.me/+ijgZ6c_f0iA1MmY5" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                  join the telegram group
                </Link>{" "}
                to connect with 600+ other builders.
              </p>
            </section>
          </section>
        </article>
      </div>

      <Footer />
    </div>
  );
}
