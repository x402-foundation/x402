import Image from "next/image";

export function HeroIllustration() {
  return (
    <div className="relative w-[700px] h-[1000px] flex-shrink-0 overflow-visible">
      {/* Halftone hand - emerges from bottom-right */}
      <Image
        src="/images/home_hand_halftone.svg"
        alt=""
        width={1100}
        height={1495}
        priority
        aria-hidden="true"
        className="absolute bottom-[20px] right-[20px] pointer-events-none select-none z-0"
      />
      {/* Phone positioned in palm area */}
      <a
        href="https://www.x402.org/protected"
        target="_blank"
        rel="noopener noreferrer"
        className="absolute bottom-[300px] right-[190px] z-10"
      >
        <Image
          src="/images/phone.svg"
          alt="Phone UI"
          width={330}
          height={700}
          className="drop-shadow-[0_12px_28px_rgba(0,0,0,0.16)]"
          priority
        />
      </a>
    </div>
  );
}
