// US federal tax tables.
//
// ---------------------------------------------------------------------------
// UPDATING FOR A NEW YEAR — everything that goes stale lives in this file.
// The IRS publishes the following autumn for the next year (Rev. Proc.). Bump
// TAX_YEAR, then update BRACKETS, STANDARD_DEDUCTION, SS_WAGE_BASE, and the
// ADDITIONAL_MEDICARE thresholds. Nothing outside this file needs to change.
// The Settings screen displays TAX_YEAR so a stale table is visible to users.
// ---------------------------------------------------------------------------
//
// Current figures: tax year 2026, per IRS Revenue Procedure 2025-32 (released
// 2025-10-09), and SSA's 2026 contribution and benefit base.

export const TAX_YEAR = 2026;

export type FilingStatus = 'single' | 'mfj' | 'mfs' | 'hoh';

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  single: 'Single',
  mfj: 'Married filing jointly',
  mfs: 'Married filing separately',
  hoh: 'Head of household',
};

export const FILING_STATUSES: FilingStatus[] = ['single', 'mfj', 'mfs', 'hoh'];

// Each entry: this rate applies to taxable income up to `upTo`, above the
// previous entry's ceiling. Top bracket uses Infinity.
type Bracket = { upTo: number; rate: number };

const BRACKETS: Record<FilingStatus, Bracket[]> = {
  single: [
    { upTo: 12_400, rate: 0.10 },
    { upTo: 50_400, rate: 0.12 },
    { upTo: 105_700, rate: 0.22 },
    { upTo: 201_775, rate: 0.24 },
    { upTo: 256_225, rate: 0.32 },
    { upTo: 640_600, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],
  mfj: [
    { upTo: 24_800, rate: 0.10 },
    { upTo: 100_800, rate: 0.12 },
    { upTo: 211_400, rate: 0.22 },
    { upTo: 403_550, rate: 0.24 },
    { upTo: 512_450, rate: 0.32 },
    { upTo: 768_700, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],
  // Identical to single through the 32% bracket; the 35% band is where they
  // diverge (384,350 rather than 640,600).
  mfs: [
    { upTo: 12_400, rate: 0.10 },
    { upTo: 50_400, rate: 0.12 },
    { upTo: 105_700, rate: 0.22 },
    { upTo: 201_775, rate: 0.24 },
    { upTo: 256_225, rate: 0.32 },
    { upTo: 384_350, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],
  hoh: [
    { upTo: 17_700, rate: 0.10 },
    { upTo: 67_450, rate: 0.12 },
    { upTo: 105_700, rate: 0.22 },
    { upTo: 201_775, rate: 0.24 },
    { upTo: 256_200, rate: 0.32 },
    { upTo: 640_600, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],
};

export const STANDARD_DEDUCTION: Record<FilingStatus, number> = {
  single: 16_100,
  mfj: 32_200,
  mfs: 16_100,
  hoh: 24_150,
};

// ----- FICA -----

export const SS_RATE = 0.062;
export const SS_WAGE_BASE = 184_500;   // 2026 contribution and benefit base
export const MEDICARE_RATE = 0.0145;   // no wage cap
export const ADDITIONAL_MEDICARE_RATE = 0.009;

// Thresholds for the 0.9% surtax as actually owed. (Employers withhold it
// above $200k regardless of status, but this models liability, not withholding.)
export const ADDITIONAL_MEDICARE_THRESHOLD: Record<FilingStatus, number> = {
  single: 200_000,
  mfj: 250_000,
  mfs: 125_000,
  hoh: 200_000,
};

/**
 * Federal income tax on an already-computed taxable income (i.e. after the
 * standard deduction). Walks the brackets, taxing each slice at its own rate.
 */
export function federalIncomeTax(taxableIncome: number, status: FilingStatus): number {
  if (!Number.isFinite(taxableIncome) || taxableIncome <= 0) return 0;
  let tax = 0;
  let floor = 0;
  for (const band of BRACKETS[status]) {
    if (taxableIncome <= floor) break;
    tax += (Math.min(taxableIncome, band.upTo) - floor) * band.rate;
    floor = band.upTo;
  }
  return tax;
}

/**
 * Federal income tax on annual wages, applying the standard deduction. Assumes
 * the standard deduction and wage income only — no itemising, no credits, no
 * investment or self-employment income.
 */
export function federalTaxOnWages(annualTaxableWages: number, status: FilingStatus): number {
  return federalIncomeTax(annualTaxableWages - STANDARD_DEDUCTION[status], status);
}

/**
 * FICA owed on a slice of wages stacked on top of `priorWages` already earned
 * this year. Social Security stops at the wage base; Medicare never does; the
 * 0.9% surtax kicks in above the filing-status threshold.
 *
 * Note FICA is levied on gross wages — a traditional 401k deferral reduces
 * income tax but NOT Social Security or Medicare.
 */
export function ficaOnWageSlice(
  priorWages: number,
  sliceWages: number,
  status: FilingStatus,
): { socialSecurity: number; medicare: number } {
  const prior = Math.max(0, priorWages);
  const slice = Math.max(0, sliceWages);

  // Only the part of this slice that still sits below the SS cap is taxed.
  const ssRoom = Math.max(0, SS_WAGE_BASE - prior);
  const socialSecurity = Math.min(slice, ssRoom) * SS_RATE;

  let medicare = slice * MEDICARE_RATE;
  const surtaxFloor = ADDITIONAL_MEDICARE_THRESHOLD[status];
  const surtaxable = Math.max(0, prior + slice - Math.max(surtaxFloor, prior));
  medicare += surtaxable * ADDITIONAL_MEDICARE_RATE;

  return { socialSecurity, medicare };
}
