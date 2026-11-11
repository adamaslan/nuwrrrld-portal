import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BLOG_ARTICLES, getBlogArticle, type BlogBlock, BLOG_RETURN_BASIS } from "@/lib/blog/articles";
import "../blog.css";

interface Props {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return BLOG_ARTICLES.map((a) => ({ slug: a.slug }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = getBlogArticle(slug);
  if (!article) return { title: "Blog" };
  return {
    title: article.title,
    description: article.description,
    alternates: { canonical: `/blog/${article.slug}` },
    openGraph: {
      title: `${article.title} · NuWrrrld Financial`,
      description: article.description,
      type: "article",
    },
  };
}

function Block({ block }: { block: BlogBlock }) {
  switch (block.kind) {
    case "h2":
      return <h2>{block.text}</h2>;
    case "p":
      return <p>{block.text}</p>;
    case "list":
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case "stats":
      return (
        <div className="blog-stats-wrap"><p className="blog-basis">{BLOG_RETURN_BASIS}</p><div className="blog-stats">
          {block.items.map((s) => (
            <div className="blog-stat" key={s.label}>
              <b>{s.value}</b>
              <span>{s.label}</span>
            </div>
          ))}
        </div></div>
      );
    case "table":
      return (
        <div className="blog-table-wrap">
          <p className="blog-basis">{BLOG_RETURN_BASIS}</p>
          <table className="blog-table">
            {block.caption ? <caption>{block.caption}</caption> : null}
            <thead>
              <tr>
                {block.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export default async function BlogArticlePage({ params }: Props) {
  const { slug } = await params;
  const article = getBlogArticle(slug);
  if (!article) notFound();

  return (
    <main className="nwf-blog">
      <nav className="blog-nav" aria-label="Blog navigation">
        <Link href="/" className="blog-brand">
          NuWrrrld Financial
        </Link>
        <div className="blog-navlinks">
          <Link href="/blog">Blog</Link>
          <Link href="/signals">Signals</Link>
          <Link href="/pricing">Start free trial</Link>
        </div>
      </nav>

      <article className="blog-article">
        <header>
          <p className="blog-kicker">
            {article.feature} · {article.date}
          </p>
          <h1>{article.title}</h1>
          <p className="blog-sub">{article.description}</p>
          <p className="blog-basis">{BLOG_RETURN_BASIS}</p>
        </header>

        <aside className="blog-source-note">
          <p>Source: <a href="/blog/backtest-evidence.json">download the saved aggregates and run basis</a>. Headline totals are checked against these per-ticker records. This validates saved arithmetic, not an independent rerun of market data, the original code lineage, or a reconstruction of drawdowns from individual trades. The recorded lab engine is not established as identical to deployed scoring.</p>
        </aside>
        {article.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}

        <p className="blog-back">
          <Link href="/blog">← All articles</Link>
        </p>
      </article>

      <footer className="blog-footer">
        <p>
          Backtests use historical data and do not predict future results.
          NuWrrrld Financial is an educational tool, not investment advice.
        </p>
      </footer>
    </main>
  );
}
