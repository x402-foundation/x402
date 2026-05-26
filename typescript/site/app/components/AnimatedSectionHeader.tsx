"use client";

import { motion } from "motion/react";
import { textStagger, fadeInUp } from "@/lib/animations";

interface AnimatedSectionHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  align?: "left" | "center";
  className?: string;
  maxDescriptionWidth?: string;
  viewportOnce?: boolean;
  descriptionSize?: "default" | "small";
}

export function AnimatedSectionHeader({
  title,
  description,
  descriptionSize = "default",
  align = "center",
  className,
  maxDescriptionWidth,
  viewportOnce = true,
}: AnimatedSectionHeaderProps) {
  const alignment = align === "center" ? "items-center text-center" : "items-start text-left";
  const descriptionClass =
    descriptionSize === "small"
      ? "text-sm font-mono text-gray-70"
      : "text-base font-medium text-gray-70";

  return (
    <motion.div
      className={`flex flex-col gap-2 ${alignment} ${className ?? ""}`}
      variants={textStagger}
      initial="initial"
      whileInView="animate"
      viewport={{ once: viewportOnce, margin: "-80px" }}
    >
      <motion.h2 variants={fadeInUp} className="text-5xl font-display tracking-tighter">
        {title}
      </motion.h2>
      {description ? (
        <motion.p
          variants={fadeInUp}
          className={descriptionClass}
          style={maxDescriptionWidth ? { maxWidth: maxDescriptionWidth } : undefined}
        >
          {description}
        </motion.p>
      ) : null}
    </motion.div>
  );
}