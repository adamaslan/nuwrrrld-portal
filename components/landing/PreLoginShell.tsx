import Link from "next/link";
import CookiePreferencesLink from "@/components/CookiePreferencesLink";

/**
 * Shared pre-login chrome: one nav and one footer for every public page.
 * Styled by app/landing.css under the .nwf-landing scope, so pages wrap
 * themselves in <div className="nwf-landing"> and import that stylesheet.
 * One CTA model everywhere: primary "Start free" (free account, no card),
 * secondary "See pricing". The Pro trial is explained on /pricing only.
 */
export function PreLoginNav() {
  return (
    <nav className="topbar" aria-label="Primary navigation">
      <Link className="brand" href="/">
        <span className="brand-mark" aria-hidden="true">NWF</span>
        <span>NuWrrrld Financial</span>
      </Link>
      <div className="navlinks">
        <Link href="/#product">Product</Link>
        <Link href="/signals">Signals</Link>
        <Link href="/portfolio-intelligence">Portfolio</Link>
        <Link href="/ai-assistant">Nu AI</Link>
        <Link href="/#council">Council</Link>
        <Link href="/pricing">Pricing</Link>
        <Link className="nav-keep" href="/sign-in">Sign in</Link>
        <Link className="nav-action" href="/sign-up">Start free →</Link>
      </div>
    </nav>
  );
}

export function PreLoginFooter() {
  return (
    <footer>
      <span>NWF · NuWrrrld Financial</span>
      <span>Six AI analysts. One straight answer.</span>
      <span>
        <Link href="/privacy-policy">Privacy</Link>
        {" · "}
        <Link href="/terms-of-service">Terms</Link>
        {" · "}
        <CookiePreferencesLink />
      </span>
    </footer>
  );
}
