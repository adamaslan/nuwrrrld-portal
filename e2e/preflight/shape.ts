import { expect } from "@playwright/test";

/**
 * Assert an env var exists and matches an expected prefix — never logs the
 * value, only the variable name and the expected prefixes.
 *
 * Shared by the core and billing preflight specs so the two can't drift in
 * how they report a bad credential.
 */
export function expectKeyShape(name: string, prefixes: string[]): void {
  const value = process.env[name];
  expect(value, `${name} is not set`).toBeTruthy();
  expect(
    prefixes.some((p) => value!.startsWith(p)),
    `${name} does not start with any of ${prefixes.join("|")} (value not shown)`,
  ).toBe(true);
  // Catches the copy-paste classic: a trailing newline that produces
  // "Invalid character in header content [Authorization]" at request time.
  expect(value, `${name} has leading/trailing whitespace`).toBe(value!.trim());
}
