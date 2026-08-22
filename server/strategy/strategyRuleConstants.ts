/**
 * Live strategy constants deliberately kept separate from user-tunable
 * parameters. Signal generation, order sizing and the next-action view use
 * this one source so the displayed rule cannot diverge from execution.
 */
export const FIXED_DCA_DROP_PERCENTS = [2.0, 4.2, 5.5] as const;
export const FIXED_DCA_UNIT_SCALES = [1.5, 2.0, 1.5] as const;
export const DCA2_RECOVERY_PREBUY_FRACTION = 0.4;

export const PARTIAL_CUT_RULES = {
  first: { lossPercent: 1.5, sellFraction: 0.30 },
  second: { lossPercent: 3.2, sellFraction: 0.50 }
} as const;
