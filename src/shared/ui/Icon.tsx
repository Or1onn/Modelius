// Icon.tsx — stroke icon set + the Icon atom (currentColor, 1.6 weight).
import type { CSSProperties } from "react";

// ---------- Icons (stroke, currentColor, 1.6 weight) ----------
export const Ic: Record<string, string> = {
  chat: "M3 5.5A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5v8A2.5 2.5 0 0 1 18.5 16H9l-4.5 4v-4H5.5A2.5 2.5 0 0 1 3 13.5z",
  providers: "M4 7h16M4 12h16M4 17h16",
  policy: "M12 3 4 6v5c0 4.5 3.2 7.8 8 10 4.8-2.2 8-5.5 8-10V6z",
  dashboard: "M4 13h6V4H4zM14 20h6V4h-6zM4 20h6v-4H4z",
  pipeline: "M5 6h5v4H5zM14 14h5v4h-5zM10 8h2a2 2 0 0 1 2 2v6",
  plus: "M12 5v14M5 12h14",
  send: "M5 12h13M12 5l7 7-7 7",
  leaf: "M5 19c0-7 5-12 14-12 0 9-5 14-12 14-1.5 0-2-1-2-2zM7 17c3-4 5-6 9-8",
  star: "M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L4.5 9.7l5.9-.9z",
  bolt: "M13 3 5 13h5l-1 8 8-10h-5z",
  lock: "M6 11V8a6 6 0 0 1 12 0v3M5 11h14v9H5z",
  attach: "M18 8.5 9.5 17a3.5 3.5 0 0 1-5-5l8.5-8.5a2.3 2.3 0 0 1 3.3 3.3L8 18",
  close: "M6 6l12 12M18 6 6 18",
  chevron: "M9 6l6 6-6 6",
  chevronD: "M6 9l6 6 6-6",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5",
  check: "M5 12.5 10 17l9-10",
  spark: "M12 4v4M12 16v4M4 12h4M16 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8",
  arrowR: "M5 12h14M13 6l6 6-6 6",
  play: "M7 4.5v15l13-7.5z",
  trend: "M4 16l5-5 4 3 7-8M20 6v5h-5",
  gauge: "M12 13l4-4M5 19a9 9 0 1 1 14 0",
  copy: "M9 9h10v10H9zM5 15V5h10",
  refresh: "M5 12a7 7 0 0 1 12-5l2 2M19 12a7 7 0 0 1-12 5l-2-2M17 4v5h-5M7 20v-5h5",
  cog: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3",
  edit: "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  eyeOff: "M3 3l18 18M10.6 10.6a2.5 2.5 0 0 0 3.4 3.4M9.9 5.1A9 9 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.4M6.2 6.2A17 17 0 0 0 2 12s3.5 7 10 7a9 9 0 0 0 3.5-.7",
  key: "M14 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM11 11 3 19M7 15l2 2M9 13l2 2",
  shield: "M12 3 4 6v5c0 4.5 3.2 7.8 8 10 4.8-2.2 8-5.5 8-10V6z",
  alert: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v5M12 16h.01",
  checkCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.4 12l2.5 2.5L15.8 9",
  xCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15 9l-6 6M9 9l6 6",
  link: "M9.5 14.5l5-5M10.8 6.9l1.6-1.6a4 4 0 0 1 5.7 5.7l-1.6 1.6M13.2 17.1l-1.6 1.6a4 4 0 0 1-5.7-5.7l1.6-1.6",
  cpu: "M6 6h12v12H6zM9.5 9.5h5v5h-5zM9 2.5v2M15 2.5v2M9 19.5v2M15 19.5v2M2.5 9h2M2.5 15h2M19.5 9h2M19.5 15h2",
  sliders: "M4 8h12M4 16h8M4 12h16M14 6v4M11 14v4",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  upload: "M5 20h14M12 16V4M7 9l5-5 5 5",
  memory: "M12 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 9v3M12 12l-4.2 3M12 12l4.2 3",
  code: "M9 8l-4 4 4 4M15 8l4 4-4 4M13.5 6l-3 12",
};

interface IconProps {
  name: string;
  size?: number;
  stroke?: number;
  fill?: boolean;
  style?: CSSProperties;
}

export function Icon({ name, size = 16, stroke = 1.6, fill = false, style }: IconProps) {
  const d = Ic[name] || "";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={style}
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} />
    </svg>
  );
}
