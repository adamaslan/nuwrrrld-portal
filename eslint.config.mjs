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
    ignores: [".next/**", "node_modules/**", ".vercel/**", ".claude/**"],
  },
];

export default config;
