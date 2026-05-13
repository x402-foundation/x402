import Image from "next/image";
import type { Metadata } from "next";
import Link from "next/link";
import { NavBar } from "../../components/NavBar";
import { Footer } from "../../components/Footer";

const pageTitle = "Introducing x402 Batch Settlement: High-velocity Agentic Commerce";
const pageDescription =
  "The x402 protocol is introducing batch settlement, enabling agents to transact at extremely low latency and fractions of a cent.";

export const metadata: Metadata = {
  title: pageTitle,
  description: pageDescription,
  openGraph: {
    title: pageTitle,
    description: pageDescription,
    url: "/writing/x402-batch-settlement",
    type: "article",
    images: [
      {
        url: "/images/x402-batch-settlement-hero.png",
        width: 2730,
        height: 1536,
        alt: "x402 batch settlement announcement hero",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: pageTitle,
    description: pageDescription,
    images: ["/images/x402-batch-settlement-hero.png"],
  },
};

export default function X402BatchSettlementPage() {
  return (
    <div className="min-h-screen bg-white text-black flex flex-col">
      <NavBar />

      <div className="flex-1">
        <article className="pb-20">
          <header className="max-w-4xl mx-auto px-4 sm:px-6 md:px-10 lg:px-16 pt-12 sm:pt-16 md:pt-20">
            <p className="text-sm mb-4">
              <Link href="/writing" className="text-blue-600 hover:underline">
                Back to Writing
              </Link>
            </p>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold leading-tight mb-4">
              Introducing x402 Batch Settlement: High-velocity Agentic Commerce
            </h1>
            <p className="text-base text-gray-60 mb-2">May 11, 2026</p>
            <p className="text-base text-gray-60 mb-8">
              By: Philippe d&apos;Argent, Carson Roscoe, Conner Swenberg, Josh Nickerson
            </p>
          </header>

          <div className="max-w-5xl mx-auto px-4 sm:px-6 md:px-10 lg:px-16 mb-12">
            <div className="relative w-full overflow-hidden rounded-lg border border-gray-10">
              <Image
                src="/images/x402-batch-settlement-hero.png"
                alt="x402 batch settlement hero illustration"
                width={2730}
                height={1536}
                priority
                className="w-full h-auto"
                sizes="100vw"
              />
            </div>
          </div>

          <section className="max-w-4xl mx-auto px-4 sm:px-6 md:px-10 lg:px-16 space-y-8">
            <div className="space-y-4">
              <p className="text-base leading-relaxed text-gray-70">
                <strong>TL;DR</strong>: The x402 protocol is introducing batch settlement, enabling agents to
                transact at extremely low latency and fractions of a cent. Agents provide cryptographic vouchers
                that enable sellers to settle in bulk, reducing overhead. Batch settlement lets agents perform
                thousands of granular interactions while maintaining the economic efficiency of a single
                transaction. It brings the speed of HTTP to x402 payments, creating a scalable foundation for the
                agentic economy.
              </p>
            </div>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold mt-8">The Evolution: Beyond One-to-One Settlement</h2>
              <p className="text-base leading-relaxed text-gray-70">
                x402 was built to make HTTP-native payments a standard: pay for an API using the 402 Payment
                Required status code and a structured envelope. It&apos;s the ideal architecture for autonomous
                agents: no UIs, no silos, just machine-to-machine value transfer.
              </p>
              <p className="text-base leading-relaxed text-gray-70">
                However, as we move toward high-frequency interactions per tool call, per token, or per kilobyte,
                the unit economics require a more sophisticated approach. While blockchains charge per transaction,
                the internet thrives on per-request agility. To bridge this gap, x402 is introducing batch
                settlement.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold mt-8">
                Efficiency by Design: Decoupling Authorization from Settlement
              </h2>
              <p className="text-base leading-relaxed text-gray-70">
                Batch settlement separates the intent to pay from the onchain finality:
              </p>
              <ul className="list-disc pl-5 space-y-2 text-base leading-relaxed text-gray-70">
                <li>
                  <strong>At request time</strong>: The buyer provides a proof of authorization that is
                  near-instant to verify.
                </li>
                <li>
                  <strong>At scale</strong>: Value moves onchain only when it is economically optimal, amortized
                  across hundreds or thousands of interactions.
                </li>
              </ul>
              <p className="text-base leading-relaxed text-gray-70">
                This is a core protocol scheme, not a vendor-specific feature. It brings the efficiency of payment
                channels directly into the x402 envelope.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold mt-8">How Batch Settlement Works</h2>
              <p className="text-base leading-relaxed text-gray-70">
                Batch settlement is optimized for high-volume micro-transactions:
              </p>
              <ul className="list-disc pl-5 space-y-2 text-base leading-relaxed text-gray-70">
                <li>
                  <strong>Capital commitment</strong>: The buyer opens a session by committing funds (for example
                  an EVM escrow or channel).
                </li>
                <li>
                  <strong>The hot path</strong>: Every HTTP interaction includes a cryptographic voucher, a
                  cumulative &quot;I owe you&quot; that increments with usage.
                </li>
                <li>
                  <strong>Cheap verification</strong>: The seller verifies these vouchers via simple signature math,
                  with no chain lookups required during the request, and serves the resource immediately.
                </li>
                <li>
                  <strong>Amortized redemption</strong>: The seller settles onchain in bulk. Many logical payments
                  are compressed into a single transaction.
                </li>
              </ul>
              <p className="text-base leading-relaxed text-gray-70">
                The result? You keep the granularity of per-request pricing without the friction of per-request gas
                or Facilitator fees.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold mt-8">Dynamic Pricing, Static Overhead</h2>
              <p className="text-base leading-relaxed text-gray-70">
                Real-world APIs aren&apos;t always flat-rate. Inference, data processing, and compute vary based on
                LLM tokens, data sizes, and milliseconds. Batch settlement handles this natively by building on the
                &quot;up to&quot; mental model:
              </p>
              <ul className="list-disc pl-5 space-y-2 text-base leading-relaxed text-gray-70">
                <li>The 402 header can advertise a ceiling for each interaction in a batch.</li>
                <li>The seller captures only the actual usage against the batch&apos;s escrow.</li>
              </ul>
              <p className="text-base leading-relaxed text-gray-70">
                Unlike standard &quot;up to&quot; payments, which typically settle individually, batch settlement lets
                these &quot;up to&quot; authorizations accumulate silently until it&apos;s time to finalize the
                batch.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold mt-8">Why This is the &quot;Agent&quot; Tier</h2>
              <p className="text-base leading-relaxed text-gray-70">
                Agents are loops: Plan → Act → Pay → Observe. If every &quot;Act&quot; requires an onchain
                settlement, the overhead grows linearly with the agent&apos;s complexity.
              </p>
              <p className="text-base leading-relaxed text-gray-70">
                Batch settlement shifts that cost. The dominant expense moves toward the session or the day, rather
                than the individual call. This keeps the seller protected with signed commitments while allowing the
                agent to spin through loops at the speed of HTTP.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold mt-8">Trust Without Hand-Waving</h2>
              <p className="text-base leading-relaxed text-gray-70">
                Efficiency doesn&apos;t mean sacrificing sovereignty. The x402 batch-settlement spec (and its EVM
                implementations) defines clear exit ramps. Escrow is explicit, limits are cryptographically signed,
                and buyers retain defined refund and withdrawal semantics. It&apos;s a trust-minimized architecture
                designed for a permissionless web.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold mt-8">Getting Started</h2>
              <p className="text-base leading-relaxed text-gray-70">
                The protocol remains open and neutral. Support for the batch-settlement machinery is currently
                available in the TypeScript and Go SDKs, with Python support in development. For more detail, check
                out the docs:{" "}
                <Link
                  href="https://docs.x402.org/schemes/batch-settlement"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  docs.x402.org/schemes/batch-settlement
                </Link>
                .
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold mt-8">The Bottom Line</h2>
              <p className="text-base leading-relaxed text-gray-70">
                x402&apos;s mission is to make internet-native commerce &quot;boring&quot;: standardized, reliable,
                and predictable. While the exact and &quot;up to&quot; schemes cover immediate, discrete transfers,
                batch settlement provides the economic rails for the next generation of high-density agentic markets.
                It tackles the fundamental trade-off of the machine economy: maximizing the integrity of the promise
                while minimizing the cost of the proof.
              </p>
            </section>
          </section>
        </article>
      </div>

      <Footer />
    </div>
  );
}