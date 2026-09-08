import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveDbHost,
  assertNotProductionDb,
  ProductionDbWriteError,
  __resetDbGuardWarnLatch,
} from "@/lib/pipeline-db-guard";

// No credentials in these fixtures on purpose — the secret scanner flags any
// `scheme://user:pass@host` shape, and resolveDbHost only reads the hostname.
const DEV_URL = "postgresql://ep-dev-branch-123.us-east-1.aws.neon.tech/neondb?sslmode=require";
const PROD_HOST = "ep-prod-branch-999.us-east-1.aws.neon.tech";
const PROD_URL = `postgresql://${PROD_HOST}/neondb?sslmode=require`;

describe("resolveDbHost", () => {
  it("extracts the lower-cased host from a Neon connection URL", () => {
    expect(resolveDbHost(DEV_URL)).toBe("ep-dev-branch-123.us-east-1.aws.neon.tech");
    expect(resolveDbHost(PROD_URL)).toBe(PROD_HOST);
  });

  it("returns null for an unparseable or empty value", () => {
    expect(resolveDbHost("")).toBeNull();
    expect(resolveDbHost(undefined)).toBeNull();
    expect(resolveDbHost("not a url")).toBeNull();
  });
});

describe("assertNotProductionDb", () => {
  const OLD = { DATABASE_URL: process.env.DATABASE_URL, PRODUCTION_DB_HOST: process.env.PRODUCTION_DB_HOST };

  beforeEach(() => {
    __resetDbGuardWarnLatch();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env.DATABASE_URL = OLD.DATABASE_URL;
    process.env.PRODUCTION_DB_HOST = OLD.PRODUCTION_DB_HOST;
    vi.restoreAllMocks();
  });

  it("throws when DATABASE_URL resolves to PRODUCTION_DB_HOST", () => {
    process.env.DATABASE_URL = PROD_URL;
    process.env.PRODUCTION_DB_HOST = PROD_HOST;
    expect(() => assertNotProductionDb("test op")).toThrow(ProductionDbWriteError);
  });

  it("allows when the hosts differ", () => {
    process.env.DATABASE_URL = DEV_URL;
    process.env.PRODUCTION_DB_HOST = PROD_HOST;
    expect(() => assertNotProductionDb("test op")).not.toThrow();
  });

  it("is inert (and warns once) when PRODUCTION_DB_HOST is unset", () => {
    process.env.DATABASE_URL = PROD_URL;
    delete process.env.PRODUCTION_DB_HOST;
    expect(() => assertNotProductionDb("test op")).not.toThrow();
    expect(() => assertNotProductionDb("test op")).not.toThrow();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    process.env.DATABASE_URL = PROD_URL;
    process.env.PRODUCTION_DB_HOST = `  ${PROD_HOST.toUpperCase()}  `;
    expect(() => assertNotProductionDb("test op")).toThrow(ProductionDbWriteError);
  });
});
