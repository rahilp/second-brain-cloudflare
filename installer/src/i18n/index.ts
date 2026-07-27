import { en } from "./en";
import { it } from "./it";
import type { Locale, Messages } from "./types";

export const LOCALE_STORAGE_KEY = "sb-locale";
export const LOCALE_CHANGE_EVENT = "sb-locale-change";

const catalogs: Record<Locale, Messages> = { en, it };

let currentLocale: Locale = "en";

function readStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "it") return stored;
  } catch {
    /* private mode / unavailable */
  }
  const nav = navigator.language?.toLowerCase() ?? "";
  if (nav.startsWith("it")) return "it";
  return "en";
}

export function initI18n(): Locale {
  currentLocale = readStoredLocale();
  document.documentElement.lang = currentLocale === "it" ? "it" : "en";
  return currentLocale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = locale === "it" ? "it" : "en";
  window.dispatchEvent(new CustomEvent(LOCALE_CHANGE_EVENT, { detail: locale }));
}

type Path = keyof Messages | `${keyof Messages}.${string}`;

function resolve(path: string, messages: Messages): string | undefined {
  const parts = path.split(".");
  let node: unknown = messages;
  for (const part of parts) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Translate a dotted key. Optional `{name}` placeholders in the string. */
export function t(path: Path, params?: Record<string, string>): string {
  const raw =
    resolve(path, catalogs[currentLocale]) ??
    resolve(path, catalogs.en) ??
    path;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? `{${key}}`);
}

export function settingsSection(onChange?: () => void): HTMLElement {
  const select = document.createElement("select");
  select.className = "locale-select";
  for (const opt of [
    { value: "en" as Locale, label: t("settings.english") },
    { value: "it" as Locale, label: t("settings.italian") },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    select.append(o);
  }
  select.value = getLocale();
  select.addEventListener("change", () => {
    setLocale(select.value as Locale);
    onChange?.();
  });

  const label = document.createElement("div");
  label.className = "url-label";
  label.textContent = t("settings.language");

  const desc = document.createElement("div");
  desc.className = "url-desc";
  desc.textContent = t("settings.languageDesc");

  const card = document.createElement("div");
  card.className = "card settings-card";
  const title = document.createElement("div");
  title.className = "url-label";
  title.textContent = t("settings.title");
  card.append(title, desc, label, select);
  return card;
}
