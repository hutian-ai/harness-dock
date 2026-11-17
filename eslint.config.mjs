import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/target/**",
      "third-party/**",
      "patches/**",
      ".local/**",
      ".agents/**",
      ".husky/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
);
