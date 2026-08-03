// Dumps the raw text content pdfjs extracts from your flight PDF so we can
// see what the parser is working with.
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';

const requireCJS = createRequire(import.meta.url);
const PDF = '/Users/somers/Library/Application Support/autocarl/flights/VXr7nR19jJ/1779312856-John-Somers-772-80-SWA-LAS-05-26-26-CTLA024572-PO039270.pdf';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = requireCJS.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

const buf = await fs.readFile(PDF);
const doc = await pdfjs.getDocument({
  data: new Uint8Array(buf),
  useSystemFonts: true,
  disableFontFace: true,
  isEvalSupported: false,
}).promise;

console.log(`pdf pages: ${doc.numPages}\n`);

let fullText = '';
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  const pageText = content.items.map((it) => 'str' in it ? it.str : '').join(' ');
  console.log(`=== PAGE ${i} ===`);
  console.log(pageText.slice(0, 3000));
  console.log();
  fullText += pageText + '\n';
}

// Now show: every 3-letter code we find, and where 'depart'/'arrive' anchor.
console.log('\n=== 3-letter codes (in order) ===');
const seen = new Set();
for (const m of fullText.matchAll(/\b([A-Z]{3})\b/g)) {
  if (seen.has(m.index)) continue;
  seen.add(m.index);
  const start = Math.max(0, m.index - 30);
  const end = Math.min(fullText.length, m.index + 30);
  console.log(`  @${m.index} [${m[1]}]  ...${fullText.slice(start, end).replace(/\s+/g, ' ').trim()}...`);
}

console.log('\n=== depart/arrive anchors ===');
for (const m of fullText.matchAll(/depart(?:ure|ing|s)?|arriv(?:al|ing|es|e)/gi)) {
  const start = Math.max(0, m.index - 20);
  const end = Math.min(fullText.length, m.index + 80);
  console.log(`  @${m.index} [${m[0]}]  ...${fullText.slice(start, end).replace(/\s+/g, ' ').trim()}...`);
}
