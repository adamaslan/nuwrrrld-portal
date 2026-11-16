import type { Metadata } from "next";
import Link from "next/link";
import { BLOG_ARTICLES, BLOG_RETURN_BASIS, BLOG_METHOD_BASIS } from "@/lib/blog/articles";
import "./blog.css";

export const metadata: Metadata = {
  title: "Blog — Backtests, signals, and how the engine works",
  description:
    "Backtests and practical research notes from NuWrrrld Financial: source data, signal interpretation, and what the numbers do and do not say.",
  alternates: { canonical: "/blog" },
  openGraph: {
    title: "NuWrrrld Financial Blog",
    description: "Backtests and methodology, in numbers.",
  },
};

export default function BlogIndexPage() {
  return (
    <main className="nwf-blog">
      <nav className="blog-nav" aria-label="Blog navigation">
        <Link href="/" className="blog-brand">
          NuWrrrld Financial
        </Link>
        <div className="blog-navlinks">
          <Link href="/blog" aria-current="page">
            Blog
          </Link>
          <Link href="/signals">Signals</Link>
          <Link href="/pricing">Start free trial</Link>
        </div>
      </nav>

      <header className="blog-header">
        <p className="blog-kicker">The NWF blog</p>
        <h1>Measured, not marketed</h1>
        <p className="blog-sub">
          Backtests of our own engines and practical notes on data, signals and
          research. The method, the losses and the limits stay attached. Not investment advice.
        </p>
      </header>

      <ol className="blog-index">
        {BLOG_ARTICLES.map((a) => (
          <li key={a.slug}>
            <Link href={`/blog/${a.slug}`} className="blog-card">
              <span className="blog-card-meta">
                {a.feature} · {a.date}
              </span>
              <span className="blog-card-title">{a.title}</span>
              <span className="blog-basis">{a.kind === "method" ? BLOG_METHOD_BASIS : BLOG_RETURN_BASIS}</span>
              <span className="blog-card-desc">{a.description}</span>
            </Link>
          </li>
        ))}
      </ol>

      <footer className="blog-footer">
        <p>
          Backtests use historical data and do not predict future results.
          NuWrrrld Financial is an educational tool, not investment advice.
        </p>
      </footer>
    </main>
  );
}
