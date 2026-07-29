import type { SVGProps } from 'react';

const base = (props: SVGProps<SVGSVGElement>) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...props,
});

export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);

export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></svg>
);

export const IconDots = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <circle cx="12" cy="5.5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="18.5" r="1.7" />
  </svg>
);

export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>
);

export const IconChevronLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="m14.5 5.5-6.5 6.5 6.5 6.5" /></svg>
);

export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="m9.5 5.5 6.5 6.5-6.5 6.5" /></svg>
);

export const IconArrowLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M19 12H5M11.5 5.5 5 12l6.5 6.5" /></svg>
);

export const IconType = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4.5 19 10 5h1.6l5.5 14M6.4 14.5h8.8" /><path d="M15.5 19l2.4-6h1l2.4 6" opacity="0.55" /></svg>
);

export const IconContents = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M5 6.5h9M5 12h14M5 17.5h11" /></svg>
);

export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4.5 6.5h15M9.8 3.8h4.4M6.3 6.5l.9 13a1.6 1.6 0 0 0 1.6 1.5h6.4a1.6 1.6 0 0 0 1.6-1.5l.9-13M10 10.5v6M14 10.5v6" /></svg>
);

export const IconRefresh = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M20 12a8 8 0 1 1-2.3-5.6M20 3.5v3.6h-3.6" /></svg>
);

export const IconUpload = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 16V4.5M7.5 8.5 12 4l4.5 4.5" /><path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" /></svg>
);

export const IconBook = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 6.8C10 5.2 6.9 5.2 5 6.3v11.5c1.9-1.1 5-1.1 7 .5 2-1.6 5.1-1.6 7-.5V6.3c-1.9-1.1-5-1.1-7 .5Z" /><path d="M12 6.8v11.5" /></svg>
);

export const IconInfo = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 7.8v.4" /></svg>
);

export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
);

export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 4 2.8 19.5h18.4L12 4ZM12 10v4.4M12 17.2v.4" /></svg>
);

export const IconBookmark = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M7 3.5h10a1 1 0 0 1 1 1V21l-6-4-6 4V4.5a1 1 0 0 1 1-1Z" /></svg>
);

export const IconFullscreen = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 4.5H6a1.5 1.5 0 0 0-1.5 1.5v3M15 4.5h3A1.5 1.5 0 0 1 19.5 6v3M9 19.5H6A1.5 1.5 0 0 1 4.5 18v-3M15 19.5h3a1.5 1.5 0 0 0 1.5-1.5v-3" />
  </svg>
);

export const IconFullscreenExit = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 4.5v3A1.5 1.5 0 0 1 7.5 9h-3M15 4.5v3A1.5 1.5 0 0 0 16.5 9h3M9 19.5v-3A1.5 1.5 0 0 0 7.5 15h-3M15 19.5v-3a1.5 1.5 0 0 1 1.5-1.5h3" />
  </svg>
);

export const IconZoomIn = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2M11 8.5v5M8.5 11h5" /></svg>
);

export const IconZoomOut = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2M8.5 11h5" /></svg>
);
