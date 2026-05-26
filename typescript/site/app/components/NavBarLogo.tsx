import * as React from "react";

export interface NavBarLogoProps extends React.SVGProps<SVGSVGElement> {
  title?: string;
}

export function NavBarLogo({ title, ...props }: NavBarLogoProps) {
  return (
    <svg
      viewBox="300 700 1560 760"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : "presentation"}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id="x402-clip-c">
          <path fill="#fff" d="M-2.226-41.006h-84.5v80.5h84.5z" />
        </clipPath>
        <clipPath id="x402-clip-b">
          <path fill="#fff" d="M-.637-40.494h-86v83h86z" />
        </clipPath>
      </defs>
      <g>
        <path
          fill="currentColor"
          d="M-30.917-5.939c0-2.76 1.592-6.577 3.553-8.518l24.27-24.036a4.954 4.954 0 0 0 .006-7.042l-18.645-18.526a5.036 5.036 0 0 0-7.09.003l-34.84 34.683c-1.956 1.946-3.544 5.767-3.544 8.527v42.31c0 2.76 1.59 6.579 3.547 8.524L37.748 130.728c1.958 1.945 5.147 1.956 7.118.024l18.77-18.393a4.944 4.944 0 0 0 .037-7.037l-91.056-91.136c-1.95-1.952-3.534-5.778-3.534-8.537z"
          transform="translate(657.28 1079.992)scale(1.35)"
        />
        <g clipPath="url(#x402-clip-b)" transform="translate(657.28 1079.992)scale(1.35)">
          <path
            fill="currentColor"
            d="M-30.917-10.939.459-42.011-25.28-67.585l-41.927 41.737v52.31l108.502 107.79 25.912-25.393-98.124-98.21z"
          />
        </g>
        <path
          fill="currentColor"
          d="M-30.917-5.939c0-2.76 1.587-6.582 3.541-8.53l90.961-90.678a4.974 4.974 0 0 0-.006-7.054l-18.645-18.527a5.027 5.027 0 0 0-7.086.008L-63.668-29.38c-1.953 1.95-3.539 5.772-3.539 8.532v42.31c0 2.76 1.59 6.579 3.547 8.524L37.748 130.728c1.958 1.945 5.147 1.956 7.118.024l18.77-18.393a4.944 4.944 0 0 0 .037-7.037l-91.056-91.136c-1.95-1.952-3.534-5.778-3.534-8.537z"
          transform="translate(476.496 1079.992)scale(-1.35)"
        />
        <g clipPath="url(#x402-clip-c)" transform="translate(476.496 1079.992)scale(-1.35)">
          <path
            fill="currentColor"
            d="m-30.917-10.939 98.043-97.738-25.739-25.575L-67.207-25.848v52.31l108.502 107.79 25.912-25.393-98.124-98.21z"
          />
        </g>
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="26"
          d="M-78-109.5H61.996a1 1 0 0 1 1 1v31.791c0 .552-.313 1.32-.698 1.716L-64.77 55.189c-.385.395-.698 1.164-.698 1.716v18.542c0 .552.31 1.324.69 1.723l30.166 31.607c.38.399 1.138.723 1.69.723h78.956c.552 0 1.317-.316 1.708-.706L78 78.606"
          transform="translate(1600.369 990.596)scale(-2.25)"
        />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="58.5"
          d="m1359.619 849.971-276.75 276.75m276.75-292.5v312.75c0 49.671-40.33 90-90 90h-96.75c-49.671 0-90-40.329-90-90v-312.75c0-49.67 40.329-90 90-90h96.75c49.67 0 90 40.33 90 90z"
        />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="26"
          d="M72.5-2.426H-55c-.552 0-1.311-.322-1.695-.72l-15.11-15.635a1.03 1.03 0 0 1 .007-1.431l91.74-93.076c.387-.393 1.15-.712 1.702-.712h7.318a1 1 0 0 1 1 1v227"
          transform="translate(861.244 1002.971)scale(2.25)"
        />
      </g>
    </svg>
  );
}
