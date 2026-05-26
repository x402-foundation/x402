"use client";

import { motion, AnimatePresence, type Variants, type HTMLMotionProps } from "motion/react";
import React from "react";

const containerVariants: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.05,
      ease: "easeInOut",
    },
  },
};

const itemVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.2, ease: "easeInOut" },
  },
  exit: {
    opacity: 0,
    y: -8,
    transition: { duration: 0.15, ease: "easeInOut" },
  },
};

// Subtle stagger for hero/title groups
export const textStagger: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.12,
      delayChildren: 0.05,
    },
  },
};

// Fade in + slight upward motion (headlines, body text)
export const fadeInUp: Variants = {
  initial: { opacity: 0, y: 16 },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.35,
      ease: [0.16, 1, 0.3, 1],
    },
  },
};

// For side illustrations (slide in from right)
export const fadeInFromRight: Variants = {
  initial: { opacity: 0, x: 32 },
  animate: {
    opacity: 1,
    x: 0,
    transition: {
      duration: 0.45,
      ease: [0.16, 1, 0.3, 1],
    },
  },
};

interface AnimatedGridProps extends Omit<HTMLMotionProps<"div">, "variants"> {
  children: React.ReactNode;
}

export function AnimatedGrid({ children, className, ...props }: AnimatedGridProps) {
  return (
    <motion.div
      variants={containerVariants}
      initial="initial"
      animate="animate"
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}

interface AnimatedCardProps extends Omit<HTMLMotionProps<"div">, "variants"> {
  children: React.ReactNode;
  layoutId?: string;
}

export function AnimatedCard({ children, layoutId, className, ...props }: AnimatedCardProps) {
  return (
    <motion.div
      layout
      layoutId={layoutId}
      variants={itemVariants}
      className={className}
      transition={{ type: "spring", duration: 0.3, bounce: 0 }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

interface FadeSwitchProps {
  children: React.ReactNode;
  switchKey: string;
  className?: string;
}

export function FadeSwitch({ children, switchKey, className }: FadeSwitchProps) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={switchKey}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        className={className}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}