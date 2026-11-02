/**
 * backup-pagination.mjs — chunked table reads for backup-to-sqlite.mjs.
 *
 * Why this exists: the Neon serverless HTTP driver buffers each query's
 * entire result and rejects responses over 64 MB ("response is too large
 * (max is 67108864 bytes)", HTTP 507). nightly daily_bars crossed that cap
 * in late Oct 2026 and the nightly backup died mid-dump. Reading each table
 * in chunks keeps every individual response comfortably under the cap, and
 * bounds peak memory for the backup process too.
 *
 * Strategy: keyset pagination over the table's PRIMARY KEY (every table in
 * lib/db/schema.sql has one; composite keys use Postgres row-value
 * comparison, `("a","b") > ($1,$2)`). A table without a PK falls back to
 * LIMIT/OFFSET ordered by every selected column — fine for the small
 * PK-less tables that could plausibly appear, and documented as
 * duplicate-prone if fully-identical rows exist.
 *
 * Chunk size adapts: if a chunk still trips the 64 MB cap (wide rows, e.g.
 * corpus_chunks bodies), it halves and retries down to a floor, then gives
 * up loudly. The reduced size sticks for the rest of that table.
 */

export const DEFAULT_CHUNK_ROWS = 10_000;
export const MIN_CHUNK_ROWS = 500;

/** Neon's 64 MB HTTP response cap, surfaced by the driver as a 507. */
export function isResponseTooLargeError(err) {
  const msg = err?.message ?? "";
  return /response is too large|status code:?\s*507/i.test(msg);
}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * Async generator yielding row arrays for one table, one chunk at a time.
 *
 * @param {(text: string, params: unknown[]) => Promise<unknown[]>} query
 *   Executes a parameterized SELECT and returns its rows (e.g. neon's
 *   `sql.query`). Kept injectable so tests can fake Postgres.
 * @param {object} opts
 * @param {string} opts.table          Table name (quoted here).
 * @param {string} opts.selectList     Comma-separated quoted column list.
 * @param {string[]} opts.selectColumns Plain column names, same order.
 * @param {string[]} [opts.pkColumns]  PRIMARY KEY columns in key order.
 * @param {number} [opts.chunkRows]    Starting rows per chunk.
 * @param {number} [opts.minChunkRows] Adaptive halving floor.
 */
export async function* fetchTableChunks(query, opts) {
  const {
    table,
    selectList,
    selectColumns,
    pkColumns = [],
    chunkRows = DEFAULT_CHUNK_ROWS,
    minChunkRows = MIN_CHUNK_ROWS,
  } = opts;
  if (!Number.isInteger(chunkRows) || chunkRows < 1) {
    throw new Error(`chunkRows must be a positive integer, got ${chunkRows}`);
  }

  // Keyset only works if the key columns are among the selected ones (we
  // read the next chunk's lower bound off the last row we fetched). Every
  // mirrored table today satisfies this; anything else takes the OFFSET
  // fallback below.
  const useKeyset =
    pkColumns.length > 0 && pkColumns.every((c) => selectColumns.includes(c));
  const orderBy = (useKeyset ? pkColumns : selectColumns).map(quoteIdent).join(", ");

  let size = chunkRows;
  let after = null; // last chunk's final-row PK values (keyset mode)
  let offset = 0; //   rows emitted so far (OFFSET fallback)

  for (;;) {
    let rows;
    for (;;) {
      const params = [];
      let where = "";
      if (useKeyset && after) {
        const lhs = pkColumns.map(quoteIdent).join(", ");
        const rhs = pkColumns.map((_, i) => `$${i + 1}`).join(", ");
        where = `WHERE (${lhs}) > (${rhs})`;
        params.push(...after);
      }
      const text =
        `SELECT ${selectList} FROM ${quoteIdent(table)} ` +
        `${where} ORDER BY ${orderBy} ` +
        (useKeyset ? `LIMIT ${size}` : `LIMIT ${size} OFFSET ${offset}`);
      try {
        rows = await query(text, params);
        break;
      } catch (err) {
        if (isResponseTooLargeError(err) && size > minChunkRows) {
          const next = Math.max(minChunkRows, Math.floor(size / 2));
          console.warn(
            `  ⚠ "${table}" chunk of ${size} rows hit Neon's 64 MB response cap — retrying at ${next}`,
          );
          size = next;
          continue; // retry the SAME chunk (same where/offset) smaller
        }
        throw err;
      }
    }

    if (rows.length === 0) return;
    yield rows;
    if (rows.length < size) return; // short read = last chunk

    if (useKeyset) {
      const last = rows[rows.length - 1];
      after = pkColumns.map((c) => last[c]);
    } else {
      offset += rows.length;
    }
  }
}
