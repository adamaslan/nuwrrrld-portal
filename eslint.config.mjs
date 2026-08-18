import { createRequire } from "module";
import tseslint from "typescript-eslint";

const require = createRequire(import.meta.url);
// eslint-config-next exports a flat-config array that bundles react,
// react-hooks, import, jsx-a11y, and @next/next — more complete than
// spreading @next/eslint-plugin-next directly.
const nextConfig = require("eslint-config-next");

const config = [
  ...nextConfig,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      ".vercel/**",
      ".claude/**",
      // Playwright-generated artifacts. These are gitignored, but eslint does
      // not read .gitignore — without these entries a local test run leaves
      // behind a bundled trace viewer (minified vendor JS) that eslint then
      // lints, producing thousands of errors from code we don't own.
      "playwright-report/**",
      "blob-report/**",
      "test-results/**",
      "playwright/.cache/**",
      ".nulogdash/**",
    ],
  },
];

export default config;
