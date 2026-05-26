"use client";

import { useState, useCallback } from "react";
import Lottie from "lottie-react";
import { NavBarLogo } from "./NavBarLogo";
import animationData from "../data/lottie/CB_Dev_X402_02_v005.json";

interface AnimatedLogoProps {
  className?: string;
}

const ANIMATION_SIZE = 105;

export function AnimatedLogo({ className }: AnimatedLogoProps): React.ReactElement {
  const [animationComplete, setAnimationComplete] = useState(false);

  const handleComplete = useCallback(() => {
    setAnimationComplete(true);
  }, []);

  if (animationComplete) {
    return <NavBarLogo className={className} />;
  }

  return (
    <div className={className} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <NavBarLogo style={{ visibility: "hidden" }} />
      <Lottie
        animationData={animationData}
        loop={false}
        autoplay
        onComplete={handleComplete}
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: ANIMATION_SIZE,
          height: ANIMATION_SIZE,
        }}
        aria-label="x402 logo animation"
      />
    </div>
  );
}
