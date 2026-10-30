import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs module, no type declarations
import {
  fetchTableChunks,
  isResponseTooLargeError,
  DEFAULT_CHUNK_ROWS,
  MIN_CHUNK_ROWS,
} from "../scripts/backup-pagination.mjs";

type Row = Record<string, string | number>;

/** Compare two key tuples the way Postgres ORDER BY would (mixed text/int). */
function compareTuples(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/**
 * Fake Postgres: understands exactly the query shape fetchTableChunks emits
 * (optional row-value keyset WHERE, ORDER BY, LIMIT/OFFSET) and applies it
 * to an in-memory table. Records every call for assertions.
 */
function makeFakeBackend(rows: Row[], orderBy: string[]) {
  const calls: { text: string; params: unknown[] }[] = [];
  const query = async (text: string, params: unknown[]): Promise<Row[]> => {
    calls.push({ text, params });
    const limit = Number(text.match(/LIMIT (\d+)/)![1]);
    const offset = Number(text.match(/OFFSET (\d+)/)?.[1] ?? 0);
    let out = [...rows].sort((ra, rb) =>
      compareTuples(orderBy.map((c) => ra[c]), orderBy.map((c) => rb[c])),
    );
    if (params.length > 0) {
      out = out.filter(
        (r) => compareTuples(orderBy.map((c) => r[c]), params as (string | number)[]) > 0,
      );
    }
    return out.slice(offset, offset + limit);
  };
  return { query, calls };
}

/** Composite PK (ticker text, seq int) like daily_bars' (ticker, feed, bar_date). */
function makeRows(perTicker: number): Row[] {
  const rows: Row[] = [];
  for (const ticker of ["AAPL", "MSFT", "SPY"]) {
    for (let seq = 1; seq <= perTicker; seq++) {
      rows.push({ ticker, seq, close: 100 + seq });
    }
  }
  return rows;
}

const PK = ["ticker", "seq"];
const COLS = ["ticker", "seq", "close"];
const SELECT_LIST = COLS.map((c) => `"${c}"`).join(", ");

type QueryFn = (text: string, params: unknown[]) => Promise<Row[]>;

type ChunkOpts = {
  table: string;
  selectList: string;
  selectColumns: string[];
  pkColumns?: string[];
  chunkRows?: number;
  minChunkRows?: number;
};

async function collect(query: QueryFn, opts: ChunkOpts): Promise<Row[]> {
  const out: Row[] = [];
  for await (const chunk of fetchTableChunks(query, opts)) out.push(...chunk);
  return out;
}

describe("fetchTableChunks", () => {
  it("keyset-paginates a composite-PK table in order, every row exactly once", async () => {
    const rows = makeRows(900); // 2700 rows
    const { query, calls } = makeFakeBackend(rows, PK);
    const got = await collect(query, {
      table: "daily_bars",
      selectList: SELECT_LIST,
      selectColumns: COLS,
      pkColumns: PK,
      chunkRows: 1000,
    });
    expect(got).toHaveLength(2700);
    expect(new Set(got.map((r) => `${r.ticker}|${r.seq}`)).size).toBe(2700);
    // In key order across chunk boundaries.
    for (let i = 1; i < got.length; i++) {
      expect(
        compareTuples([got[i - 1].ticker, got[i - 1].seq], [got[i].ticker, got[i].seq]),
      ).toBeLessThan(0);
    }
    // 3 chunks: 1000, 1000, 700. Chunk 1 ends mid-MSFT (AAPL has 900 rows,
    // so row 1000 is MSFT/100); each later call carries the last row's key.
    expect(calls).toHaveLength(3);
    expect(calls[0].params).toEqual([]);
    expect(calls[1].params).toEqual(["MSFT", 100]);
    expect(calls[2].params).toEqual(["SPY", 200]);
    expect(calls[1].text).toContain('WHERE ("ticker", "seq") > ($1, $2)');
  });

  it("halves the chunk size when Neon rejects a 64 MB response, and recovers", async () => {
    const rows = makeRows(400); // 1200 rows
    const { query } = makeFakeBackend(rows, PK);
    const realQuery = query;
    const attemptedLimits: number[] = [];
    const capping = async (text: string, params: unknown[]) => {
      const limit = Number(text.match(/LIMIT (\d+)/)![1]);
      attemptedLimits.push(limit);
      if (limit > 400) {
        throw new Error("response is too large (max is 67108864 bytes), status code: 507");
      }
      return realQuery(text, params);
    };
    const got = await collect(capping, {
      table: "daily_bars",
      selectList: SELECT_LIST,
      selectColumns: COLS,
      pkColumns: PK,
      chunkRows: 1000,
      minChunkRows: 100,
    });
    expect(got).toHaveLength(1200);
    // Halved 1000 -> 500 -> 250, then stuck with <= 250 for the whole table.
    expect(attemptedLimits.slice(0, 3)).toEqual([1000, 500, 250]);
    expect(Math.max(...attemptedLimits.slice(3))).toBeLessThanOrEqual(250);
  });

  it("rethrows the 507 once the chunk floor still overflows", async () => {
    const alwaysTooLarge = async () => {
      throw new Error("response is too large (max is 67108864 bytes), status code: 507");
    };
    await expect(
      collect(alwaysTooLarge, {
        table: "daily_bars",
        selectList: SELECT_LIST,
        selectColumns: COLS,
        pkColumns: PK,
        chunkRows: 400,
        minChunkRows: 400,
      }),
    ).rejects.toThrow(/response is too large/);
  });

  it("falls back to OFFSET pagination ordered by all columns when there is no PK", async () => {
    const rows = makeRows(7).map(({ ticker, seq, close }) => ({ ticker, seq, close })); // 21 rows
    const { query, calls } = makeFakeBackend(rows, COLS);
    const got = await collect(query, {
      table: "some_log",
      selectList: SELECT_LIST,
      selectColumns: COLS,
      pkColumns: [],
      chunkRows: 10,
    });
    expect(got).toHaveLength(21);
    expect(calls.length).toBe(3);
    expect(calls[0].text).toContain("OFFSET 0");
    expect(calls[0].text).not.toContain("WHERE");
    expect(calls[1].text).toContain("OFFSET 10");
    expect(calls[0].text).toContain('ORDER BY "ticker", "seq", "close"');
  });

  it("falls back to OFFSET when the PK is not among the selected columns", async () => {
    const rows = makeRows(7);
    const { query, calls } = makeFakeBackend(rows, COLS);
    await collect(query, {
      table: "t",
      selectList: SELECT_LIST,
      selectColumns: COLS,
      pkColumns: ["ticker", "nonexistent_col"],
      chunkRows: 10,
    });
    expect(calls[0].text).toContain("OFFSET 0");
  });

  it("rejects a non-positive chunk size", async () => {
    await expect(
      collect(async () => [], {
        table: "t",
        selectList: SELECT_LIST,
        selectColumns: COLS,
        pkColumns: PK,
        chunkRows: 0,
      }),
    ).rejects.toThrow(/positive integer/);
  });
});

describe("isResponseTooLargeError", () => {
  it("matches the Neon driver's 507 message", () => {
    expect(
      isResponseTooLargeError(
        new Error("response is too large (max is 67108864 bytes), status code: 507"),
      ),
    ).toBe(true);
  });
  it("does not swallow unrelated errors", () => {
    expect(isResponseTooLargeError(new Error('relation "nope" does not exist'))).toBe(false);
    expect(isResponseTooLargeError(new Error("connection reset by peer"))).toBe(false);
  });
});

describe("defaults", () => {
  it("keeps the documented defaults", () => {
    expect(DEFAULT_CHUNK_ROWS).toBe(10_000);
    expect(MIN_CHUNK_ROWS).toBe(500);
  });
});
