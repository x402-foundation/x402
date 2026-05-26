"use client";

import Link from "next/link";
import Image from "next/image";

interface StatsData {
  transactions: string;
  volume: string;
  buyers: string;
  sellers: string;
}

export const STATIC_STATS: StatsData = {
  transactions: "75.41M",
  volume: "$24.24M",
  buyers: "94.06K",
  sellers: "22K",
};

interface StatItemProps {
  value: string;
  label: string;
}

export function StatItem({ value, label }: StatItemProps) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="text-3xl sm:text-4xl md:text-[56px] font-display leading-none tracking-tighter text-black">
        {value}
      </div>
      <div className="text-xs sm:text-sm font-medium text-gray-40">{label}</div>
    </div>
  );
}

export const brands = [
  { name: "Stripe", logo: "/logos/stripe-mono.svg" },
  { name: "AWS", logo: "/logos/aws.-mono.svg", className: "h-8" },
  { name: "Messari", logo: "/logos/messari-mono.svg" },
  { name: "Alchemy", logo: "/logos/alchemy-mono.svg" },
  { name: "Nansen", logo: "/logos/nansen-mono.svg" },
  { name: "Vercel", logo: "/logos/vercel-mono.svg" },
  { name: "Cloudflare", logo: "/logos/cloudflare-mono.svg", className: "h-7" },
  { name: "World", logo: "/logos/world-mono.svg" },
  { name: "Quicknode", logo: "/logos/quicknode-mono.svg", className: "h-7" },
];

export function BrandSet() {
  return (
    <div className="flex shrink-0 items-center [gap:var(--gap)] animate-marquee">
      {brands.map(brand => (
        <Image
          key={brand.name}
          src={brand.logo}
          alt={brand.name}
          width={120}
          height={32}
          className={`w-auto brightness-0 opacity-70 hover:brightness-100 hover:opacity-100 transition-all duration-300 shrink-0 ${brand.className || "h-6"}`}
        />
      ))}
    </div>
  );
}

export function StatsSection() {
  return (
    <section
      className="max-w-container mx-auto px-4 sm:px-6 md:px-10 py-10 sm:py-12 md:py-14 xl:pt-4 xl:pb-14"
      aria-label="Platform statistics"
    >
      <p className="text-xs font-medium text-gray-40 uppercase tracking-wide mb-4">Last 30 days</p>
      <div className="flex flex-wrap items-end gap-6 sm:gap-8 md:gap-16 lg:gap-20">
        <StatItem value={STATIC_STATS.transactions} label="Transactions" />
        <StatItem value={STATIC_STATS.volume} label="Volume" />
        <StatItem value={STATIC_STATS.buyers} label="Buyers" />
        <StatItem value={STATIC_STATS.sellers} label="Sellers" />
      </div>
    </section>
  );
}
