export type ThemeVar = {
  "--bg-base": string;
  "--bg-sidebar": string;
  "--bg-channel": string;
  "--bg-input": string;
  "--bg-hover": string;
  "--text-primary": string;
  "--text-secondary": string;
  "--text-muted": string;
  "--accent": string;
  "--accent-hover": string;
  "--danger": string;
  "--green": string;
};

export type Theme = {
  id: string;
  name: string;
  author?: string;
  vars: ThemeVar;
};

export const BUILTIN_THEMES: Theme[] = [
  {
    id: "chrome-blue",
    name: "Chrome Blue",
    author: "Ohiyo",
    vars: {
      "--bg-base": "#10100f",
      "--bg-sidebar": "#171716",
      "--bg-channel": "#22211f",
      "--bg-input": "#2f2d2a",
      "--bg-hover": "#3b3935",
      "--text-primary": "#f2f4f5",
      "--text-secondary": "#c8d0d5",
      "--text-muted": "#909ca4",
      "--accent": "#62b0dc",
      "--accent-hover": "#3d82ad",
      "--danger": "#d86647",
      "--green": "#76a783",
    },
  },
  {
    id: "sage-grove",
    name: "Sage Grove",
    author: "Ohiyo",
    vars: {
      "--bg-base": "#10120f",
      "--bg-sidebar": "#171a16",
      "--bg-channel": "#21251f",
      "--bg-input": "#2d332b",
      "--bg-hover": "#394137",
      "--text-primary": "#f0f4ed",
      "--text-secondary": "#c4d1c0",
      "--text-muted": "#8fa087",
      "--accent": "#76a783",
      "--accent-hover": "#4e7b5d",
      "--danger": "#d86647",
      "--green": "#76a783",
    },
  },
  {
    id: "copper-forge",
    name: "Copper Forge",
    author: "Ohiyo",
    vars: {
      "--bg-base": "#141312",
      "--bg-sidebar": "#1d1c1a",
      "--bg-channel": "#2a2926",
      "--bg-input": "#3b3935",
      "--bg-hover": "#4b443d",
      "--text-primary": "#f7f8f8",
      "--text-secondary": "#d2c8ba",
      "--text-muted": "#9ca8af",
      "--accent": "#e1732c",
      "--accent-hover": "#bf5d22",
      "--danger": "#e0483f",
      "--green": "#76a783",
    },
  },
  {
    id: "daybreak",
    name: "Daybreak",
    author: "Ohiyo",
    vars: {
      "--bg-base": "#f4e9dd",
      "--bg-sidebar": "#fbf3ea",
      "--bg-channel": "#fffcf8",
      "--bg-input": "#f3e7da",
      "--bg-hover": "#f1e2d2",
      "--text-primary": "#2a2320",
      "--text-secondary": "#6b5d54",
      "--text-muted": "#9a8c82",
      "--accent": "#f2683c",
      "--accent-hover": "#db5429",
      "--danger": "#e0483f",
      "--green": "#1f9e6b",
    },
  },
  {
    id: "dusk",
    name: "Dusk",
    author: "Ohiyo",
    vars: {
      "--bg-base": "#171311",
      "--bg-sidebar": "#1e1815",
      "--bg-channel": "#211c19",
      "--bg-input": "#2a2320",
      "--bg-hover": "#322a25",
      "--text-primary": "#f5ece4",
      "--text-secondary": "#c5b4a7",
      "--text-muted": "#8a7a6e",
      "--accent": "#ff7a4d",
      "--accent-hover": "#ff9166",
      "--danger": "#f2685f",
      "--green": "#3fc489",
    },
  },
  {
    id: "kikkacord-dark",
    name: "Ohiyo Dark",
    author: "Ohiyo",
    vars: {
      "--bg-base": "#1e1f22",
      "--bg-sidebar": "#2b2d31",
      "--bg-channel": "#313338",
      "--bg-input": "#383a40",
      "--bg-hover": "#35373c",
      "--text-primary": "#f2f3f5",
      "--text-secondary": "#b5bac1",
      "--text-muted": "#80848e",
      "--accent": "#5865f2",
      "--accent-hover": "#4752c4",
      "--danger": "#ed4245",
      "--green": "#23a55a",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    author: "Ohiyo",
    vars: {
      "--bg-base": "#0d0e12",
      "--bg-sidebar": "#14151a",
      "--bg-channel": "#1a1b22",
      "--bg-input": "#22232c",
      "--bg-hover": "#1e1f28",
      "--text-primary": "#e8e9f0",
      "--text-secondary": "#a0a3b1",
      "--text-muted": "#5c5f70",
      "--accent": "#7c6dfa",
      "--accent-hover": "#6557e0",
      "--danger": "#e05c67",
      "--green": "#1fa54b",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    author: "Ohiyo",
    vars: {
      "--bg-base": "#1a1b2e",
      "--bg-sidebar": "#16213e",
      "--bg-channel": "#1e2140",
      "--bg-input": "#252848",
      "--bg-hover": "#2a2d50",
      "--text-primary": "#c0caf5",
      "--text-secondary": "#9aa5ce",
      "--text-muted": "#565f89",
      "--accent": "#7aa2f7",
      "--accent-hover": "#5b7fe0",
      "--danger": "#f7768e",
      "--green": "#9ece6a",
    },
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    author: "Ohiyo",
    vars: {
      "--bg-base": "#191724",
      "--bg-sidebar": "#1f1d2e",
      "--bg-channel": "#26233a",
      "--bg-input": "#2a2741",
      "--bg-hover": "#2d2a43",
      "--text-primary": "#e0def4",
      "--text-secondary": "#c4a0b5",
      "--text-muted": "#6e6a86",
      "--accent": "#c4a7e7",
      "--accent-hover": "#b08fd4",
      "--danger": "#eb6f92",
      "--green": "#9ccfd8",
    },
  },
  {
    id: "light",
    name: "Ohiyo Light",
    author: "Ohiyo",
    vars: {
      "--bg-base": "#e3e5e8",
      "--bg-sidebar": "#f2f3f5",
      "--bg-channel": "#ffffff",
      "--bg-input": "#ebedef",
      "--bg-hover": "#e0e1e5",
      "--text-primary": "#2e3338",
      "--text-secondary": "#4f545c",
      "--text-muted": "#747f8d",
      "--accent": "#5865f2",
      "--accent-hover": "#4752c4",
      "--danger": "#ed4245",
      "--green": "#2d7d46",
    },
  },
  {
    id: "amoled",
    name: "AMOLED Black",
    author: "Ohiyo",
    vars: {
      "--bg-base": "#000000",
      "--bg-sidebar": "#0a0a0a",
      "--bg-channel": "#111111",
      "--bg-input": "#1a1a1a",
      "--bg-hover": "#151515",
      "--text-primary": "#ffffff",
      "--text-secondary": "#cccccc",
      "--text-muted": "#666666",
      "--accent": "#00d4ff",
      "--accent-hover": "#00b8e0",
      "--danger": "#ff4444",
      "--green": "#00cc66",
    },
  },
];

const STORAGE_KEY = "kikkacord:theme";
const CUSTOM_THEMES_KEY = "kikkacord:custom-themes";

const DEFAULT_THEME: Theme = BUILTIN_THEMES[0];

/** A theme is only usable if its `vars` is a non-null object — a partial blob (no vars)
 *  would otherwise blow up at Object.entries(theme.vars) on first paint. */
function isValidTheme(t: unknown): t is Theme {
  return (
    !!t &&
    typeof t === "object" &&
    typeof (t as Theme).vars === "object" &&
    (t as Theme).vars !== null
  );
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  // Reset to the default theme's FULL var set first, then overlay this theme. A theme
  // that omits some keys (custom/imported) would otherwise inherit the previous theme's
  // values for those keys — cross-theme color bleed.
  for (const [k, v] of Object.entries(DEFAULT_THEME.vars)) {
    root.style.setProperty(k, v);
  }
  for (const [k, v] of Object.entries(theme.vars)) {
    root.style.setProperty(k, v);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
}

export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isValidTheme(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return DEFAULT_THEME;
}

export function getCustomThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Keep only well-formed themes so a partial entry can't reach applyTheme.
      if (Array.isArray(parsed)) return parsed.filter(isValidTheme);
    }
  } catch {
    // ignore
  }
  return [];
}

