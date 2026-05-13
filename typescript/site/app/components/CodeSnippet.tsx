"use client";

import { useState } from "react";

interface CodeSnippetProps {
  code: string;
  /** If provided, this value is copied to clipboard instead of `code`. Use to
   *  show a compact display version while preserving properly-formatted copy. */
  copyCode?: string;
  title?: string;
  description?: string;
}

export function CodeSnippet({ code, copyCode, title, description }: CodeSnippetProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(copyCode ?? code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full border-t-[7px] border-black">
      <div className="border border-t-0 border-black bg-white p-4">
        {title && (
          <div className="flex items-center gap-2 mb-4">
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
                fill="black"
              />
              <path
                d="M4.54758 9.45634C4.54758 9.36899 4.64792 9.29819 4.77171 9.29819H14.0703C14.1941 9.29819 14.2945 9.36899 14.2945 9.45633V10.5633C14.2945 10.6507 14.1941 10.7215 14.0703 10.7215H4.77171C4.64792 10.7215 4.54758 10.6507 4.54758 10.5633V9.45634Z"
                fill="black"
              />
            </svg>
            <h3 className="font-mono text-lg font-medium tracking-tight">{title}</h3>
          </div>
        )}

        <div className="relative bg-[#F1F1F1] px-3 py-2 pb-2 mb-4">
          <button
            onClick={handleCopy}
            className="absolute top-2 right-2 p-1.5 bg-black text-white hover:bg-gray-800 transition-colors focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2"
            aria-label={copied ? "Copied to clipboard" : "Copy code"}
          >
            {copied ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M4 10L8 14L16 6"
                  stroke="white"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <rect
                  x="6"
                  y="6"
                  width="10"
                  height="12"
                  rx="1"
                  stroke="white"
                  strokeWidth="2"
                  fill="none"
                />
                <path
                  d="M4 14V3C4 2.44772 4.44772 2 5 2H12"
                  stroke="white"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
          <div className="overflow-x-auto pr-12">
            <code
              className="whitespace-pre-wrap md:whitespace-pre break-words md:break-normal text-black text-[11px] md:text-[13px]"
              style={{
                fontFamily: '"DM Mono", monospace',
                fontStyle: "normal",
                fontWeight: 400,
                lineHeight: "18px",
                letterSpacing: "-0.7px",
              }}
            >
              {code}
            </code>
          </div>
        </div>

        {description && (
          <p className="text-sm text-gray-60 font-mono leading-normal">{description}</p>
        )}
      </div>
    </div>
  );
}
