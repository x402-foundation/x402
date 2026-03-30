"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";

import { AnimatedGrid, AnimatedCard } from "@/lib/animations";
import { EcosystemCard } from "../components/EcosystemCard";
import FacilitatorCard from "./facilitator-card";
import type { Partner, CategoryInfo } from "./data";

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" fill="currentColor" />
    </svg>
  );
}

function EcosystemSearch({ partners, onQueryChange, onSelect }: { partners: Partner[]; onQueryChange: (q: string) => void; onSelect: (name: string) => void }) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return partners.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, partners]);

  return (
    <div ref={ref} className="relative z-40 w-full max-w-md">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-40" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onQueryChange(e.target.value);
            onSelect("");
            setIsOpen(true);
          }}
          onFocus={() => query.trim() && setIsOpen(true)}
          placeholder="Search ecosystem..."
          className="w-full border border-foreground bg-background pl-10 pr-4 py-2.5 text-sm font-mono placeholder:text-gray-40 focus:outline-none focus:border-accent-orange transition-colors"
        />
      </div>
      {isOpen && results.length > 0 && (
        <div className="absolute z-30 mt-1 w-full border border-foreground bg-background shadow-lg max-h-80 overflow-y-auto">
          {results.map((partner) => (
            <button
              key={partner.slug ?? partner.name}
              type="button"
              className="flex w-full items-center gap-3 px-4 py-3 hover:bg-gray-10 transition-colors border-b border-gray-10 last:border-b-0 cursor-pointer text-left"
              onClick={() => {
                setIsOpen(false);
                setQuery(partner.name);
                onQueryChange(partner.name);
                onSelect(partner.name);
              }}
            >
              {partner.logoUrl && (
                <Image
                  src={partner.logoUrl}
                  alt=""
                  width={28}
                  height={28}
                  className="h-7 w-7 object-contain shrink-0"
                />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{partner.name}</p>
                <p className="text-xs text-gray-40 truncate">{partner.category}</p>
              </div>
            </button>
          ))}
        </div>
      )}
      {isOpen && query.trim() && results.length === 0 && (
        <div className="absolute z-30 mt-1 w-full border border-foreground bg-background shadow-lg px-4 py-3">
          <p className="text-sm text-gray-40">No results found</p>
        </div>
      )}
    </div>
  );
}

interface EcosystemClientProps {
  initialPartners: Partner[];
  categories: CategoryInfo[];
  initialSelectedCategory?: string | null;
}

type PartitionResult = {
  topSection: Partner[];
  byCategory: Record<string, Partner[]>;
};

function FolderIcon({ className }: { className?: string }) {
  return (
    <Image
      src="/images/icons/folder.svg"
      alt=""
      width={20}
      height={20}
      className={className}
    />
  );
}

function IndentArrowIcon({ className }: { className?: string }) {
  return (
    <Image
      src="/images/icons/indent_group5.svg"
      alt=""
      width={20}
      height={20}
      className={className}
    />
  );
}

function partitionPartners(partners: Partner[], categories: CategoryInfo[]): PartitionResult {
  const byCategory: Record<string, Partner[]> = { everything: [...partners] };

  // Initialize empty arrays for each category id
  for (const category of categories) {
    byCategory[category.id] = [];
  }

  // Create a map from category name to category id for lookup
  const nameToId = new Map(categories.map((c) => [c.name, c.id]));

  for (const partner of partners) {
    // Partner.category contains the display name (e.g., "Facilitators")
    // We need to map it to the category id (e.g., "facilitators")
    const categoryId = nameToId.get(partner.category);
    if (categoryId && byCategory[categoryId]) {
      byCategory[categoryId].push(partner);
    }
  }

  const topSection = partners.filter((partner) => partner.top_section);

  return { topSection, byCategory };
}

