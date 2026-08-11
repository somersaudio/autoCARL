// Geometry of the CT Expense Reimbursement Form template
// (resources/expense-template.pdf, exported once from the official Numbers
// sheet). Measured programmatically — pdfjs text positions + raster grid-line
// detection — and shared by BOTH consumers so they can never drift apart:
//   - main/expense-pdf.ts draws exported values at these coordinates
//   - renderer ExpensesTab overlays edit fields at the same coordinates on a
//     raster of the same template
// Coordinates are PDF points, origin bottom-left, page 1134 × 792.

export type Col = { l: number; r: number };

export const PAGE = { width: 1134, height: 792 };

// Vertical grid lines of the expense table.
export const COL: Record<string, Col> = {
  job:       { l: 80.0,  r: 224.8 },
  desc:      { l: 224.8, r: 331.8 },
  lodging:   { l: 331.8, r: 410.8 },
  airfare:   { l: 410.8, r: 491.8 },
  parking:   { l: 491.8, r: 596.8 },
  carRental: { l: 596.8, r: 677.8 },
  miles:     { l: 677.8, r: 758.8 },
  mileage:   { l: 758.8, r: 839.8 },   // computed: miles × rate
  rideshare: { l: 839.8, r: 924.8 },   // "Uber/Lyft/Taxi"
  misc:      { l: 924.8, r: 990.8 },
  total:     { l: 990.8, r: 1059.8 },
};

// Text baselines of the ten data rows, top to bottom (measured off the
// template's seeded "$ -" placeholders in the Mileage column).
export const ROW_Y = [439.6, 424.5, 407.5, 390.4, 373.3, 356.2, 339.1, 322.0, 304.9, 287.8];
export const ROWS_PER_PAGE = ROW_Y.length;

export const TOTALS_Y = 270.7;   // pink per-column totals row
export const GRAND_Y = 253.6;    // pink grand-total cell under the Misc column
export const FINAL_Y = 219.4;    // pink reimbursement-total cell beside NOTES

// The template's own accounting format: "$" sits 5.8pt in from the cell's
// left line, the amount right-aligns 13.7pt in from the right line.
export const PAD_DOLLAR = 5.8;
export const PAD_RIGHT = 13.7;

// Header-field baselines (left-aligned into the gray/blue boxes).
export const HDR = {
  date:       { x: 229.0, y: 614.4 },
  name:       { x: 229.0, y: 563.1 },
  employeeId: { x: 229.0, y: 546.6 },
  pm:         { x: 600.5, y: 563.1 },
  lc:         { x: 600.5, y: 530.8 },
  state:      { x: 229.0, y: 512.5 },
  country:    { x: 229.0, y: 495.4 },
};

export const COMMENTS_BOX = { x: 229.0, y: 236.3, maxWidth: 178, lineHeight: 11, maxLines: 5 };
export const NOTES_BOX =    { x: 496.5, y: 236.3, maxWidth: 424, lineHeight: 11, maxLines: 5 };

// Cell fills sampled from the template raster — the flat pdf carries seeded
// "$ -" glyphs, so any cell that takes a value gets repainted in its own
// fill color first (export) or covered by a solid-background span (editor).
export const FILL_PEACH: [number, number, number] = [248, 203, 173];
export const FILL_PINK: [number, number, number] = [255, 153, 255];
