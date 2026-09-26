/** 의존성 없이 사용하는 간단한 SVG 아이콘 모음 */
type P = { className?: string };
const base = (className?: string) => ({
  className: className ?? "h-5 w-5",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
});

export const IconClose = ({ className }: P) => (
  <svg {...base(className)}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconLeft = ({ className }: P) => (
  <svg {...base(className)}><path d="M15 5l-7 7 7 7" /></svg>
);
export const IconRight = ({ className }: P) => (
  <svg {...base(className)}><path d="M9 5l7 7-7 7" /></svg>
);
export const IconDownload = ({ className }: P) => (
  <svg {...base(className)}><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" /></svg>
);
export const IconTrash = ({ className }: P) => (
  <svg {...base(className)}><path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" /></svg>
);
export const IconInfo = ({ className }: P) => (
  <svg {...base(className)}><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></svg>
);
export const IconZoomIn = ({ className }: P) => (
  <svg {...base(className)}><circle cx="11" cy="11" r="7" /><path d="M11 8v6M8 11h6M20 20l-4-4" /></svg>
);
export const IconZoomOut = ({ className }: P) => (
  <svg {...base(className)}><circle cx="11" cy="11" r="7" /><path d="M8 11h6M20 20l-4-4" /></svg>
);
export const IconStar = ({ className, filled }: P & { filled?: boolean }) => (
  <svg {...base(className)} fill={filled ? "currentColor" : "none"}>
    <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
  </svg>
);
export const IconUpload = ({ className }: P) => (
  <svg {...base(className)}><path d="M12 16V4m0 0l-4 4m4-4l4 4M5 16v2a2 2 0 002 2h10a2 2 0 002-2v-2" /></svg>
);
export const IconCamera = ({ className }: P) => (
  <svg {...base(className)}>
    <path d="M4 8a2 2 0 012-2h2l1.5-2h5L16 6h2a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);
export const IconPhotos = ({ className }: P) => (
  <svg {...base(className)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="2" />
    <path d="M21 16l-5-5-8 8" />
  </svg>
);
export const IconPlus = ({ className }: P) => (
  <svg {...base(className)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconCheck = ({ className }: P) => (
  <svg {...base(className)}><path d="M5 13l4 4L19 7" /></svg>
);
export const IconRetry = ({ className }: P) => (
  <svg {...base(className)}><path d="M4 12a8 8 0 0114-5.3L20 9M20 4v5h-5M20 12a8 8 0 01-14 5.3L4 15m0 5v-5h5" /></svg>
);
export const IconSearch = ({ className }: P) => (
  <svg {...base(className)}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
);
