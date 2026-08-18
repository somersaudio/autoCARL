// Layout-aware text extraction from a loaded pdfjs document. Shared by the
// desktop main process and the web shim so PDFs read identically on both.
//
// Some PDFs atomize their text layer into per-glyph items; joining them
// naively loses word boundaries and column structure. This clusters items
// into visual lines by baseline, sorts left-to-right, and inserts spaces on
// real horizontal gaps — the same text a human reads top to bottom.

type PdfPageLike = {
  getTextContent(): Promise<{ items: unknown[] }>;
};
type PdfDocLike = {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
};

export async function extractLayoutFromPdfDoc(doc: PdfDocLike): Promise<string> {
  type Bit = { str: string; x: number; y: number; w: number };
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const bits: Bit[] = (content.items as Array<{ str?: string; transform?: number[]; width?: number }>)
      .filter((it) => it && typeof it.str === 'string' && it.str.length > 0 && Array.isArray(it.transform))
      .map((it) => ({ str: it.str as string, x: it.transform![4], y: it.transform![5], w: it.width || 0 }));
    // Cluster into visual lines: sort top-to-bottom, then left-to-right;
    // a bit joins the current line while its baseline is within 2pt.
    bits.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: Bit[][] = [];
    for (const bit of bits) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0].y - bit.y) <= 2) row.push(bit);
      else rows.push([bit]);
    }
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      let line = '';
      let prevEnd: number | null = null;
      for (const bit of row) {
        if (prevEnd !== null && bit.x - prevEnd > 1.5) line += ' ';
        line += bit.str;
        prevEnd = bit.x + bit.w;
      }
      const trimmed = line.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out.join('\n');
}
