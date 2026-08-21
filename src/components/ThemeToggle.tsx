"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "ตามระบบ", light: "สว่าง", dark: "มืด" };
export const THEME_STORAGE_KEY = "workload-theme";

/** The attribute is written before paint by the inline script in the layout,
 *  so reading it here is what the page is already showing. */
function currentTheme(): Theme {
  if (typeof document === "undefined") return "system";
  const value = document.documentElement.getAttribute("data-theme");
  return value === "light" || value === "dark" ? value : "system";
}

/** Follows the system by default; an explicit choice is remembered per browser. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      root.setAttribute("data-theme", theme);
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  }, [theme]);

  return (
    <button
      type="button"
      className="cursor-pointer text-[13px] text-muted transition-colors hover:text-foreground"
      title="สลับธีม สว่าง มืด หรือตามระบบ"
      onClick={() => setTheme((t) => NEXT[t])}
      // Server renders "ตามระบบ"; the client may already be on a saved theme.
      suppressHydrationWarning
    >
      {LABEL[theme]}
    </button>
  );
}
