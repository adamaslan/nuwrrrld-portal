/**
 * Shared by playwright.config.ts (project `use.storageState`) and
 * e2e/auth.setup.ts (where it's written). Kept in its own module — importing
 * auth.setup.ts directly from the config would register its `setup(...)`
 * call outside a test file's context and Playwright refuses to load.
 */
export const STORAGE_STATE_PATH = "playwright/.auth/user.json";
