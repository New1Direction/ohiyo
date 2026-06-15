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
    linterOptions: {
      // A disable directive that no longer suppresses anything is itself an error —
      // keeps the per-line a11y/hook exceptions below honest as the code evolves.
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // Hook correctness — non-negotiable (ECC react/hooks.md).
      "react-hooks/rules-of-hooks": "error",
      // exhaustive-deps stays a warning (react/hooks.md); the few intentional
      // exceptions (connect-once gateway, unmount-only teardown, id-keyed effect)
      // carry per-line disables with justifications, so the live count is zero.
      "react-hooks/exhaustive-deps": "warn",
      // Keep noisy-but-not-bugs rules as warnings to preserve a green gate.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // a11y: ERRORS — a new violation fails the gate. The deliberate, already-
      // mitigated patterns (dismiss scrims, focus-trap dialogs, aria-activedescendant
      // listboxes, inline editors that focus on open, event-containment wrappers)
      // each carry a per-line eslint-disable with a written justification.
      "jsx-a11y/media-has-caption": "off", // live WebRTC call <video>/<audio> — captions N/A
      "jsx-a11y/no-autofocus": "error",
      "jsx-a11y/click-events-have-key-events": "error",
      "jsx-a11y/no-static-element-interactions": "error",
      "jsx-a11y/no-noninteractive-element-interactions": "error",
      "jsx-a11y/interactive-supports-focus": "error",
      "jsx-a11y/label-has-associated-control": "error",
    },
  },
);
