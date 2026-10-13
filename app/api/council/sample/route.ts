import { NextResponse } from "next/server";
import { getCouncilSample } from "@/app/dashboard/holdfold/council-sample";

export const maxDuration = 10;

export async function GET() {
  const sample = await getCouncilSample();
  return NextResponse.json(sample ?? { error: "Council sample unavailable" }, {
    status: sample ? 200 : 503,
    headers: { "Cache-Control": sample
      ? "public, s-maxage=300, stale-while-revalidate=600"
      : "no-store" },
  });
}
