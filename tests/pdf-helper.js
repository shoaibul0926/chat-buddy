// Builds a minimal, valid single-page PDF containing the given lines of text,
// using Helvetica text-showing operators. No external PDF-writing library is
// used since none is a project dependency; this is just enough of the PDF
// object model (catalog/pages/page/font/content stream + xref table) for
// pdf-parse to read back real, positioned text — the same shape of input the
// app's extractText() sees from a real-world PDF export.
function escapePdfText(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildTestPdf(lines) {
  const contentOps = ['BT', '/F1 12 Tf', '72 720 Td'];
  lines.forEach((line, i) => {
    if (i > 0) contentOps.push('0 -18 Td');
    contentOps.push(`(${escapePdfText(line)}) Tj`);
  });
  contentOps.push('ET');
  const content = contentOps.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

module.exports = { buildTestPdf };
