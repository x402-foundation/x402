'use client';

import { useState, type KeyboardEvent } from 'react';
import Image from 'next/image';
import { XMarkIcon } from '@heroicons/react/24/solid';
import type { Partner } from './data';

interface FacilitatorCardProps {
  partner: Partner;
  variant?: 'standard' | 'top_section';
}

export default function FacilitatorCard({ partner, variant = 'standard' }: FacilitatorCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  if (!partner.facilitator) {
    return null; // This shouldn't happen, but just in case
  }

  const { facilitator } = partner;
  const isFeatured = variant === 'top_section';
  const tagLabel = partner.typeLabel ?? partner.category;
  const handleOpen = () => setIsModalOpen(true);
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleOpen();
    }
  };
  const hasAnyAddresses =
    Array.isArray(facilitator.networks) &&
    facilitator.networks.some((network) => (facilitator.addresses?.[network]?.length ?? 0) > 0);

  return (
    <>
      <article
        role="button"
        tabIndex={0}
        onClick={handleOpen}
        onKeyDown={handleKeyDown}
        className={`group relative w-full h-full flex flex-col border border-foreground bg-background cursor-pointer outline-none transition-all duration-200 hover:bg-gray-10 hover:border-accent-orange hover:shadow-lg focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
          isFeatured ? 'px-3 pt-4 pb-5' : 'px-4 pt-5 pb-6'
        }`}
      >
        <div className="absolute inset-x-0 top-0 h-[7px] bg-black group-hover:bg-accent-orange transition-colors duration-200" aria-hidden="true" />

        <div
          className={`relative z-20 flex items-start justify-between ${
            isFeatured ? 'mb-3' : 'mb-4'
          }`}
        >
          {partner.logoUrl ? (
            <div
              className={`overflow-hidden ${
                isFeatured ? 'h-[60px] w-[60px]' : 'h-[56px] w-[56px]'
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
                isFeatured ? 'h-[60px] w-[60px]' : 'h-[56px] w-[56px]'
              }`}
              aria-hidden="true"
            />
          )}

          <span className="rounded-sm bg-gray-10 px-2 py-1 text-xs font-medium text-foreground">
            {tagLabel}
          </span>
        </div>

        <div className="relative z-20 flex-1 space-y-2">
          <h3
            className={`leading-snug ${
              isFeatured ? 'text-sm font-semibold uppercase' : 'text-base font-medium uppercase'
            }`}
          >
            {partner.name}
          </h3>
          <p
            className={`text-gray-60 leading-relaxed ${
              isFeatured ? 'text-xs' : 'text-sm'
            }`}
          >
            {partner.description}
          </p>
        </div>

        <div
          className={`relative z-20 font-medium ${
            isFeatured ? 'mt-3 text-xs' : 'mt-4 text-sm'
          }`}
        >
          <span className="inline-flex items-center gap-1 text-accent-orange">View details →</span>
        </div>
      </article>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setIsModalOpen(false)}
          />

          <div className="relative bg-background border border-foreground shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="absolute inset-x-0 top-0 h-[7px] bg-black" aria-hidden="true" />

            {/* Header */}
            <div className="flex items-center justify-between px-8 pt-10 pb-6 border-b border-gray-10">
              <div className="flex items-center gap-4">
                <div className="relative w-12 h-12 overflow-hidden">
                  <Image
                    src={partner.logoUrl}
                    alt={`${partner.name} logo`}
                    fill
                    sizes="48px"
                    style={{ objectFit: 'contain' }}
                  />
                </div>
                <div>
                  <h2 className="text-2xl font-semibold uppercase">{partner.name}</h2>
                  <p className="text-sm text-gray-40">Facilitator</p>
                </div>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-gray-40 hover:text-foreground transition-colors"
              >
                <XMarkIcon className="w-6 h-6" />
              </button>
            </div>

            {/* Content */}
            <div className="px-8 py-6 space-y-6">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide mb-2">Description</h3>
                <p className="text-sm text-gray-60 leading-relaxed">{partner.description}</p>
              </div>

              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide mb-2">Base URL</h3>
                <a
                  href={facilitator.baseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-accent-orange hover:underline font-mono break-all"
                >
                  {facilitator.baseUrl}
                </a>
              </div>

              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide mb-3">Supported Networks</h3>
                <div className="flex flex-wrap gap-2">
                  {facilitator.networks.map((network) => (
                    <span
                      key={network}
                      className="text-xs bg-gray-10 text-foreground px-3 py-1 font-mono"
                    >
                      {network}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide mb-3">Payment Schemes</h3>
                <div className="flex flex-wrap gap-2">
                  {facilitator.schemes.map((scheme) => (
                    <span
                      key={scheme}
                      className="text-xs bg-accent-green/10 text-accent-green px-3 py-1 font-mono"
                    >
                      {scheme}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide mb-3">Supported Assets</h3>
                <div className="flex flex-wrap gap-2">
                  {facilitator.assets.map((asset) => (
                    <span
                      key={asset}
                      className="text-xs bg-accent-orange/10 text-accent-orange px-3 py-1 font-mono"
                    >
                      {asset}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide mb-3">Capabilities</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${facilitator.supports.verify ? 'bg-accent-green' : 'bg-gray-20'}`} />
                    <span className="text-sm text-gray-60">Verify Payments</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${facilitator.supports.settle ? 'bg-accent-green' : 'bg-gray-20'}`} />
                    <span className="text-sm text-gray-60">Settle Payments</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${facilitator.supports.supported ? 'bg-accent-green' : 'bg-gray-20'}`} />
                    <span className="text-sm text-gray-60">Supported Endpoint</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${facilitator.supports.list ? 'bg-accent-green' : 'bg-gray-20'}`} />
                    <span className="text-sm text-gray-60">List Resources</span>
                  </div>
                </div>
              </div>

              {hasAnyAddresses && (
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-wide mb-3">Facilitator Addresses</h3>
                  <div className="overflow-x-auto border border-gray-10">
                    <table className="min-w-full divide-y divide-gray-10">
                      <thead>
                        <tr className="bg-gray-10/50">
                          <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide">Network</th>
                          <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide">Addresses</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-10">
                        {facilitator.networks.map((network) => {
                          const addresses = facilitator.addresses?.[network];
                          if (!addresses || addresses.length === 0) return null;
                          return (
                            <tr key={network}>
                              <td className="px-4 py-2 align-top">
                                <span className="text-xs bg-gray-10 text-foreground px-2 py-1 font-mono">{network}</span>
                              </td>
                              <td className="px-4 py-2">
                                <div className="flex flex-col gap-1">
                                  {addresses.map((addr, idx) => (
                                    <span
                                      key={`${network}-${idx}`}
                                      className="text-xs font-mono break-all text-gray-60"
                                      title={addr}
                                    >
                                      {addr}
                                    </span>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end px-8 py-6 border-t border-gray-10">
              <a
                href={partner.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 bg-foreground text-background px-6 py-2.5 text-sm font-medium hover:opacity-80 transition-opacity"
              >
                Visit Website
                <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
