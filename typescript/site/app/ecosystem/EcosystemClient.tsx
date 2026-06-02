"use client";

import { useMemo } from "react";
import Image from "next/image";

import { AnimatedGrid, AnimatedCard } from "@/lib/animations";
import { EcosystemCard } from "../components/EcosystemCard";
import { discoveryDirectorySlugs, foundationMembers, highlightedIntegrationSlugs } from "./data";
import type { Partner, FoundationMember } from "./data";

const highlightedLogoOverrides: Record<string, string> = {
  alchemy: "/logos/alchemy-dark.svg",
  aws: "/logos/aws.svg",
  cloudflare: "/logos/cloudflare-mono.svg",
  exa: "/logos/exa-ai.svg",
  nansen: "/logos/nansen-dark.svg",
  vercel: "/logos/vercel-l.svg",
  world: "/logos/world-mono.svg",
};

const foundationPartnerAliases: Record<string, string> = {
  Amazon: "AWS",
  Coinbase: "CDP Facilitator",
  "Polygon Labs Services": "Polygon Facilitator",
  "t54 labs": "x402-secure",
};

interface FoundationLogoDisplayOverride {
  scale?: number;
  containerClassName?: string;
  imageClassName?: string;
}

const foundationLogoDisplayOverrides: Record<string, FoundationLogoDisplayOverride> = {
  Adyen: { scale: 0.6 },
  Amazon: { scale: 0.7 },
  "American Express": { scale: 0.9 },
  Circle: { scale: 0.7 },
  Fiserv: { scale: 0.7 },
  Google: {
    scale: 0.7,
    containerClassName: "flex h-[60px] w-[60px] items-center justify-start overflow-hidden",
  },
  MasterCard: { scale: 0.7 },
  Shopify: { scale: 0.7 },
  Solana: { scale: 0.5 },
  Stripe: { scale: 0.5 },
  "Visa Inc.": { scale: 0.5 },
  Aleo: { scale: 0.7 },
  Fireblocks: { scale: 0.7 },
  "Kakaopay inc.": { scale: 0.7 },
  Nansen: { scale: 0.7 },
  "Polygon Labs Services": { scale: 0.7 },
  "t54 labs": { scale: 0.7 },
  "x402-secure": { scale: 0.7 },
  World: { scale: 0.7 },
  utexo: { scale: 0.7 },
  "Quant Network": { scale: 0.7 },
  "Kite AI": { scale: 0.7 },
  "LayerZero Labs": { scale: 0.7 },
  "Merit Systems": { scale: 0.7 },
};

interface EcosystemClientProps {
  initialPartners: Partner[];
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-gray-40">
      {children}
    </p>
  );
}

