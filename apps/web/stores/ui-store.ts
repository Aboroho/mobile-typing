import { create } from 'zustand';

export interface Toast {
  id: string;
  message: string;
  tone: 'info' | 'success' | 'error';
}

type Theme = 'light' | 'dark';

interface UiState {
  theme: Theme;
  toasts: Toast[];
  /** True while the privacy overlay is up (tab hidden / triple tap). */
  privacyLocked: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  pushToast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: string) => void;
  setPrivacyLocked: (locked: boolean) => void;
}

const THEME_KEY = 'mt:theme';

function initialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: 'light',
  toasts: [],
  privacyLocked: false,
  setTheme(theme) {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      document.documentElement.classList.toggle('privacy-locked', get().privacyLocked);
      window.localStorage.setItem(THEME_KEY, theme);
    }
    set({ theme });
  },
  toggleTheme() {
    get().setTheme(get().theme === 'dark' ? 'light' : 'dark');
  },
  pushToast(message, tone = 'info') {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    set({ toasts: [...get().toasts, { id, message, tone }] });
    setTimeout(() => get().dismissToast(id), 4000);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
  },
  setPrivacyLocked(locked) {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('privacy-locked', locked);
    }
    set({ privacyLocked: locked });
  },
}));

export function initTheme(): void {
  useUiStore.getState().setTheme(initialTheme());
}
