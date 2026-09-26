import type { Frame } from "../frame";

/** Mirrors signals-app config.SignalStrength values. */
export type SignalStrength =
  | "EXTREME BULLISH"
  | "STRONG BULLISH"
  | "BULLISH"
  | "NEUTRAL"
  | "BEARISH"
  | "STRONG BEARISH"
  | "EXTREME BEARISH"
  | "SIGNIFICANT"
  | "VERY SIGNIFICANT"
  | "TRENDING";

/** A signal on the frame's last bar; field names match signals-app MutableSignal. */
export interface EngineSignal {
  signal: string;
  description: string;
  strength: SignalStrength;
  category: string;
}

/** Any object with a detect() over a point-in-time frame is a detector. */
export interface Detector {
  readonly name: string;
  detect(frame: Frame): EngineSignal[];
}