export function saveCustomTheme(theme: Theme) {
  const themes = getCustomThemes().filter((t) => t.id !== theme.id);
  themes.push(theme);
  localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes));
}

export function deleteCustomTheme(id: string) {
  const themes = getCustomThemes().filter((t) => t.id !== id);
  localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes));
}

export function exportTheme(theme: Theme): string {
  return JSON.stringify(theme, null, 2);
}

export function importTheme(json: string): Theme {
  const t = JSON.parse(json) as Theme;
  if (!t.id || !t.name || !t.vars) throw new Error("Invalid theme JSON");
  return t;
}

// ── Visual theme editor support ─────────────────────────────────────────────
/** The 12 theme colors grouped + labeled for the editor's color pickers. */
export const THEME_VAR_GROUPS: { group: string; vars: { key: keyof ThemeVar; label: string }[] }[] = [
  {
    group: "Backgrounds",
    vars: [
      { key: "--bg-base", label: "Base" },
      { key: "--bg-sidebar", label: "Sidebar" },
      { key: "--bg-channel", label: "Channel" },
      { key: "--bg-input", label: "Input" },
      { key: "--bg-hover", label: "Hover" },
    ],
  },
  {
    group: "Text",
    vars: [
      { key: "--text-primary", label: "Primary" },
      { key: "--text-secondary", label: "Secondary" },
      { key: "--text-muted", label: "Muted" },
    ],
  },
  {
    group: "Accents",
    vars: [
      { key: "--accent", label: "Accent" },
      { key: "--accent-hover", label: "Accent hover" },
      { key: "--green", label: "Success" },
      { key: "--danger", label: "Danger" },
    ],
  },
];

/** A unique id for a user-built theme. */
export function makeThemeId(): string {
  const rnd =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return "custom-" + rnd;
}

/** Build a custom theme from a name + edited vars (copies vars; defaults a blank name). */
export function createCustomTheme(name: string, vars: ThemeVar, id?: string): Theme {
  return { id: id ?? makeThemeId(), name: name.trim() || "My Theme", author: "You", vars: { ...vars } };
}
