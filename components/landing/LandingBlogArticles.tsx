import Link from "next/link";
import { LANDING_BLOG_ARTICLES, BLOG_METHOD_BASIS } from "@/lib/blog/articles";

/** Two public research notes. No model calls, private context or performance claims. */
export function LandingBlogArticles() {
  return (
    <section id="research-notes" className="editorial-section" aria-labelledby="research-notes-title">
      <div className="wrap">
        <p className="kicker">From the research notes</p>
        <h2 id="research-notes-title">Read the method. Keep the limits in view.</h2>
        <div className="editorial-directory">
          {LANDING_BLOG_ARTICLES.map(article => (
            <article key={article.slug} className="editorial-entry">
              <p className="kicker">{article.feature} · {article.date}</p>
              <h3><Link href={`/blog/${article.slug}`}>{article.title}</Link></h3>
              <p className="section-copy">{article.description}</p>
              <p className="section-copy">{BLOG_METHOD_BASIS}</p>
              <Link className="feature-more" href={`/blog/${article.slug}`}>Read the research note →</Link>
            </article>
          ))}
        </div>
        <p><Link className="feature-more" href="/blog">Read all six articles →</Link></p>
      </div>
    </section>
  );
}
