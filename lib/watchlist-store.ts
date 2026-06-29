import type { WatchlistItem } from "@/lib/portfolio";

// In-memory store shared across watchlist routes.
// Replace with a database before launch.
export const store = new Map<string, WatchlistItem[]>();
