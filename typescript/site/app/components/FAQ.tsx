"use client";

import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

interface FAQItem {
  question: string;
  answer?: ReactNode;
}

const faqData: FAQItem[] = [
  {
    question: "What is x402 used for?",
    answer:
      "x402 enables instant, low-cost payments for digital services. It's designed for API monetization, agentic commerce, paywalled content, and any scenario where traditional payment methods are too slow or expensive.",
  },
  {
    question: "Is x402 production ready?",
    answer:
      "Yes, x402 is production-ready and has processed millions of transactions. The protocol is open-source and has been audited for security.",
  },
  {
    question: "How do I integrate x402?",
    answer:
      <>
        Integration is simple - add a single line of middleware to your server.
        Check our{" "}
        <a
          className="underline"
          href="https://docs.x402.org/getting-started/quickstart-for-sellers#id-2.-add-payment-middleware"
          target="_blank"
          rel="noreferrer"
        >
          documentation
        </a>{" "}
        for detailed guides and examples in multiple programming languages.
      </>,
  },
  {
    question: "What blockchains does x402 support?",
    answer:
      "x402 is blockchain-agnostic and supports all EVM-compatible chains, Solana, and more. Stablecoin payments are the primary use case. x402 is also extensible to traditional payment methods.",
  },
];

function PlusIcon() {
  return (
    <svg
      width="46"
      height="46"
      viewBox="0 0 46 46"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M26.0145 24.6213H38.5361L38.5276 21.3749H26.006L24.6232 19.9836V7.46631H21.3769V19.9836L19.9856 21.3749H7.46399V24.653H19.9856L21.3451 26.0126V38.5341H24.6232V26.0126L26.0145 24.6213Z"
        fill="black"
      />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg
      width="46"
      height="46"
      viewBox="0 0 46 46"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M7.46399 21.727C7.46399 21.5261 7.78389 21.3633 8.1785 21.3633L37.8216 21.3633C38.2162 21.3633 38.5361 21.5261 38.5361 21.727V24.2731C38.5361 24.474 38.2162 24.6368 37.8216 24.6368L8.1785 24.6368C7.78389 24.6368 7.46399 24.474 7.46399 24.2731L7.46399 21.727Z"
        fill="black"
      />
    </svg>
  );
}

export function FAQ() {
  const [openIndex, setOpenIndex] = useState<number>(-1);

  const toggleItem = (index: number) => {
    setOpenIndex((current) => (current === index ? -1 : index));
  };

  return (
    <section className="w-full max-w-container mx-auto px-4 sm:px-6 md:px-10 py-16 md:py-20" aria-label="Frequently asked questions">
      <h2 className="text-3xl sm:text-4xl md:text-5xl font-display tracking-tighter mb-8 sm:mb-10 md:mb-12">FAQs</h2>

      <div className="bg-white">
        {faqData.map((item, index) => (
          <div key={index}>
            <div
              className="border-t border-black cursor-pointer"
              onClick={(event) => {
                const target = event.target as HTMLElement;
                // Make entire open item clickable to toggle, but don't interfere with button or links
                if (target.closest("button, a")) return;
                toggleItem(index);
              }}
            >
              <button
                onClick={() => toggleItem(index)}
                className="w-full flex cursor-pointer justify-between items-center py-4 sm:py-5 px-4 sm:px-6 md:px-10 hover:bg-gray-10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black"
                aria-expanded={openIndex === index}
                aria-controls={`faq-answer-${index}`}
              >
                <h3 className="text-lg sm:text-xl md:text-2xl font-medium text-left">
                  {item.question}
                </h3>
                <div className="flex-shrink-0 ml-4">
                  {openIndex === index ? <MinusIcon /> : <PlusIcon />}
                </div>
              </button>

              <AnimatePresence initial={false}>
                {openIndex === index && item.answer && (
                  <motion.div
                    id={`faq-answer-${index}`}
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 sm:px-6 md:px-10 pb-4 sm:pb-6">
                      <p className="text-sm sm:text-base leading-relaxed">{item.answer}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        ))}
        <div className="border-t border-black" />
      </div>
    </section>
  );
}
