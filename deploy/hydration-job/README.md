# Slot 2 hydration job

This worker reads the active ticker universe from a read-only Neon connection,
fetches Alpaca SIP daily bars, uses the portal's shared indicator and card
policies, and upserts cards into the `nwf-hydration` branch. It never selects a
production write connection.

## Runtime configuration

- `SOURCE_DATABASE_URL`: read-only connection to the current production branch.
- `HYDRATION_DATABASE_URL`: writer connection for the hydration branch. Optional
  in `--dry-run` mode.
- `HYDRATION_NEON_BRANCH_NAME`: must be `nwf-hydration` when a target URL is
  supplied.
- `HYDRATION_NEON_ENDPOINT_ID`: endpoint ID expected in the target connection
  URI's hostname. The worker rejects a different endpoint and rejects a target
  endpoint equal to the source endpoint.
- `ALPACA_API_KEY` and `ALPACA_API_SECRET`: Alpaca credentials.
- `ENABLE_HYDRATION_WRITES=true`: required for database writes. Without it,
  only `--dry-run` is accepted.

The source credential must be read-only. The target credential must be scoped to
the hydration branch; the endpoint check is an additional guard, not a
replacement for least-privilege Neon roles.

## Alpaca request pacing

There is no shared Alpaca rate budget and the worker needs no AWS access. It
counts its own Alpaca requests and records the total as `alpacaRequests` in the
run summary. An Alpaca 429 fails the run instead of waiting for a minute bucket.
If Alpaca rejects a batch with `invalid symbol: X`, the worker drops that one
symbol (it is then reported as unservable) and retries the rest.

A daily bar is stored as final only once the SIP delay has passed after the
16:00 New York close, so a run just after the bell does not store a partial bar
as final.

## Local invocation

```bash
npm run hydrate:slot2 -- --dry-run --limit=10
```

The process does not read `.env.local` and never prints connection strings or
vendor credentials. A dry run needs only the source read-only URL and Alpaca
credentials. A non-dry run also requires the explicit write-enable flag and
passes the Neon endpoint guard before it reads or writes data.
