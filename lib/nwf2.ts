/**
 * Surfaces withheld from the user-facing app until NWF 2.0.
 *
 * A withheld surface keeps its code, routes, APIs and data. Its page shows
 * NWF2_MESSAGE instead, and the dashboard marks its nav link and card.
 * Promoting a surface is a one-line change here, reviewed in a PR.
 */

export const NWF2_MESSAGE = "See these features in NWF 2.0";

export type Nwf2Surface = "followed-tickers" | "paper-portfolios";

const WITHHELD: Record<Nwf2Surface, boolean> = {
  "followed-tickers": true,
  "paper-portfolios": true,
};

export function nwf2Withheld(surface: Nwf2Surface): boolean {
  return WITHHELD[surface];
}
