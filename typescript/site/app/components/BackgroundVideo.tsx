'use client';

import Image from 'next/image';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useState } from 'react';

type BackgroundVideoProps = {
  src: string;
};

export function BackgroundVideo({ src }: BackgroundVideoProps) {
  const isDesktop = useMediaQuery('(min-width: 1280px)');
  const [isVideoLoaded, setIsVideoLoaded] = useState(false);

  const baseName = src.replace(/\.[^/.]+$/, '');

  if (!isDesktop) {
    return (
      <div className="fixed inset-0">
        <Image
          src={`${baseName}-placeholder.jpg`}
          alt="Background placeholder"
          fill
          priority
          className="object-cover opacity-30 blur-md"
          sizes="100vw"
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0">
      {/* Placeholder image */}
      <Image
        src={`${baseName}-placeholder.jpg`}
        alt="Background placeholder"
        fill
        priority
        sizes="100vw"
        className={`object-cover transition-opacity duration-500 ${
          isVideoLoaded ? 'opacity-0' : 'opacity-30'
        } blur-md`}
      />

      {/* Video */}
      <video
        autoPlay
        loop
        muted
        playsInline
        onLoadedData={() => setIsVideoLoaded(true)}
        className={`w-full h-full object-cover transition-opacity duration-500 ${
          isVideoLoaded ? 'opacity-30' : 'opacity-0'
        } blur-md`}
      >
        <source src={src} type="video/mp4" />
      </video>
    </div>
  );
}
