"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { CodeSnippet } from "./CodeSnippet";
import { HeroIllustration } from "./HeroIllustration";
import { X402Logo } from "./Logo";
import { BrandSet, StatItem, STATIC_STATS } from "./StatsSection";
import { textStagger, fadeInUp } from "@/lib/animations";

interface HeroSectionProps {
  codeSnippet: {
    code: string;
    copyCode?: string;
    title: string;
    description: string;
  };
}

export function HeroSection({ codeSnippet }: HeroSectionProps) {
  return (
    <section className="hero-section max-w-container mx-auto px-4 sm:px-6 md:px-10 pt-8 md:pt-10 pb-12 sm:pb-16 md:pb-20 overflow-x-clip">
      <div className="hero-flex-row flex flex-col lg:flex-row gap-8 md:gap-12 lg:gap-8">
        {/* Animated left column */}
        <motion.div
          className="hero-left-col flex-1 min-w-0 flex flex-col gap-4"
          variants={textStagger}
          initial="initial"
          animate="animate"
        >
          <motion.div variants={fadeInUp} className="flex items-baseline gap-4">
            <X402Logo className="h-[49px] w-auto" />
            <span className="text-base font-medium">Payment Required</span>
          </motion.div>

          <motion.p
            variants={fadeInUp}
            className="text-sm sm:text-base font-medium text-gray-70 leading-relaxed max-w-[600px]"
          >
            x402 is an open, neutral standard for internet-native payments. It absolves the
            Internet's original sin by natively making payments possible between clients and
            servers, creating win-win economies that empower agentic payments at scale. x402 exists
            to build a more free and fair internet.
          </motion.p>

          <motion.div variants={fadeInUp} className="w-full max-w-[1040px] mt-4">
            <CodeSnippet
              title={codeSnippet.title}
              code={codeSnippet.code}
              copyCode={codeSnippet.copyCode}
              description={codeSnippet.description}
            />
          </motion.div>

          <motion.div variants={fadeInUp}>
            <Link href="/ecosystem" className="block" aria-label="View ecosystem partners">
              <p className="text-xs font-medium text-gray-40 uppercase tracking-wide mb-4">
                Trusted by
              </p>
              <div className="overflow-hidden [--gap:2.5rem] sm:[--gap:3rem] md:[--gap:4rem] [mask-image:linear-gradient(to_right,transparent,black_10%,black_90%,transparent)]">
                <div className="flex [gap:var(--gap)]">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <BrandSet key={i} />
                  ))}
                </div>
              </div>
            </Link>
          </motion.div>

          {/* Stats pinned to the bottom of the left column — desktop only */}
          <div className="mt-auto hidden xl:block pt-8" aria-label="Platform statistics">
            <p className="text-xs font-medium text-gray-40 uppercase tracking-wide mb-4">
              Last 30 days
            </p>
            <div className="flex flex-wrap items-end gap-6 sm:gap-8 md:gap-16 lg:gap-20">
              <StatItem value={STATIC_STATS.transactions} label="Transactions" />
              <StatItem value={STATIC_STATS.volume} label="Volume" />
              <StatItem value={STATIC_STATS.buyers} label="Buyers" />
              <StatItem value={STATIC_STATS.sellers} label="Sellers" />
            </div>
          </div>
        </motion.div>

        <div className="hero-illustration-col">
          <HeroIllustration />
        </div>
      </div>
    </section>
  );
}
