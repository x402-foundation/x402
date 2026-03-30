"use client";

import Link from "next/link";
import Image from "next/image";

const brands = [
  { name: "Stripe", logo: "/logos/stripe-mono.svg" },
  { name: "AWS", logo: "/logos/aws.-mono.svg", className: "h-8" },
  { name: "Messari", logo: "/logos/messari-mono.svg" },
  { name: "Alchemy", logo: "/logos/alchemy-mono.svg" },
  { name: "Nansen", logo: "/logos/nansen-mono.svg" },
  { name: "Vercel", logo: "/logos/vercel-mono.svg" },
  { name: "Cloudflare", logo: "/logos/cloudflare-mono.svg", className: "h-7" },
  { name: "World", logo: "/logos/world-mono.svg" },
];

function BrandSet() {
  return (
    <div className="flex shrink-0 items-center [gap:var(--gap)] animate-marquee">
      {brands.map((brand) => (
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

export function BrandScroller() {
  return (
    <Link
      href="/ecosystem"
      className="block cursor-pointer my-10 sm:my-14"
      aria-label="View ecosystem partners"
    >
      <p className="text-sm tracking-wide text-gray-40 uppercase pb-6 px-4 sm:px-6 md:px-10 max-w-container mx-auto">
        Adopted by
      </p>
      <div className="w-full overflow-hidden pb-4 sm:pb-5 [--gap:2.5rem] sm:[--gap:3rem] md:[--gap:4rem] [mask-image:linear-gradient(to_right,transparent,black_10%,black_90%,transparent)]">
        <div className="flex [gap:var(--gap)]">
          {Array.from({ length: 4 }).map((_, i) => (
            <BrandSet key={i} />
          ))}
        </div>
      </div>
    </Link>
  );
}
