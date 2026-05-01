"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { NavBarLogo } from "./NavBarLogo";
import { AnimatedLogo } from "./AnimatedLogo";

function CloseIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M6 6L18 18M6 18L18 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

interface NavBarProps {
  /** When true, plays the Lottie logo animation on page load */
  animateLogo?: boolean;
}

export function NavBar({ animateLogo = false }: NavBarProps): React.ReactElement {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const LogoComponent = animateLogo ? AnimatedLogo : NavBarLogo;

  return (
    <nav className="w-full bg-white" role="navigation" aria-label="Main navigation">
      <div className="max-w-container mx-auto px-4 sm:px-6 py-3">
        <div className="flex items-center justify-between gap-4 sm:gap-8">
          {/* Mobile: Hamburger button */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="lg:hidden p-1 -ml-1 text-black hover:bg-gray-10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
            aria-expanded={mobileMenuOpen}
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          >
            {mobileMenuOpen ? (
              <CloseIcon />
            ) : (
              <Image src="/images/hamburger.svg" alt="" width={24} height={24} aria-hidden="true" />
            )}
          </button>

          {/* Desktop: Left side navigation - flattened */}
          <div className="hidden lg:flex flex-1 items-center gap-6 justify-start">
            <Link
              href="/ecosystem"
              className="text-sm font-medium text-black hover:text-gray-600 transition-colors"
            >
              Ecosystem
            </Link>
            <Link
              href="/writing/x402-v2-launch"
              className="text-sm font-medium text-black hover:text-gray-600 transition-colors"
            >
              Writing
            </Link>
            <Link
              href="https://www.x402.org/x402-whitepaper.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-black hover:text-gray-600 transition-colors"
            >
              Whitepaper
            </Link>
          </div>

          {/* Center logo (home link) */}
          <div className="flex flex-1 lg:flex-none justify-center">
            <Link href="/" aria-label="x402 home" className="inline-flex items-center">
              <LogoComponent className="h-9.25 w-auto" />
            </Link>
          </div>

          {/* Desktop: Right side actions */}
          <div className="hidden lg:flex flex-1 items-center gap-6 justify-end">
            {/* Social icons */}
            <div className="flex items-center gap-6">
              <Link
                href="https://github.com/x402-foundation/x402"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:opacity-60 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                aria-label="GitHub"
              >
                <svg
                  className="w-5 h-5"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
              </Link>
              <Link
                href="https://discord.com/invite/cdp"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:opacity-60 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                aria-label="Discord"
              >
                <svg
                  className="w-5 h-5"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028 14.09 14.09 0 001.226-1.994.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              </Link>
            </div>

            {/* CTA buttons */}
            <div className="flex items-center gap-3">
              {/* Get Started button */}
              <Link
                href="https://docs.x402.org/getting-started/quickstart-for-buyers"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-4 py-2 bg-black text-white font-medium text-sm hover:bg-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    d="M10.1772 14.2772L14.027 10.4274L14.027 9.57257L10.1772 5.72285L11.1851 4.71495L15.4524 8.98217L15.4524 11.0178L11.1851 15.285L10.1772 14.2772Z"
                    fill="currentColor"
                  />
                  <path
                    d="M4.54761 9.45635C4.54761 9.369 4.64796 9.2982 4.77174 9.2982H14.0704C14.1941 9.2982 14.2945 9.369 14.2945 9.45635V10.5633C14.2945 10.6507 14.1941 10.7215 14.0704 10.7215H4.77174C4.64796 10.7215 4.54761 10.6507 4.54761 10.5633V9.45635Z"
                    fill="currentColor"
                  />
                </svg>
                <span>Get Started</span>
              </Link>
            </div>
          </div>

          {/* Mobile: Spacer to balance hamburger */}
          <div className="lg:hidden w-6" aria-hidden="true" />
        </div>
      </div>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="lg:hidden border-t border-gray-10 bg-white">
          <div className="px-4 py-4 space-y-4">
            {/* Navigation links */}
            <div className="space-y-1">
              <Link
                href="/ecosystem"
                className="block py-2 text-black font-medium text-sm hover:text-gray-60 transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                Ecosystem
              </Link>
              <Link
                href="/writing/x402-v2-launch"
                className="block py-2 text-black font-medium text-sm hover:text-gray-60 transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                Writing
              </Link>
              <Link
                href="https://www.x402.org/x402-whitepaper.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="block py-2 text-black font-medium text-sm hover:text-gray-60 transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                Whitepaper
              </Link>
            </div>

            {/* Divider */}
            <div className="border-t border-gray-10" />

            {/* CTA buttons */}
            <div className="space-y-3 pt-2">
              <Link
                href="https://docs.x402.org/getting-started/quickstart-for-buyers"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full px-4 py-3 bg-black text-white font-medium text-sm hover:bg-gray-800 transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                Get Started
              </Link>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
