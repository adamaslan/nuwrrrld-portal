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

## Shared Alpaca rate budget

Before every Alpaca page request, the worker calls the existing
`lib/alpaca-budget.mjs` adapter. It reserves against the shared DynamoDB
`nwf_rate_budget` counter and fails closed when the AWS CLI or its credentials
are unavailable. The Cloud Run image and runtime identity still need access to
that adapter's AWS command. The current slot Terraform does not configure that
access, so the job is not deploy-ready until infrastructure provides it.

## Local invocation

```bash
npm run hydrate:slot2 -- --dry-run --limit=10
```

The process does not read `.env.local` and never prints connection strings or
vendor credentials. A dry run needs only the source read-only URL and Alpaca
credentials. A non-dry run also requires the explicit write-enable flag and
passes the Neon endpoint guard before it reads or writes data.
