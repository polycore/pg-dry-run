// @ts-check
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettierConfig from "eslint-config-prettier/flat";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Highlights:
 *   - `any`, non-null assertions, and `as` casts to broader types are errors.
 *   - Floating promises and useless `async` are errors.
 *   - `switch` statements must be exhausted.
 *   - Imports are auto-sorted and type-only where possible.
 *   - Class members must carry explicit accessibility.
 *   - Returns are inferred (no required annotations); semicolons are required.
 */
const SHARED_TS_RULES = {
  "@typescript-eslint/consistent-type-imports": [
    "error",
    { prefer: "type-imports", fixStyle: "separate-type-imports" },
  ],
  "@typescript-eslint/consistent-type-assertions": [
    "error",
    { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
  ],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": [
    "error",
    { checksVoidReturn: { attributes: false } },
  ],
  "@typescript-eslint/require-await": "error",
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/no-confusing-void-expression": [
    "error",
    { ignoreArrowShorthand: true, ignoreVoidOperator: true },
  ],
  "@typescript-eslint/return-await": ["error", "always"],
  "@typescript-eslint/switch-exhaustiveness-check": [
    "error",
    { considerDefaultExhaustiveForUnions: true },
  ],
  "@typescript-eslint/explicit-member-accessibility": [
    "error",
    { accessibility: "explicit", overrides: { constructors: "no-public" } },
  ],
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      destructuredArrayIgnorePattern: "^_",
    },
  ],
  // Return types are inferred by design.
  "@typescript-eslint/explicit-function-return-type": "off",
  "@typescript-eslint/explicit-module-boundary-types": "off",
  "no-restricted-syntax": [
    "error",
    {
      // Bans `x as unknown as Y`, the TS escape hatch that voids type safety.
      // Narrow with a type guard or an assert helper instead.
      selector:
        "TSAsExpression[expression.type='TSAsExpression'][expression.typeAnnotation.type='TSUnknownKeyword']",
      message:
        "Double `as unknown as X` casts are forbidden. Narrow with a type guard instead.",
    },
    {
      selector:
        "CallExpression[callee.type='MemberExpression'][callee.property.name='then']",
      message:
        "Prefer async/await over .then(). Wrap in an async IIFE at module top-level if needed.",
    },
    {
      selector:
        "CallExpression[callee.type='MemberExpression'][callee.property.name='catch']",
      message:
        "Prefer try/catch with async/await over .catch(). Wrap in an async IIFE at module top-level if needed.",
    },
  ],
};

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "**/*.d.ts",
  ]),

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "simple-import-sort": simpleImportSort },
    rules: {
      ...SHARED_TS_RULES,
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      eqeqeq: ["error", "smart"],
      "no-implicit-coercion": "error",
      "no-param-reassign": "error",
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": ["error", "always"],
      curly: ["error", "multi-line"],
    },
  },

  // Tests: relax the rules that fight test ergonomics.
  {
    files: ["tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/explicit-member-accessibility": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
      "no-restricted-syntax": "off",
    },
  },

  {
    files: ["vitest.config.ts"],
    rules: { "@typescript-eslint/explicit-member-accessibility": "off" },
  },

  // Standalone Node entries that live outside the tsconfig: this file itself,
  // and the Changesets changelog generator (loaded by the CLI via `require`).
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["eslint.config.mjs", ".changeset/changelog.cjs"],
    languageOptions: {
      globals: { ...globals.node },
      // No project context for these, so the type-aware parser must not try.
      parserOptions: { project: false, projectService: false },
    },
    rules: {
      // Spreading the preset above sets `rules`, so re-state them here rather
      // than replacing the whole object.
      ...tseslint.configs.disableTypeChecked.rules,
      // changelog.cjs is CommonJS because the Changesets CLI `require`s it.
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  prettierConfig,
);
