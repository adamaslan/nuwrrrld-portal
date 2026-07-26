This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Secret-scanning pre-commit hook

This repo blocks commits that contain credentials (API keys, tokens, database
URLs, Cloud Run hostnames) — including in the `docs/wiki-*/` pages. The hook
lives in [`.githooks/pre-commit`](.githooks/pre-commit) and is wired
automatically on `npm install` (via the `prepare` script). To enable it
manually:

```bash
git config core.hooksPath .githooks
```

It prefers [`gitleaks`](https://github.com/gitleaks/gitleaks) if installed
(`brew install gitleaks`), honoring the allowlist in
[`.gitleaks.toml`](.gitleaks.toml); otherwise it runs a built-in pattern scan.
Documented wiki placeholders (`{gcp3-backend-url}`, etc.) are allowlisted. In a
true emergency, `git commit --no-verify` bypasses it (discouraged).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
