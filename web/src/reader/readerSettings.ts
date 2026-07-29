import { useCallback, useState } from 'react';

export type ReaderTheme = 'paper' | 'sepia' | 'dusk';
export type ReaderFont = 'literata' | 'georgia' | 'sans';
export type SpreadMode = 'auto' | 'single' | 'double';

export interface ReaderSettings {
  theme: ReaderTheme;
  font: ReaderFont;
  fontSize: number; // px
  lineHeight: number;
  spread: SpreadMode;
  /** false = "Quire style": override publisher fonts/colors for clean, legible pages */
  pubStyles: boolean;
}

export const READER_THEMES: Record<ReaderTheme, { bg: string; stage: string; text: string; faint: string; accent: string; label: string }> = {
  paper: { bg: '#f9f5ec', stage: '#eee7d8', text: '#26201a', faint: '#8d8271', accent: '#b04f2c', label: 'Paper' },
  sepia: { bg: '#f3e6cd', stage: '#e7d6b6', text: '#46351f', faint: '#967f5d', accent: '#9c4a20', label: 'Sepia' },
  dusk: { bg: '#181512', stage: '#100e0b', text: '#d9d0bf', faint: '#7a7160', accent: '#d97e50', label: 'Dusk' },
};

const DEFAULTS: ReaderSettings = {
  theme: 'paper',
  font: 'literata',
  fontSize: 19,
  lineHeight: 1.62,
  spread: 'auto',
  pubStyles: false,
};

const KEY = 'quire:reader-settings';

export function useReaderSettings(): [ReaderSettings, (patch: Partial<ReaderSettings>) => void] {
  const [settings, setSettings] = useState<ReaderSettings>(() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
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
