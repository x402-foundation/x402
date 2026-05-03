import Link from "next/link";

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028 14.09 14.09 0 001.226-1.994.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

export function Footer() {
  return (
    <footer className="bg-black text-white" role="contentinfo">
      {/* Content section */}
      <div className="max-w-container mx-auto px-10 pt-20 pb-10">
        {/* Top row: navigation */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-end gap-6 mb-10">
          <nav aria-label="Footer navigation">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Link
                href="https://docs.x402.org"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white hover:text-gray-300 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                Docs
              </Link>
              <Link
                href="/ecosystem"
                className="text-white hover:text-gray-300 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                Ecosystem
              </Link>
              <Link
                href="/writing/x402-v2-launch"
                className="text-white hover:text-gray-300 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                Writing
              </Link>
              <Link
                href="https://www.x402.org/x402-whitepaper.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white hover:text-gray-300 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                Whitepaper
              </Link>
              <Link
                href="https://docs.google.com/forms/d/e/1FAIpQLSc2rlaeH31rZpJ_RFNL7egxi9fYTEUjW9r2kwkhd2pMae2dog/viewform"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white hover:text-gray-300 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                Contact
              </Link>
            </div>
          </nav>
        </div>

        {/* Social icons */}
        <div className="flex items-center gap-6 mb-8">
          <Link
            href="https://github.com/x402-foundation/x402"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            aria-label="GitHub"
          >
            <GithubIcon className="w-6 h-6" />
          </Link>
          <Link
            href="https://discord.com/invite/cdp"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            aria-label="Discord"
          >
            <DiscordIcon className="w-6 h-6" />
          </Link>
        </div>

        {/* Divider */}
        <div className="h-px bg-white/40 mb-8" />

        {/* Copyright row */}
        <div className="flex justify-between items-center">
          <p className="text-white/40 text-sm">
            While x402 is an open and neutral standard, this website is maintained by Coinbase
            Developer Platform. By using this site, you agree to be bound by the{" "}
            <Link
              href="https://www.coinbase.com/legal/developer-platform/terms-of-service"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:text-blue-400"
            >
              CDP Terms of Service
            </Link>{" "}
            and{" "}
            <Link
              href="https://www.coinbase.com/legal/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:text-blue-400"
            >
              Global Privacy Policy
            </Link>
            .
          </p>
        </div>
      </div>

      {/* Logo section - below copyright */}
      <div className="relative w-full">
        <img
          src="/images/x402_vector.svg"
          alt=""
          aria-hidden="true"
          className="w-full h-auto"
          style={{ filter: "brightness(0.75)" }}
        />
      </div>
    </footer>
  );
}