function getMemberInitials(name: string) {
  return name
    .replace(" Inc.", "")
    .replace(" inc.", "")
    .replace(" Services", "")
    .split(" ")
    .filter(Boolean)
    .map(part => part[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
}

function FoundationMemberCard({
  member,
  partner,
}: {
  member: FoundationMember;
  partner?: Partner;
}) {
  const description =
    member.description ?? partner?.description ?? `${member.name} is a member of the x402 Foundation.`;
  const websiteUrl = partner?.websiteUrl ?? member.websiteUrl;
  const logoUrl = partner?.logoUrl ?? member.logoUrl;
  const logoDisplayOverride = foundationLogoDisplayOverrides[member.name];
  const logoScale = logoDisplayOverride?.scale ?? 1;
  const logoContainerClassName =
    logoDisplayOverride?.containerClassName ??
    "flex h-[60px] w-[140px] items-center justify-start overflow-hidden";
  const logoClassName = logoDisplayOverride?.imageClassName;

  return (
    <article className="group relative flex h-full min-h-[280px] w-full flex-col border border-foreground bg-background px-3 pt-4 pb-5 transition-all duration-200 hover:border-accent-orange hover:bg-gray-10 hover:shadow-lg">
      <div
        className="absolute inset-x-0 top-0 h-[7px] bg-black transition-colors duration-200 group-hover:bg-accent-orange"
        aria-hidden="true"
      />

      <a
        href={websiteUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute inset-0 z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={`Learn more about ${member.name}`}
      />

      <div className="relative z-10 pointer-events-none mb-3 flex items-start justify-between">
        <div className={`relative ${logoContainerClassName}`}>
          {logoUrl ? (
            <Image
              src={logoUrl}
              alt={`${member.name} logo`}
              fill
              sizes="140px"
              className={logoClassName}
              style={{
                objectFit: "contain",
                objectPosition: "left center",
                transform: `scale(${logoScale})`,
                transformOrigin: "left center",
              }}
            />
          ) : (
            <div className="flex h-[60px] w-[60px] items-center justify-center border border-gray-20 bg-gray-10">
              <span className="font-mono text-sm font-medium tracking-[-0.28px] text-gray-60">
                {getMemberInitials(member.name)}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="relative z-10 pointer-events-none flex-1 space-y-2">
        <h3 className="text-sm font-semibold uppercase leading-snug">{member.name}</h3>
        <p className="text-xs leading-relaxed text-gray-60">{description}</p>
      </div>

      <div className="relative z-10 pointer-events-none mt-3 text-xs font-medium">
        <span className="inline-flex items-center gap-1 text-accent-orange">
          Visit website &rarr;
        </span>
      </div>
    </article>
  );
}

function FoundationMemberGrid({
  title,
  members,
  partnersByName,
}: {
  title: string;
  members: FoundationMember[];
  partnersByName: Map<string, Partner>;
}) {
  return (
    <section className="space-y-4" aria-labelledby={`${title.toLowerCase()}-members-heading`}>
      <div className="flex items-end justify-between gap-4 border-b border-foreground pb-3">
        <h2
          id={`${title.toLowerCase()}-members-heading`}
          className="font-['Helvetica_Neue',sans-serif] text-xl font-medium"
        >
          {title} Members
        </h2>
        <span className="font-mono text-xs text-gray-40">{members.length} members</span>
      </div>

      <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2 lg:grid-cols-4">
        {members.map(member => {
          const partnerName = foundationPartnerAliases[member.name] ?? member.name;
          const partner = partnersByName.get(partnerName);

          return (
            <div key={member.name} className="h-full">
              <FoundationMemberCard member={member} partner={partner} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function EcosystemClient({
  initialPartners,
}: EcosystemClientProps) {
  const partnersByName = useMemo(
    () => new Map(initialPartners.map(partner => [partner.name, partner])),
    [initialPartners],
  );

  const foundationByTier = useMemo(
    () => ({
      premier: foundationMembers.filter(member => member.tier === "Premier"),
      general: foundationMembers.filter(member => member.tier === "General"),
    }),
    [],
  );

  const highlightedIntegrations = useMemo(() => {
    const bySlug = new Map(initialPartners.map(partner => [partner.slug, partner]));

    return highlightedIntegrationSlugs
      .map(slug => {
        const partner = bySlug.get(slug);
        if (!partner) return null;

        return {
          ...partner,
          logoUrl: highlightedLogoOverrides[slug] ?? partner.logoUrl,
        };
      })
      .filter((partner): partner is Partner => partner !== null);
  }, [initialPartners]);

  const discoveryDirectories = useMemo(() => {
    const bySlug = new Map(initialPartners.map(partner => [partner.slug, partner]));

    return discoveryDirectorySlugs
      .map(slug => bySlug.get(slug) ?? null)
      .filter((partner): partner is Partner => partner !== null);
  }, [initialPartners]);

  return (
    <div className="mx-auto max-w-container px-6 py-16 sm:px-10">
      <section className="relative mb-20">
        <div className="pointer-events-none absolute left-[350px] top-[25px] z-0 h-[509px] w-[514px] opacity-30">
          <Image
            src="/images/ecosystem-halftone.svg"
            alt=""
            width={514}
            height={550}
            className="h-full w-full"
            priority
          />
        </div>

        <div className="relative z-10">
          <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-[760px] space-y-5">
              <h1 className="font-display text-6xl tracking-tight sm:text-7xl lg:text-8xl">
                The x402 ecosystem is already taking shape.
              </h1>
              <p className="max-w-[760px] text-base leading-relaxed text-gray-60 sm:text-lg">
                x402 is backed by payment networks, cloud platforms, developer infrastructure, and
                crypto-native teams building the next payment layer for the internet.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mb-20 space-y-8" aria-labelledby="foundation-members-heading">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <SectionLabel>Foundation members</SectionLabel>
            <h2
              id="foundation-members-heading"
              className="font-display text-4xl tracking-tight sm:text-5xl"
            >
              Big names, clear signal.
            </h2>
          </div>
          <p className="max-w-[460px] text-sm leading-relaxed text-gray-60 sm:text-base">
            Premier and general members span payments, cloud, crypto infrastructure, and developer
            platforms.
          </p>
        </div>

        <div className="grid gap-10">
          <FoundationMemberGrid
            title="Premier"
            members={foundationByTier.premier}
            partnersByName={partnersByName}
          />
          <FoundationMemberGrid
            title="General"
            members={foundationByTier.general}
            partnersByName={partnersByName}
          />
        </div>
      </section>

      {highlightedIntegrations.length > 0 && (
        <section className="mb-20 space-y-6" aria-labelledby="highlighted-integrations-heading">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <h2
                id="highlighted-integrations-heading"
                className="font-display text-4xl tracking-tight sm:text-5xl"
              >
                The fastest paths from interest to implementation.
              </h2>
            </div>
            <p className="max-w-[440px] text-sm leading-relaxed text-gray-60 sm:text-base">
              Selected examples from teams making x402 easier to adopt across payments, AI, cloud,
              and developer infrastructure.
            </p>
          </div>

          <AnimatedGrid className="grid grid-cols-1 gap-[10px] sm:grid-cols-2 lg:grid-cols-3">
            {highlightedIntegrations.map(partner => (
              <AnimatedCard
                key={partner.slug ?? partner.name}
                layoutId={`highlighted-${partner.slug ?? partner.name}`}
                className="h-full"
              >
                <EcosystemCard partner={partner} />
              </AnimatedCard>
            ))}
          </AnimatedGrid>
        </section>
      )}

      {discoveryDirectories.length > 0 && (
        <section className="mb-20 space-y-6" aria-labelledby="project-discovery-heading">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <h2
                id="project-discovery-heading"
                className="font-display text-4xl tracking-tight sm:text-5xl"
              >
                Explore x402 services.
              </h2>
            </div>
            <p className="max-w-[440px] text-sm leading-relaxed text-gray-60 sm:text-base">
              Community-maintained x402 directories.
            </p>
          </div>

          <AnimatedGrid className="grid grid-cols-1 gap-[10px] sm:grid-cols-2">
            {discoveryDirectories.map(partner => (
              <AnimatedCard
                key={partner.slug ?? partner.name}
                layoutId={`discovery-${partner.slug ?? partner.name}`}
                className="h-full"
              >
                <EcosystemCard partner={partner} />
              </AnimatedCard>
            ))}
          </AnimatedGrid>
        </section>
      )}
    </div>
  );
}
