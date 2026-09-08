"use client";

/**
 * Client island for the nulogdash pipeline trigger buttons
 * (docs/admin-console-todo.md §5.8). Deliberately dumb: a dry-run button, a
 * two-step live-run confirm, pending state, and a result line. It holds no
 * secrets, does no auth, and fetches nothing — every decision is in the
 * Server Actions it calls.
 */
import { useState, useTransition } from "react";
import { triggerPipelineRun, confirmLivePipelineRun } from "@/lib/nulogdash-actions";
import type { TriggerResult } from "@/lib/nulogdash-trigger";

export function TriggerControls({ pipeline }: { pipeline: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<TriggerResult | null>(null);
  const [confirmToken, setConfirmToken] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  function runDry() {
    setResult(null);
    startTransition(async () => {
      const r = await triggerPipelineRun({ pipeline });
      setResult(r);
      setConfirmToken(r.ok && r.confirmToken ? r.confirmToken : null);
      setTyped("");
    });
  }

  function runLive() {
    if (!confirmToken) return;
    startTransition(async () => {
      const r = await confirmLivePipelineRun({ pipeline, confirmToken, typedName: typed });
      setResult(r);
      // Token is single-use server-side; clear the confirm UI regardless.
      setConfirmToken(null);
      setTyped("");
    });
  }

  return (
    <div className="nld-trigger-wrap">
      <div className="nld-trigger">
        <button
          type="button"
          className="nld-trigger-btn"
          onClick={runDry}
          disabled={pending}
        >
          {pending ? "Running…" : "Dry run"}
        </button>
      </div>

      {confirmToken && (
        <div className="nld-trigger-confirm">
          <span>
            Type <code>{pipeline}</code> to confirm a <strong>live</strong> run
            (spends model quota, writes a row):
          </span>
          <input
            aria-label={`Type ${pipeline} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="nld-trigger-btn nld-trigger-btn--live"
            onClick={runLive}
            disabled={pending || typed !== pipeline}
          >
            Run live
          </button>
        </div>
      )}

      {result && (
        <p className={`nld-trigger-msg nld-trigger-msg--${result.ok ? "ok" : "err"}`}>
          {result.ok
            ? `${result.dryRun ? "Dry run" : "Live run"} completed${
                result.status ? ` (HTTP ${result.status})` : ""
              }. Refresh the table below.`
            : result.error ?? "Trigger failed."}
        </p>
      )}
    </div>
  );
}
