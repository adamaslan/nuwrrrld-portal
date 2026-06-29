import type { DigestPayload } from "@/lib/digest";

export const globalDigestCache: { digest: DigestPayload | null; pushedAt: number } = {
  digest: null,
  pushedAt: 0,
};
