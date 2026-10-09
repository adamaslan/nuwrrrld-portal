import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { isNulogdashAdmin, canPerformAdminAction } from "@/lib/nulogdash";
import { listBetaGrants } from "@/lib/beta-grant-list";
import { NulogdashTabs, MfaNotice } from "../page";
import { GrantForm, RevokeButton } from "./_components/BetaControls";
import "../nulogdash.css";

export const metadata: Metadata = {
  title: "nulogdash · beta testers",
};

// A grant should show up the moment it is made.
export const dynamic = "force-dynamic";

export default async function BetaTestersPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/nulogdash/beta");

  const user = await currentUser();
  if (!isNulogdashAdmin(user)) notFound();

  const canMutate = canPerformAdminAction(user);
  const { grants, truncated } = await listBetaGrants();

  return (
    <main className="nld-page">
      <Link href="/dashboard" className="nld-back">← Dashboard</Link>
      <h1>nulogdash</h1>
      <NulogdashTabs active="beta" />
      {!canMutate && <MfaNotice />}

      <section>
        <h2>Grant beta Pro</h2>
        <p className="nld-meta">
          The person must already have an account with a verified email. A grant runs until the
          start of its expiry date (UTC), or indefinitely if left blank. This only applies to the
          Clerk instance this site is running against.
        </p>
        <GrantForm canMutate={canMutate} />
      </section>

      <section>
        <h2>Beta testers ({grants.filter((g) => g.active).length} active)</h2>
        {grants.length === 0 ? (
          <p className="nld-empty">No grants yet.</p>
        ) : (
          <div className="nld-table-wrap">
            <table className="nld-table">
              <thead>
                <tr><th>Email</th><th>Status</th><th>Granted</th><th>Expires</th><th>Note</th><th /></tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.userId} className={g.active ? undefined : "nld-row--not_run"}>
                    <td>{g.email}</td>
                    <td>
                      <span className={`nld-badge nld-badge--${g.active ? "pass" : "not_run"}`}>
                        {g.active ? "Active" : "Expired"}
                      </span>
                    </td>
                    <td>{g.grantedAt ?? "—"}</td>
                    <td>{g.expiresAt ?? "never"}</td>
                    <td>{g.note ?? "—"}</td>
                    <td><RevokeButton userId={g.userId} canMutate={canMutate} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {truncated && (
          <p className="nld-meta">Scanned the 500 most recent users only; older grants may not be listed.</p>
        )}
        <p className="nld-meta">
          The owner account in <code>lib/beta-testers.ts</code> is always Pro and isn&apos;t managed here.
        </p>
      </section>
    </main>
  );
}
