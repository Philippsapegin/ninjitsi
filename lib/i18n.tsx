"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

export type Locale = "en" | "ru";

const LOCALE_STORAGE_KEY = "ninjitsi.locale";
const LOCALE_CHANGE_EVENT = "ninjitsi:locale-change";

function isLocale(value: string | null): value is Locale {
  return value === "en" || value === "ru";
}

export function getStoredLocale(): Locale {
  if (typeof window === "undefined") {
    return "en";
  }

  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);

  return isLocale(stored) ? stored : "en";
}

export function localize(
  locale: Locale,
  english: string,
  russian: string,
) {
  return locale === "ru" ? russian : english;
}

function subscribeToLocale(onStoreChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOCALE_STORAGE_KEY) {
      onStoreChange();
    }
  };

  window.addEventListener("storage", onStorage);
  window.addEventListener(LOCALE_CHANGE_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LOCALE_CHANGE_EVENT, onStoreChange);
  };
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  tr: (english: string, russian: string) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore(
    subscribeToLocale,
    getStoredLocale,
    () => "en" as Locale,
  );
  const setLocale = useCallback((nextLocale: Locale) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    window.dispatchEvent(new Event(LOCALE_CHANGE_EVENT));
  }, []);
  const tr = useCallback(
    (english: string, russian: string) =>
      localize(locale, english, russian),
    [locale],
  );
  const value = useMemo(
    () => ({ locale, setLocale, tr }),
    [locale, setLocale, tr],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);

  if (!context) {
    throw new Error("useI18n must be used inside I18nProvider");
  }

  return context;
}
