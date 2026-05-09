import Image from "next/image";
import Link from "next/link";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/solid";

import type { Partner } from "../ecosystem/data";

interface EcosystemCardProps {
  partner: Partner;
  variant?: "top_section" | "standard";
}

export function EcosystemCard({ partner, variant = "standard" }: EcosystemCardProps) {
  const isExternal = partner.websiteUrl.startsWith("http");
  const isFeatured = variant === "top_section";
  const tagLabel = partner.typeLabel ?? partner.category;

  return (
    <article
      className={`group relative w-full h-full flex flex-col border border-foreground bg-background cursor-pointer transition-all duration-200 hover:bg-gray-10 hover:border-accent-orange hover:shadow-lg ${
        isFeatured ? "px-3 pt-4 pb-5" : "px-4 pt-5 pb-6"
      }`}
    >
      <div className="absolute inset-x-0 top-0 h-[7px] bg-black group-hover:bg-accent-orange transition-colors duration-200" aria-hidden="true" />

      <Link
        href={partner.websiteUrl}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        className="absolute inset-0 z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={`Learn more about ${partner.name}`}
      />

      <div
        className={`relative z-10 pointer-events-none flex items-start justify-between ${
          isFeatured ? "mb-3" : "mb-4"
        }`}
      >
        {partner.logoUrl ? (
          <div
            className={`overflow-hidden ${
              isFeatured ? "h-[60px] w-[60px]" : "h-[56px] w-[56px]"
            }`}
          >
            <Image
              src={partner.logoUrl}
              alt={`${partner.name} logo`}
              width={120}
              height={120}
              className="h-full w-full object-contain"
            />
          </div>
        ) : (
          <div
            className={`${
              isFeatured ? "h-[60px] w-[60px]" : "h-[56px] w-[56px]"
            }`}
            aria-hidden="true"
          />
        )}

        <span className="rounded-sm bg-gray-10 px-2 py-1 text-xs font-medium text-foreground">
          {tagLabel}
        </span>
      </div>

      <div className="relative z-10 pointer-events-none flex-1 space-y-2">
        <h3
          className={`leading-snug ${
            isFeatured ? "text-sm font-semibold uppercase" : "text-base font-medium uppercase"
          }`}
        >
          {partner.name}
        </h3>
        <p
          className={`text-gray-60 leading-relaxed ${
            isFeatured ? "text-xs" : "text-sm"
          }`}
        >
          {partner.description}
        </p>
      </div>

      <div
        className={`relative z-10 pointer-events-none font-medium ${
          isFeatured ? "mt-3 text-xs" : "mt-4 text-sm"
        }`}
      >
        <span className="inline-flex items-center gap-1 text-accent-orange">
          Visit website <ArrowTopRightOnSquareIcon className="h-3 w-3" />
        </span>
      </div>
    </article>
  );
}