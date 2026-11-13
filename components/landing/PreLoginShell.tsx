"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import CookiePreferencesLink from "@/components/CookiePreferencesLink";

const primary = [["Signals", "/signals"], ["Portfolio", "/portfolio-intelligence"], ["Nu AI", "/ai-assistant"], ["Pricing", "/pricing"]] as const;
const secondary = [["Product", "/#product"], ["Paper trading", "/paper-trading"], ["Track record", "/track-record"]] as const;
const destinations = [...primary, ...secondary, ["Sign in", "/sign-in"], ["Start free →", "/sign-up"]] as const;

/** Public navigation and footer only. No signed-in dashboard styles or access changes. */
export function PreLoginNav() {
  const pathname = usePathname();
  const item = ([label, href]: readonly [string, string]) => (
    <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} className={href === "/sign-up" ? "nav-action" : undefined}>{label}</Link>
  );
  return (
    <nav className="topbar" aria-label="Primary navigation">
      <Link className="brand" href="/" aria-label="NuWrrrld Financial home"><span className="brand-mark" aria-hidden="true">NWF</span><span>NuWrrrld Financial</span></Link>
      <div className="navlinks">
        {primary.map(item)}
        <details className="nav-secondary"><summary>Explore</summary><div className="nav-secondary-links">{secondary.map(item)}</div></details>
        {item(["Sign in", "/sign-in"])}{item(["Start free →", "/sign-up"])}
      </div>
      <details className="nav-menu"><summary aria-label="Open navigation menu">Menu</summary><div className="nav-menu-links">{destinations.map(item)}</div></details>
    </nav>
  );
}

export function PreLoginFooter() {
  return <footer><span>NWF · NuWrrrld Financial</span><span>Market research. Simulated strategies. Recorded outcomes.</span><span><Link href="/privacy-policy">Privacy</Link>{" · "}<Link href="/terms-of-service">Terms</Link>{" · "}<CookiePreferencesLink /></span></footer>;
}
