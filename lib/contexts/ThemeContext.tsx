'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

export type ThemeId = 'default' | 'light' | 'dark-orange';

export interface ThemePreview {
  bg: string;
  surface: string;
  accent: string;
  text: string;
}

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  description: string;
  preview: ThemePreview;
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'default',
    label: 'Dark',
    description: 'Glass dark',
    preview: {
      bg: '#050508',
      surface: '#0d1b30',
      accent: '#3b82f6',
      text: '#e4e4e7',
    },
  },
  {
    id: 'light',
    label: 'Light',
    description: 'White & black',
    preview: {
      bg: '#ffffff',
      surface: '#e8edf5',
      accent: '#2563eb',
      text: '#0f172a',
    },
  },
  {
    id: 'dark-orange',
    label: 'Dark Orange',
    description: 'Warm accent',
    preview: {
      bg: '#050508',
      surface: '#1c1008',
      accent: '#f97316',
      text: '#e4e4e7',
    },
  },
];

const STORAGE_KEY = 'devflow-theme';

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'default',
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>('default');

  // Hydrate from localStorage on mount — avoids SSR mismatch
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    if (saved && THEMES.some(t => t.id === saved)) {
      setThemeState(saved);
    }
  }, []);

  // Apply data-theme attribute whenever theme changes
  useEffect(() => {
    if (theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme: setThemeState }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
