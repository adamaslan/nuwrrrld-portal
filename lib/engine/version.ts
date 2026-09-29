/**
 * Stamped on every row the engine writes, so output from two engine versions
 * can always be told apart (the same role SIGNALS_APP_CODE_VERSION plays in
 * signals-app). Bump on any change that can alter a level, a leg or a signal.
 */
export const ENGINE_CODE_VERSION = "nu-engine@0.2.0";

/** The signals-app release whose fib definition this engine mirrors. */
export const CANONICAL_SOURCE = "signals-app@1.3.0";
