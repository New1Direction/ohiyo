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
    id: "daybreak",
    name: "Daybreak",
    author: "Kikkacord",
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
    author: "Kikkacord",
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
    name: "Kikkacord Dark",
    author: "Kikkacord",
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
    author: "Kikkacord",
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
    author: "Kikkacord",
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
    author: "Kikkacord",
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
    name: "Kikkacord Light",
    author: "Kikkacord",
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
    author: "Kikkacord",
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

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars)) {
    root.style.setProperty(k, v);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
}

export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Theme;
  } catch {
    // ignore
  }
  return BUILTIN_THEMES[0];
}

export function getCustomThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (raw) return JSON.parse(raw) as Theme[];
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
