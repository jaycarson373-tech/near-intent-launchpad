import type { CSSProperties } from "react";
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: string;
  size?: number;
  style?: CSSProperties;
}) {
  const paths: Record<string, React.ReactNode> = {
    arrow: (
      <>
        <path d="M7 17 17 7M7 7h10v10" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V4H4v12h4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    wallet: (
      <>
        <path d="M20 8V5H4v14h16v-5M4 5V3h13" />
        <path d="M14 8h7v6h-7z" />
        <path d="M17 11h1" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    layers: (
      <>
        <path d="m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5" />
      </>
    ),
    back: <path d="M20 12H4m6-6-6 6 6 6" />,
    link: (
      <>
        <path d="m9 15 6-6M8 17l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 7l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths[name] || paths.arrow}
    </svg>
  );
}
export function IntentMark() {
  return (
    <svg
      viewBox="0 0 36 36"
      width="33"
      height="33"
      fill="none"
      aria-hidden="true"
    >
      <rect width="36" height="36" rx="9" fill="currentColor" />
      <path
        d="M10 26V11l16 14V10M10 11l5 1M26 25l-5-1"
        stroke="#09241a"
        strokeWidth="2.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function IntentMesh() {
  return (
    <svg
      className="intent-mesh"
      viewBox="0 0 640 470"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="mesh-stroke"
          x1="60"
          y1="430"
          x2="620"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#89efbb" stopOpacity=".02" />
          <stop offset=".47" stopColor="#9bffcc" />
          <stop offset="1" stopColor="#adffe0" stopOpacity=".06" />
        </linearGradient>
      </defs>
      {Array.from({ length: 49 }, (_, i) => (
        <path
          key={i}
          d={`M ${70 + i * 1.1} ${420 - i * 2} C ${305 + i * 1.3} ${405 - i * 4.4}, ${195 + i * 1.8} ${76 + i * 4.6}, ${553 + i * 0.8} ${36 + i * 2.6}`}
          stroke="url(#mesh-stroke)"
          strokeWidth=".7"
          opacity={0.25 + Math.sin((i / 49) * Math.PI) * 0.5}
        />
      ))}
      <circle cx="419" cy="172" r="3" fill="#a4ffd0" />
      <circle cx="419" cy="172" r="12" stroke="#a4ffd0" strokeOpacity=".24" />
      <path d="M440 172h77" stroke="#a4ffd0" strokeOpacity=".22" />
      <text x="526" y="175" fill="#b6c4bd" fontSize="8" letterSpacing="2">
        NEAR
      </text>
    </svg>
  );
}
