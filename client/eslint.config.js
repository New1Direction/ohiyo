import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

// Flat config (ESLint 9). Guardrail for the React/TS client: hook correctness and
// accessibility are hard errors; stylistic/type-strictness rules are warnings so
// the build gate stays actionable on an existing codebase.
export default tseslint.config(
  { ignores: ["dist/**", "src-tauri/**", "node_modules/**", "*.config.js", "*.config.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Hook correctness — non-negotiable (ECC react/hooks.md).
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Keep noisy-but-not-bugs rules as warnings to preserve a green gate.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // a11y: keep recommended at error EXCEPT these, which fire on deliberate,
      // already-mitigated patterns in this app. They stay visible as warnings so
      // a new violation of any OTHER a11y rule still fails the gate.
      "jsx-a11y/media-has-caption": "off", // live WebRTC call <video>/<audio> — captions N/A
      "jsx-a11y/no-autofocus": "warn", // modal/rename inputs focus deliberately on open
      "jsx-a11y/click-events-have-key-events": "warn", // dismiss scrims (Escape already closes)
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/interactive-supports-focus": "warn", // listbox uses aria-activedescendant, not roving tabindex
      "jsx-a11y/label-has-associated-control": "warn",
    },
  },
);
