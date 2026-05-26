"use client";

import Image from "next/image";
import React from "react";
import { motion, type Variants } from "motion/react";
import { textStagger, fadeInUp } from "@/lib/animations";

const containerVariants: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.12,
      delayChildren: 0.1,
    },
  },
};

const iconVariants: Variants = {
  initial: { opacity: 0, y: 20, scale: 0.9 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] },
  },
};

const connectorVariants: Variants = {
  initial: { opacity: 0, scaleX: 0 },
  animate: {
    opacity: 1,
    scaleX: 1,
    transition: { duration: 0.3, ease: "easeOut" },
  },
};

function IconCircle({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="w-[68px] h-[68px] flex items-center justify-center rounded-full border-2 border-black bg-white cursor-pointer"
      variants={iconVariants}
      whileHover={{
        scale: 1.08,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
        transition: { duration: 0.2 },
      }}
      whileTap={{ scale: 0.95 }}
    >
      {children}
    </motion.div>
  );
}

function AgentIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M6.7721 5.71294L2.92237 9.56267V10.4175L6.7721 14.2672L5.7642 15.2751L1.49695 11.0079V8.97226L5.7642 4.70505L6.7721 5.71294Z" fill="black"/>
      <path d="M13.2279 14.2871L17.0776 10.4373L17.0776 9.58248L13.2279 5.73276L14.2358 4.72486L18.5031 8.99207L18.5031 11.0277L14.2358 15.295L13.2279 14.2871Z" fill="black"/>
      <rect x="7.35699" y="9.29807" width="1.42542" height="1.42542" fill="black"/>
      <rect x="11.1978" y="9.29807" width="1.42542" height="1.42542" fill="black"/>
    </svg>
  );
}

function TransactionIcon() {
  return (
    <Image
      src="/images/icons/transaction.svg"
      alt=""
      width={28}
      height={28}
      aria-hidden="true"
    />
  );
}

function PunkIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M18.5029 8.99219V11.0273L14.2354 15.2949L13.2275 14.2871L13.7461 13.7686H10.5254V12.2969H15.2178L17.0771 10.4375V9.58203L16.5889 9.09375H15.251V10.9531H13.3252V9.09375H12.4512V10.9531H10.5254V9.09375H8.27051L6.8252 10.5381L5.78418 9.49707L7.63281 7.64844V7.62109H15.1162L13.2275 5.73242L14.2354 4.72461L18.5029 8.99219ZM6.77246 5.71289L2.92285 9.5625V10.418L6.77246 14.2676L5.76465 15.2754L1.49707 11.0078V8.97266L5.76465 4.70508L6.77246 5.71289ZM8.83496 6.27832H7.3623V3.22754H8.83496V6.27832ZM10.7119 6.27832H9.23926V3.81836H10.7119V6.27832ZM12.6377 6.27832H11.165V4.50293H12.6377V6.27832Z" fill="black"/>
    </svg>
  );
}

function DottedConnector() {
  return (
    <motion.div
      className="relative flex-1 h-[2px] origin-left"
      variants={connectorVariants}
      aria-hidden="true"
    >
      <span
        className="absolute inset-0"
        style={{
          backgroundImage: "repeating-linear-gradient(90deg, black 0, black 2px, transparent 2px, transparent 8px)",
        }}
      />
      <span className="absolute -left-[5px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-black" />
      <span className="absolute -right-[5px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-black" />
    </motion.div>
  );
}

export function HTTPNativeSection() {
  return (
    <section className="py-20 md:py-28">
      {/* Full-width icon row */}
      <div className="full-bleed px-4 sm:px-6 md:px-10">
        <motion.div
          className="max-w-container mx-auto flex flex-wrap items-center justify-center md:justify-start gap-3 sm:gap-4"
          variants={containerVariants}
          initial="initial"
          whileInView="animate"
          viewport={{ once: true, margin: "-50px" }}
        >
          <IconCircle>
            <AgentIcon />
          </IconCircle>
          <DottedConnector />
          <IconCircle>
            <TransactionIcon />
          </IconCircle>
          <DottedConnector />
          <IconCircle>
            <PunkIcon />
          </IconCircle>
        </motion.div>
      </div>

      {/* Content row: text and illustration */}
      <div className="max-w-container mx-auto px-4 sm:px-6 md:px-10 mt-10 md:mt-12 flex flex-col md:flex-row items-center md:items-start justify-between gap-10 md:gap-12">
        <div className="flex-1 flex flex-col gap-6 md:gap-8">
          <motion.div
            className="max-w-[540px]"
            variants={textStagger}
            initial="initial"
            whileInView="animate"
            viewport={{ once: true, margin: "-50px" }}
          >
            <motion.h3
              variants={fadeInUp}
              className="text-2xl sm:text-3xl md:text-4xl font-display font-medium tracking-tight mb-3 text-center md:text-left"
            >
              HTTP-native. It&apos;s built-in to the internet.
            </motion.h3>
            <motion.p
              variants={fadeInUp}
              className="text-sm sm:text-base font-medium text-gray-70 leading-relaxed text-center md:text-left"
            >
              x402 is built-in to existing HTTP requests, with no additional communication required.
            </motion.p>
          </motion.div>
        </div>

        <div className="flex-shrink-0 w-full md:w-auto flex justify-center md:justify-end mt-10 md:mt-0">
          <Image
            src="/images/http_native_halftone.svg"
            alt="Halftone illustration representing HTTP native flow"
            width={400}
            height={320}
            className="w-full max-w-[320px] sm:max-w-[380px] md:max-w-[400px] h-auto"
            priority
          />
        </div>
      </div>
    </section>
  );
}