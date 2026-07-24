/**
 * prefs — small persistence seam so shared logic (e.g. signals filter state)
 * doesn't need to know whether it's running on web (localStorage) or mobile
 * (expo-secure-store). Mirrored in gcp3-mobile/lib/shared/prefs.ts with the
 * same get/set signature (async there, sync-wrapped-as-async here).
 */
export async function getPref(key: string): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function setPref(key: string, value: string): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* best-effort — a failed write shouldn't break the calling feature */
  }
}
