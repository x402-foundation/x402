"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";

export interface NavDropdownItem {
  label: string;
  href?: string;
  external?: boolean;
  disabled?: boolean;
}

export interface NavDropdownProps {
  label: string;
  items: NavDropdownItem[];
  alignment?: "left" | "right";
}

export function NavDropdown({ label, items, alignment = "left" }: NavDropdownProps) {
  const [open, setOpen] = useState(false);
  const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimeoutRef.current = setTimeout(() => {
      setOpen(false);
    }, 150);
  };

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("keydown", handleKeydown);
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  const menuId = `nav-dropdown-${label.toLowerCase()}-menu`;
  const alignmentClass = alignment === "right" ? "right-0" : "left-0";

  return (
    <div
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className="flex items-center gap-1 text-black font-medium text-sm hover:text-gray-60 transition-colors focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2"
      >
        <span>{label}</span>
        <motion.svg
          width="16"
          height="16"
          viewBox="0 0 20 20"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
        >
          <path
            d="M5.72274 7.36241L9.57246 11.2121L10.4273 11.2121L14.277 7.36242L15.2849 8.37031L11.0177 12.6376L8.98206 12.6376L4.71484 8.37031L5.72274 7.36241Z"
            fill="currentColor"
          />
        </motion.svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key={menuId}
            id={menuId}
            role="menu"
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.97 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={`absolute mt-2 w-48 rounded-md border border-gray-10 bg-white shadow-lg py-1 z-50 ${alignmentClass}`}
          >
            {items.map((item) => {
              const isDisabled = item.disabled || !item.href;

              const baseClasses = "w-full px-3 py-1.5 text-left text-sm transition-colors block";
              const enabledClasses = "hover:bg-gray-10 cursor-pointer";
              const disabledClasses = "text-gray-40 cursor-default";

              const className = `${baseClasses} ${isDisabled ? disabledClasses : enabledClasses}`;

              if (isDisabled) {
                return (
                  <div
                    key={item.label}
                    role="menuitem"
                    aria-disabled="true"
                    className={className}
                  >
                    ↳ {item.label}
                  </div>
                );
              }

              if (item.external) {
                return (
                  <a
                    key={item.label}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    role="menuitem"
                    className={className}
                    onClick={() => setOpen(false)}
                  >
                    ↳ {item.label}
                  </a>
                );
              }

              return (
                <Link
                  key={item.label}
                  href={item.href!}
                  role="menuitem"
                  className={className}
                  onClick={() => setOpen(false)}
                >
                  ↳ {item.label}
                </Link>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}