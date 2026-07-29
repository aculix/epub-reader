import { useCallback, useState } from 'react';

export type ReaderTheme = 'paper' | 'sepia' | 'dusk';
export type ReaderFont = 'literata' | 'georgia' | 'sans';
/** How a page turn is animated. Curl is a 3D pivot; slide is a flat push. */
export type TurnStyle = 'curl' | 'slide' | 'none';
export type SpreadMode = 'auto' | 'single' | 'double';

export interface ReaderSettings {
  theme: ReaderTheme;
  font: ReaderFont;
  fontSize: number; // px
  lineHeight: number;
  spread: SpreadMode;
  /** false = "Quire style": override publisher fonts/colors for clean, legible pages */
  pubStyles: boolean;
  turn: TurnStyle;
}

export interface ReaderThemeSpec {
  bg: string;
  stage: string;
  text: string;
  faint: string;
  accent: string;
  label: string;
  /**
   * Local re-definitions of the app design tokens. Applied on the reader root
   * so ALL reader chrome (bars, TOC, settings, toasts) follows the reader's
   * own theme — the app-level light/dark toggle must not leak in.
   */
  vars: Record<string, string>;
}

const LIGHT_SHADOWS = {
  '--shadow-sm': '0 1px 2px rgba(51,37,15,0.08), 0 2px 8px rgba(51,37,15,0.06)',
  '--shadow-md': '0 2px 6px rgba(51,37,15,0.1), 0 14px 34px rgba(51,37,15,0.13)',
  '--shadow-lg': '0 8px 18px rgba(51,37,15,0.14), 0 28px 70px rgba(51,37,15,0.22)',
};

const DARK_SHADOWS = {
  '--shadow-sm': '0 1px 2px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.3)',
  '--shadow-md': '0 2px 6px rgba(0,0,0,0.4), 0 14px 34px rgba(0,0,0,0.45)',
  '--shadow-lg': '0 8px 18px rgba(0,0,0,0.5), 0 28px 70px rgba(0,0,0,0.6)',
};

export const READER_THEMES: Record<ReaderTheme, ReaderThemeSpec> = {
  paper: {
    bg: '#f9f5ec', stage: '#eee7d8', text: '#26201a', faint: '#8d8271', accent: '#b04f2c', label: 'Paper',
    vars: {
      '--bg': '#f9f5ec', '--bg-deep': '#eee7d8', '--surface': '#fffdf8', '--surface-2': '#f4efe4',
      '--ink': '#26201a', '--ink-2': '#5f574a', '--ink-3': '#776c57',
      '--line': 'rgba(64,50,28,0.15)', '--line-soft': 'rgba(64,50,28,0.08)',
      '--accent': '#b04f2c', '--accent-strong': '#93401f', '--accent-soft': '#f3e2d6', '--on-accent': '#fdf6ec',
      ...LIGHT_SHADOWS,
    },
  },
  sepia: {
    bg: '#f3e6cd', stage: '#e7d6b6', text: '#46351f', faint: '#967f5d', accent: '#9c4a20', label: 'Sepia',
    vars: {
      '--bg': '#f3e6cd', '--bg-deep': '#e7d6b6', '--surface': '#faf0dc', '--surface-2': '#eee0c2',
      '--ink': '#46351f', '--ink-2': '#6f5c40', '--ink-3': '#6b5734',
      '--line': 'rgba(70,53,31,0.18)', '--line-soft': 'rgba(70,53,31,0.09)',
      '--accent': '#9c4a20', '--accent-strong': '#7e3a17', '--accent-soft': '#ecd9bd', '--on-accent': '#fdf4e3',
      ...LIGHT_SHADOWS,
    },
  },
  dusk: {
    bg: '#181512', stage: '#100e0b', text: '#d9d0bf', faint: '#7a7160', accent: '#d97e50', label: 'Dusk',
    vars: {
      '--bg': '#181512', '--bg-deep': '#100e0b', '--surface': '#211c15', '--surface-2': '#2a241b',
      '--ink': '#ede4d3', '--ink-2': '#b0a48e', '--ink-3': '#a2967f',
      '--line': 'rgba(237,228,211,0.14)', '--line-soft': 'rgba(237,228,211,0.07)',
      '--accent': '#d97e50', '--accent-strong': '#e69268', '--accent-soft': '#3a281d', '--on-accent': '#221207',
      ...DARK_SHADOWS,
    },
  },
};

const DEFAULTS: ReaderSettings = {
  theme: 'paper',
  font: 'literata',
  fontSize: 19,
  lineHeight: 1.62,
  spread: 'auto',
  pubStyles: false,
  turn: 'curl',
};

const KEY = 'quire:reader-settings';

export function useReaderSettings(): [ReaderSettings, (patch: Partial<ReaderSettings>) => void] {
  const [settings, setSettings] = useState<ReaderSettings>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<ReaderSettings> & { v?: number };
      // A briefly-shipped build stored theme:'auto'; map it back to paper
      if ((stored.theme as string) === 'auto') stored.theme = 'paper';
      delete stored.v;
      return { ...DEFAULTS, ...stored };
    } catch {
      return DEFAULTS;
    }
  });

  const update = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return [settings, update];
}
