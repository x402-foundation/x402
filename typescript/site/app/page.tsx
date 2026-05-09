import Link from "next/link";
import Image from "next/image";

import { NavBar } from "./components/NavBar";
import { Footer } from "./components/Footer";
import {
  FeatureCard,
  ZeroFeesIcon,
  ZeroWaitIcon,
  ZeroFrictionIcon,
  ZeroCentralizationIcon,
  ZeroRestrictionsIcon,
} from "./components/FeatureCard";
import { StatsSection } from "./components/StatsSection";
import { FAQ } from "./components/FAQ";
import { ComparisonTable } from "./components/ComparisonTable";
import { HTTPNativeSection } from "./components/HTTPNativeSection";
import { HeroSection } from "./components/HeroSection";
import { WhatsX402Section } from "./components/WhatsX402Section";
import { AnimatedSectionHeader } from "./components/AnimatedSectionHeader";

function ArrowIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M10.1773 14.2771L14.027 10.4274L14.027 9.57256L10.1773 5.72284L11.1852 4.71494L15.4524 8.98216L15.4524 11.0178L11.1852 15.285L10.1773 14.2771Z"
        fill="currentColor"
      />
      <path
        d="M4.54758 9.45634C4.54758 9.36899 4.64792 9.29819 4.77171 9.29819H14.0703C14.1941 9.29819 14.2945 9.36899 14.2945 9.45633V10.5633C14.2945 10.6507 14.1941 10.7215 14.0703 10.7215H4.77171C4.64792 10.7215 4.54758 10.6507 4.54758 10.5633V9.45634Z"
        fill="currentColor"
      />
    </svg>
  );
}

const traditionalSteps = [
  {
    number: "1",
    title: "Create account with new API provider",
    description: "Time consuming setup",
  },
  {
    number: "2",
    title: "Add payment method to API provider",
    description: "KYC required, delaying access and requiring approval",
  },
  {
    number: "3",
    title: "Buy credits or subscription",
    description: "Prepaid commitment → overpay or run out of funds",
  },
  {
    number: "4",
    title: "Manage API key",
    description: "Security risk → must store and rotate keys",
  },
  {
    number: "5",
    title: "Make payment",
    description: "Slow transactions, chargebacks, fees",
  },
];

const x402Steps = [
  {
    number: "1",
    title: "AI agent sends HTTP request and receives 402: Payment Required",
    description: "No account setup, instant onboarding",
  },
  {
    number: "2",
    title: "AI agent pays instantly with stablecoins",
    description: "No signups or approvals required",
  },
  {
    number: "3",
    title: "API access granted",
    description: "No API key management and related security risks",
  },
];

const heroCodeSnippet = {
  code: `app.use(paymentMiddleware({
  "GET /weather": {
    accepts: [...],                 // As many networks / schemes as you want to support
    description: "Weather data",    // What your endpoint does
  },
}));`,
  copyCode: `app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [...],                 // As many networks / schemes as you want to support
        description: "Weather data",    // What your endpoint does
      },
    },
  )
);`,
  title: "Accept payments with a single line of code",
  description:
    "That's it. Add one line of code to require payment for each incoming request. If a request arrives without payment, the server responds with HTTP 402, prompting the client to pay and retry.",
};

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-black">
      <NavBar animateLogo />

      <HeroSection codeSnippet={heroCodeSnippet} />

      {/* Stats & Social Proof — hidden on xl where stats live inside HeroSection */}
      <div className="xl:hidden">
        <StatsSection />
      </div>

      {/* What's x402? */}
      <WhatsX402Section />

      <HTTPNativeSection />

      {/* Five Features Grid */}
      <section className="bg-[#F5F6FA] py-16 md:py-20" aria-label="Key features">
        <div className="max-w-container mx-auto px-4 sm:px-6 md:px-10 lg:px-16">
          <h2 className="text-xl sm:text-2xl font-medium text-center mb-8 sm:mb-12 md:mb-14">
            It&apos;s how the internet should be: open, free, and effortless
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6 md:gap-8 lg:gap-10">
            <FeatureCard
              icon={<ZeroFeesIcon />}
              title="Zero protocol fees"
              description="x402 is free for the customer and the merchant—just pay nominal payment network fees"
            />
            <FeatureCard
              icon={<ZeroWaitIcon />}
              title="Zero wait"
              description="Money moves at the speed of the internet"
            />
            <FeatureCard
              icon={<ZeroFrictionIcon />}
              title="Zero friction"
              description="No accounts or personal information needed"
            />
            <FeatureCard
              icon={<ZeroCentralizationIcon />}
              title="Zero centralization"
              description="Anyone on the internet can build on or extend x402"
            />
            <FeatureCard
              icon={<ZeroRestrictionsIcon />}
              title="Zero restrictions"
              description="x402 is a neutral standard, not tied to any specific network"
            />
          </div>
        </div>
      </section>

      {/* Comparison Section */}
      <section className="py-16 md:py-20 bg-white">
        <div className="max-w-[1177px] mx-auto px-4 sm:px-6 md:px-10">
          <AnimatedSectionHeader
            title="We need a new way to transfer value on the internet..."
            description="The old way of doing payments is barely working for a human world, let alone an agentic future. x402 does in moments what existing systems can't do at all."
            align="center"
            className="mb-12 md:mb-16 lg:mb-20"
            maxDescriptionWidth="635px"
            descriptionSize="small"
          />

          <ComparisonTable traditionalSteps={traditionalSteps} x402Steps={x402Steps} />
        </div>
      </section>

      {/* Building Better Section */}
      <section className="py-16 md:py-20">
        <div className="max-w-container mx-auto px-4 sm:px-6 md:px-10">
          <AnimatedSectionHeader
            title="...so it's time to start building something better"
            align="center"
            className="mb-10 sm:mb-12 md:mb-16"
          />

          <div className="mb-12">
            <div
              className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4 lg:h-[425px]"
              aria-label="Community photos"
            >
              <div className="col-span-1 relative rounded overflow-hidden">
                <Image
                  src="/images/homepage_build1.jpeg"
                  alt="Developer working on code"
                  fill
                  className="object-cover"
                  sizes="(max-width: 768px) 100vw, 20vw"
                />
              </div>
              <div className="col-span-2 relative rounded overflow-hidden">
                <Image
                  src="/images/homepage_build2.jpeg"
                  alt="Team collaborating on project"
                  fill
                  className="object-cover"
                  sizes="(max-width: 768px) 100vw, 40vw"
                />
              </div>
              <div className="col-span-1 relative rounded overflow-hidden">
                <Image
                  src="/images/homepage_build3.jpeg"
                  alt="Developer at workstation"
                  fill
                  className="object-cover"
                  sizes="(max-width: 768px) 100vw, 20vw"
                />
              </div>
              <div className="col-span-1 relative rounded overflow-hidden">
                <Image
                  src="/images/homepage_build4.png"
                  alt="Community of builders"
                  fill
                  className="object-cover"
                  sizes="(max-width: 768px) 100vw, 20vw"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col items-center gap-4 sm:gap-6">
            <p className="text-sm sm:text-base font-medium text-center max-w-[491px]">
              Join a global community of thousands of builders contributing to an open codebase,
              faster financial system, and freer internet.
            </p>
            <Link
              href="https://docs.x402.org/getting-started/quickstart-for-sellers"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-6 sm:px-10 md:px-16 py-3 bg-black text-white font-medium text-base hover:bg-gray-800 transition-colors focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2"
            >
              Learn how to get started
              <ArrowIcon />
            </Link>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <FAQ />

      <Footer />
    </div>
  );
}
