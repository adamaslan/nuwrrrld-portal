import { buildPublicTrackRecord, type PublicTrackRecord } from "@/lib/public-track-record";

export type PublicTrackRecordRead =
  | { status: "ready"; record: PublicTrackRecord }
  | { status: "empty" | "unavailable"; record: null };

/** Read errors stay distinct from a successfully read, unscored dataset. */
export async function getPublicTrackRecord(): Promise<PublicTrackRecordRead> {
  try {
    const { getAllScores } = await import("@/lib/followed-tickers-db");
    const rows = await getAllScores({ throwOnError: true });
    const record = buildPublicTrackRecord(
      rows.map((r) => ({
        horizon: r.horizon,
        outcome: r.outcome,
        directional: r.directional,
        resolvedOn: r.resolvedOn,
      })),
    );
    return record ? { status: "ready", record } : { status: "empty", record: null };
  } catch {
    return { status: "unavailable", record: null };
  }
}