export default function EcosystemClient({
  initialPartners,
  categories,
  initialSelectedCategory,
}: EcosystemClientProps) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [isExpanded, setIsExpanded] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPartner, setSelectedPartner] = useState("");

  const activeFilter =
    (searchParams.get("filter") ?? initialSelectedCategory ?? "everything") || "everything";

  const { topSection, byCategory } = useMemo(
    () => partitionPartners(initialPartners, categories),
    [initialPartners, categories],
  );

  const handleFilterChange = (categoryId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (categoryId === "everything") {
      params.delete("filter");
    } else {
      params.set("filter", categoryId);
    }
    router.push(`/ecosystem${params.toString() ? `?${params.toString()}` : ""}`, {
      scroll: false,
    });
  };

  const basePartners =
    activeFilter === "everything"
      ? initialPartners.filter((partner) => !partner.top_section)
      : (byCategory[activeFilter] ?? []).filter((partner) => !partner.top_section);

  const filteredPartners = useMemo(() => {
    if (selectedPartner) {
      return initialPartners.filter((p) => p.name === selectedPartner);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return initialPartners.filter((p) => p.name.toLowerCase().includes(q));
    }
    return basePartners;
  }, [selectedPartner, searchQuery, basePartners, initialPartners]);

  return (
    <div className="mx-auto max-w-container px-6 py-16 sm:px-10">
      {/* Hero */}
      <section className="relative mb-16">
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
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-4">
              <h1 className="font-display text-7xl tracking-tight">Ecosystem</h1>
            </div>
            <p className="max-w-[400px] text-right font-code-ui text-base leading-relaxed text-gray-60 sm:text-lg">
              Discover innovative projects, tools, and applications built by our growing community
              of partners and developers leveraging x402 technology.
            </p>
          </div>
        </div>

        <div className="relative z-30 mt-12">
          <EcosystemSearch
              partners={initialPartners}
              onQueryChange={(q) => {
                setSearchQuery(q);
                setIsSearching(q.trim().length > 0);
                if (!q.trim()) setSelectedPartner("");
              }}
              onSelect={(name) => setSelectedPartner(name)}
            />
          </div>

          {!isSearching && topSection.length > 0 && (
            <div className="mt-12 space-y-3">
              <AnimatedGrid className="grid grid-cols-1 gap-[10px] sm:grid-cols-2 lg:grid-cols-4">
                {topSection.map((partner) => (
                  <AnimatedCard
                    key={partner.slug ?? partner.name}
                    layoutId={`topSection-${partner.slug ?? partner.name}`}
                    className="h-full"
                  >
                    {partner.facilitator ? (
                      <FacilitatorCard partner={partner} variant="top_section" />
                    ) : (
                      <EcosystemCard partner={partner} variant="top_section" />
                    )}
                  </AnimatedCard>
                ))}
              </AnimatedGrid>
            </div>
          )}
      </section>

      {/* Sidebar + main content */}
      <section className="flex flex-col gap-12 lg:flex-row">
        <aside
          className="w-full text-sm lg:w-48 xl:w-56"
          aria-label="Ecosystem categories"
        >
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="mb-2 flex w-full cursor-pointer items-center gap-2 py-1 text-left"
            aria-expanded={isExpanded}
          >
            <FolderIcon className="h-7 w-7 shrink-0" />
            <span className="font-mono text-sm font-medium tracking-[-0.28px]">Ecosystem</span>
          </button>

          <AnimatePresence initial={false}>
            {isExpanded && (
              <motion.nav
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="flex flex-col gap-0.5 overflow-hidden pl-2"
              >
                {[
                  { id: "everything", name: "Everything" },
                  ...categories.map((category) => ({ id: category.id, name: category.name })),
                ].map((category) => {
                  const isActive = activeFilter === category.id;
                  return (
                    <button
                      key={category.id}
                      onClick={() => handleFilterChange(category.id)}
                      className={`relative flex w-full cursor-pointer items-center gap-1.5 py-1.5 text-left font-mono text-sm font-medium tracking-[-0.28px] transition-colors ${
                        isActive ? "text-foreground" : "text-foreground/30 hover:text-foreground/60"
                      }`}
                    >
                      <IndentArrowIcon className="h-4 w-4 shrink-0" />
                      <span>{category.name}</span>
                    </button>
                  );
                })}
              </motion.nav>
            )}
          </AnimatePresence>
        </aside>

        <div className="flex-1 space-y-16">
          {isSearching ? (
            <div className="space-y-4">
              <h2 className="font-['Helvetica_Neue',sans-serif] text-lg font-medium">
                {selectedPartner ? selectedPartner : `Results for "${searchQuery}"`}
              </h2>
              {filteredPartners.length > 0 ? (
                <AnimatedGrid className="grid gap-[10px] sm:grid-cols-2 lg:grid-cols-4">
                  {filteredPartners.map((partner) => (
                    <AnimatedCard
                      key={partner.slug ?? partner.name}
                      layoutId={`${partner.slug ?? partner.name}-search`}
                      className="h-full"
                    >
                      {partner.facilitator ? (
                        <FacilitatorCard partner={partner} />
                      ) : (
                        <EcosystemCard partner={partner} />
                      )}
                    </AnimatedCard>
                  ))}
                </AnimatedGrid>
              ) : (
                <p className="text-sm text-gray-60">No results found.</p>
              )}
            </div>
          ) : (
          <AnimatePresence mode="wait">
            {activeFilter === "everything" ? (
              <motion.div
                key="everything"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="space-y-16"
              >
                {categories.map((category) => {
                  const partners = (byCategory[category.id] ?? []).filter(
                    (partner) => !partner.top_section,
                  );
                  if (!partners.length) return null;

                  return (
                    <section
                      key={category.id}
                      id={category.id}
                      aria-labelledby={`${category.id}-heading`}
                      className="scroll-mt-24 space-y-4"
                    >
                      <h2 id={`${category.id}-heading`} className="font-['Helvetica_Neue',sans-serif] text-lg font-medium">
                        {category.name}
                      </h2>

                      <AnimatedGrid className="grid gap-[10px] sm:grid-cols-2 lg:grid-cols-4">
                        {partners.map((partner) => (
                          <AnimatedCard
                            key={partner.slug ?? partner.name}
                            layoutId={`${partner.slug ?? partner.name}-${category.id}`}
                            className="h-full"
                          >
                            {partner.facilitator ? (
                              <FacilitatorCard partner={partner} />
                            ) : (
                              <EcosystemCard partner={partner} />
                            )}
                          </AnimatedCard>
                        ))}
                      </AnimatedGrid>
                    </section>
                  );
                })}
              </motion.div>
            ) : (
              <motion.div
                key={activeFilter}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
              >
                <section className="scroll-mt-24 space-y-4">
                  <h2 className="font-['Helvetica_Neue',sans-serif] text-lg font-medium">
                    {categories.find((category) => category.id === activeFilter)?.name ??
                      "Ecosystem"}
                  </h2>
                  {filteredPartners.length > 0 ? (
                    <AnimatedGrid className="grid gap-[10px] sm:grid-cols-2 lg:grid-cols-4">
                      {filteredPartners.map((partner) => (
                        <AnimatedCard
                          key={partner.slug ?? partner.name}
                          layoutId={`${partner.slug ?? partner.name}-${activeFilter}`}
                          className="h-full"
                        >
                          {partner.facilitator ? (
                            <FacilitatorCard partner={partner} />
                          ) : (
                            <EcosystemCard partner={partner} />
                          )}
                        </AnimatedCard>
                      ))}
                    </AnimatedGrid>
                  ) : (
                    <p className="text-sm text-gray-60">No projects in this category yet.</p>
                  )}
                </section>
              </motion.div>
            )}
          </AnimatePresence>
          )}
        </div>
      </section>
    </div>
  );
}
