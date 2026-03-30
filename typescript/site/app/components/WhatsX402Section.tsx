"use client";

import { motion } from "motion/react";
import { textStagger, fadeInUp } from "@/lib/animations";

export function WhatsX402Section() {
  return (
    <section className="max-w-container mx-auto px-4 sm:px-6 md:px-10 pt-32 md:pt-44 pb-16 md:pb-20">
      <motion.div
        className="flex flex-col md:flex-row md:justify-between items-start gap-8 md:gap-16 lg:gap-20"
        variants={textStagger}
        initial="initial"
        whileInView="animate"
        viewport={{ once: true, margin: "-100px" }}
      >
        <motion.h2
          variants={fadeInUp}
          className="text-3xl sm:text-4xl md:text-5xl font-display tracking-tighter"
        >
          What&apos;s x402?
        </motion.h2>

        <motion.p
          variants={fadeInUp}
          className="text-sm sm:text-base font-medium text-gray-70 max-w-[691px] leading-relaxed"
        >
          Payments on the internet are fundamentally flawed. Filling out a form is a human behavor
          that doesn't match the programmatic nature of the internet. It&apos;s time for an open,
          internet-native form of payments. Payments that are amazing for humans and AI agents.
        </motion.p>
      </motion.div>
    </section>
  );
}
