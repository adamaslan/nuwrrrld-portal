import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { isNulogdashAdmin, canPerformAdminAction } from "@/lib/nulogdash";
import { listBetaGrants } from "@/lib/beta-grant-actions";
import { hasActiveBetaGrant } from "@/lib/beta-grant";
import { NulogdashTabs, MfaNotice } from "../page";
import { GrantForm, RevokeButton } from "./BetaControls";
import "../nulogdash.css";

export const metadata: Metadata = { title: "nulogdash · beta testers" };
export const dynamic = "force-dynamic";

export default async function BetaTestersPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/nulogdash/beta");

  const user = await currentUser();
  if (!isNulogdashAdmin(user)) notFound();
  const canMutate = canPerformAdminAction(user);

  // Listing reads other users' metadata, so it needs the MFA gate too.
  const rows = canMutate ? await listBetaGrants() : [];

  return (
    <main className="nld-page">
      <Link href="/dashboard/nulogdash" className="nld-back">← nulogdash</Link>
      <h1>Beta testers</h1>
      <NulogdashTabs active="beta" />
      {!canMutate ? (
        <MfaNotice />
      ) : (
        <>
          <section>
            <h2>Grant Pro</h2>
            <GrantForm />
          </section>
          <section>
            <h2>Grants ({rows.length})</h2>
            <table className="nld-table">
              <thead>
                <tr><th>User</th><th>Granted</th><th>Expires</th><th>Note</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const active = hasActiveBetaGrant({ beta: { tier: "pro", expiresAt: r.expiresAt } });
                  return (
                    <tr key={r.userId} className="nld-row" style={active ? undefined : { opacity: 0.5 }}>
                      <td>{r.email || r.userId}</td>
                      <td>{r.grantedAt ?? "—"}</td>
                      <td>{r.expiresAt ?? "none"}{active ? "" : " (expired)"}</td>
                      <td>{r.note ?? "—"}</td>
                      <td><RevokeButton userId={r.userId} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
