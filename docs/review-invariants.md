# Review invariants — short cards for the free-model reviewer

Each card is ≤5 bullets so a small model can hold it. A lens in
[`scripts/review/lenses.json`](../scripts/review/lenses.json) pulls **one** card
into its prompt. They mirror [`.coderabbit.yaml`](../.coderabbit.yaml).

## auth
- The Clerk session is the source of truth for who is calling.
- A user id, org id or role in the body or query is untrusted input.
- Check it against the session before using it in a query.

## secret
- `NEXT_PUBLIC_*` ships to the client bundle; secrets never go there.
- Backend and internal service URLs use server-only env vars.
- Secrets never appear in logs or responses.

## webhook-sig
- Verify the signature before trusting the body.
- Read the raw body for verification, then parse.

## shared-drift
- Mirrored files in `lib/shared/` are byte-identical with `gcp3-mobile/lib/`.
- Only the declared base-URL seam may differ.

## timeout / fallthrough
- Every model or vendor fetch gets an `AbortSignal` and counts toward `MODEL_CHAIN_WALK_BUDGET_MS`.
- Retry on 402, 429 and 5xx; stop on other 4xx.
