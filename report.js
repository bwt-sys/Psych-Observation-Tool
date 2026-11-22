/*
 * Formatted exports: a PDF report (jsPDF) and an Excel workbook (ExcelJS).
 * Both libraries are vendored in ./vendor and loaded only when an export is requested.
 *
 * Input is a plain "model" built by app.js:
 *   { meta: {participant, observer, startedAt: Date, methodLabel, intervalSec, sessionMin, endT},
 *     behaviors, summary, intervals, events, describe(ev) -> string,
 *     charts: { pies: {url, w, h} | null, bars: {url, w, h} | null } }
 */
(function (root) {
  'use strict';

  const C = {
    text: '#1b1f24', muted: '#5d6673', accent: '#2a78d6', border: '#d9dde3',
    head: '#eef2f8', zebra: '#f7f8fa', dot: '#b5bbc5',
  };
  const ACTION = {
    event: 'Occurred', start: 'Started', stop: 'Stopped', note: 'Note', pause: 'Paused', resume: 'Resumed',
  };

  function fmt(sec, tenths) { return root.ObsLogic.fmtTime(sec, tenths); }
  const pct1 = (v) => (v == null ? '' : v.toFixed(1) + '%');

  function metaRows(m) {
    const d = m.meta.startedAt;
    return [
      ['Participant', m.meta.participant || '—'],
      ['Observer', m.meta.observer || '—'],
      ['Date', d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })],
      ['Start time', d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })],
      ['Recording method', m.meta.methodLabel],
      ['Interval length', `${m.meta.intervalSec} s`],
      ['Planned length', m.meta.sessionMin > 0 ? `${m.meta.sessionMin} min` : 'No limit'],
      ['Time observed', fmt(m.meta.endT, true)],
    ];
  }

  /* ═════════════════════════ PDF ═════════════════════════ */

  function buildPDF(m, jsPDF) {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const PW = 210, PH = 297, M = 16, W = PW - 2 * M, BOTTOM = PH - 18;
    let y = M;

    const font = (size, style = 'normal', color = C.text) => {
      doc.setFont('helvetica', style);
      doc.setFontSize(size);
      doc.setTextColor(color);
    };
    const fit = (text, maxW) => {
      text = String(text);
      if (doc.getTextWidth(text) <= maxW) return text;
      while (text.length > 1 && doc.getTextWidth(text + '…') > maxW) text = text.slice(0, -1);
      return text + '…';
    };
    const newPage = () => { doc.addPage(); y = M; };
    const ensure = (h) => { if (y + h > BOTTOM) newPage(); };
    const heading = (text, space = 14) => {
      ensure(space + 10);
      y += 6;
      font(12, 'bold');
      doc.text(text, M, y);
      y += 2;
      doc.setDrawColor(C.border);
      doc.setLineWidth(0.3);
      doc.line(M, y, M + W, y);
      y += 6;
    };

    // ── Title + session details
    font(20, 'bold');
    doc.text('Observation Report', M, y + 6);
    y += 12;
    doc.setFillColor(C.accent);
    doc.rect(M, y, 24, 1.2, 'F');
    y += 8;

    const meta = metaRows(m);
    const colW = W / 2;
    meta.forEach(([k, v], i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = M + col * colW, yy = y + row * 11;
      font(8, 'normal', C.muted);
      doc.text(k.toUpperCase(), x, yy);
      font(11, 'normal');
      doc.text(fit(v, colW - 6), x, yy + 5);
    });
    y += Math.ceil(meta.length / 2) * 11 + 2;

    // ── Summary table
    heading('Summary');
    const cols = [
      { h: 'Behaviour', w: 44 }, { h: 'Type', w: 20 },
      { h: 'Count', w: 14, r: 1 }, { h: 'Rate/min', w: 18, r: 1 },
      { h: 'Total time', w: 20, r: 1 }, { h: 'Mean bout', w: 20, r: 1 },
      { h: '% session', w: 20, r: 1 }, { h: '% intervals', w: 22, r: 1 },
    ];
    const rowH = 7;
    const drawRow = (cells, opts = {}) => {
      if (opts.fill) { doc.setFillColor(opts.fill); doc.rect(M, y, W, rowH, 'F'); }
      let x = M;
      cells.forEach((c, i) => {
        const col = cols[i];
        font(9, opts.bold ? 'bold' : 'normal', opts.color || (c.muted ? C.muted : C.text));
        const t = fit(c.t != null ? c.t : c, col.w - 4);
        if (col.r) doc.text(t, x + col.w - 2, y + 4.8, { align: 'right' });
        else doc.text(t, x + 2, y + 4.8);
        x += col.w;
      });
      y += rowH;
    };
    ensure(rowH * (m.summary.length + 1));
    drawRow(cols.map((c) => c.h), { fill: C.head, bold: true, color: C.muted });
    m.summary.forEach((s, i) => {
      ensure(rowH);
      drawRow([
        s.name,
        { t: s.type === 'event' ? 'Event' : 'Duration', muted: true },
        String(s.count),
        s.ratePerMin.toFixed(2),
        s.totalDuration == null ? { t: '—', muted: true } : fmt(s.totalDuration, true),
        s.meanDuration == null ? { t: '—', muted: true } : fmt(s.meanDuration, true),
        s.pctSession == null ? { t: '—', muted: true } : pct1(s.pctSession),
        s.pctIntervals == null ? { t: 'n/a', muted: true } : pct1(s.pctIntervals),
      ], { fill: i % 2 ? C.zebra : null });
    });
    doc.setDrawColor(C.border);
    doc.line(M, y, M + W, y);
    y += 4;
    font(8, 'normal', C.muted);
    doc.text('% intervals counts complete intervals only. "—" = not applicable to event behaviours.', M, y + 2);
    y += 4;

    // ── Charts
    const mmPerPx = 0.2646;
    const size = (img, maxW) => {
      let w = img.w * mmPerPx, h = img.h * mmPerPx;
      if (w > maxW) { h *= maxW / w; w = maxW; }
      return { w, h };
    };
    const place = (title, img, x, yy, s) => {
      font(10, 'bold');
      doc.text(fit(title, s.w + 30), x, yy + 4);
      doc.addImage(img.url, 'PNG', x, yy + 7, s.w, s.h, undefined, 'FAST');
    };
    const pies = m.charts.pies, bars = m.charts.bars;
    if (pies || bars) {
      heading('Charts');
      const TP = 'Time on vs off', TB = 'Event frequency';
      const sp = pies && size(pies, W), sb = bars && size(bars, W);
      if (pies && bars && sp.w + sb.w + 10 <= W) {
        // Side by side when both fit across the page.
        const h = Math.max(sp.h, sb.h);
        ensure(h + 12);
        place(TP, pies, M, y, sp);
        place(TB, bars, M + sp.w + 10, y, sb);
        y += h + 11;
      } else {
        for (const [t, img, s] of [[TP, pies, sp], [TB, bars, sb]]) {
          if (!img) continue;
          ensure(s.h + 12);
          place(t, img, M, y, s);
          y += s.h + 11;
        }
      }
    }

    // ── Notes
    const notes = m.events.filter((e) => e.kind === 'note');
    if (notes.length) {
      heading('Notes');
      for (const n of notes) {
        font(9, 'normal');
        const lines = doc.splitTextToSize(n.text, W - 20);
        ensure(lines.length * 4.5 + 2);
        font(9, 'normal', C.muted);
        doc.text(fmt(n.t, true), M, y + 3.5);
        font(9, 'normal');
        doc.text(lines, M + 20, y + 3.5);
        y += lines.length * 4.5 + 1.5;
      }
    }

    // ── Interval record
    if (m.intervals.length) {
      heading('Interval record', 45);
      font(8, 'normal', C.muted);
      doc.text(`${m.meta.methodLabel}. Filled dot = scored, small dot = not scored, n/a = method does not apply. * = incomplete final interval.`, M, y + 1);
      y += 5;
      const fixed = [{ h: '#', w: 12 }, { h: 'Start', w: 18 }, { h: 'End', w: 18 }];
      const rest = W - 48;
      const bw = Math.max(14, Math.min(30, rest / m.behaviors.length));
      const iCols = [...fixed, ...m.behaviors.map((b) => ({ h: b.name, w: bw, c: 1 }))];
      const ih = 5.5;
      const header = () => {
        doc.setFillColor(C.head);
        doc.rect(M, y, Math.min(W, iCols.reduce((a, c) => a + c.w, 0)), ih + 1, 'F');
        let x = M;
        for (const c of iCols) {
          font(7.5, 'bold', C.muted);
          const t = fit(c.h, c.w - 2);
          if (c.c) doc.text(t, x + c.w / 2, y + 4, { align: 'center' });
          else doc.text(t, x + 1.5, y + 4);
          x += c.w;
        }
        y += ih + 1;
      };
      header();
      m.intervals.forEach((iv, idx) => {
        if (y + ih > BOTTOM) { newPage(); header(); }
        if (idx % 2) { doc.setFillColor(C.zebra); doc.rect(M, y, Math.min(W, iCols.reduce((a, c) => a + c.w, 0)), ih, 'F'); }
        font(8, iv.complete ? 'normal' : 'italic', iv.complete ? C.text : C.muted);
        let x = M;
        doc.text(iv.index + (iv.complete ? '' : '*'), x + 1.5, y + 3.8); x += 12;
        doc.text(fmt(iv.start, true), x + 1.5, y + 3.8); x += 18;
        doc.text(fmt(iv.end, true), x + 1.5, y + 3.8); x += 18;
        for (const b of m.behaviors) {
          const v = iv.scores[b.id];
          const cx = x + bw / 2, cy = y + ih / 2;
          if (v == null) { font(7, 'normal', C.muted); doc.text('n/a', cx, y + 3.7, { align: 'center' }); }
          else if (v) { doc.setFillColor(C.accent); doc.circle(cx, cy, 1.3, 'F'); }
          else { doc.setFillColor(C.dot); doc.circle(cx, cy, 0.45, 'F'); }
          x += bw;
        }
        y += ih;
      });
    }

    // ── Footer on every page
    const n = doc.getNumberOfPages();
    const stamp = new Date().toLocaleString();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setDrawColor(C.border);
      doc.line(M, PH - 12, M + W, PH - 12);
      font(8, 'normal', C.muted);
      const who = m.meta.participant ? `Participant ${m.meta.participant} · ` : '';
      doc.text(`${who}Observation Timer · generated ${stamp}`, M, PH - 8);
      doc.text(`Page ${i} of ${n}`, M + W, PH - 8, { align: 'right' });
    }
    return doc.output('blob');
  }

  /* ═════════════════════════ Excel ═════════════════════════ */

  const argb = (hex) => 'FF' + hex.replace('#', '').toUpperCase();
  const DAY = 86400;
  const TIME_FMT = '[m]:ss.0';

  async function buildXLSX(m, ExcelJS) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Observation Timer';
    wb.created = new Date();

    const thin = { style: 'thin', color: { argb: argb(C.border) } };
    const styleHeader = (row) => {
      row.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: argb(C.text) } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(C.head) } };
        cell.border = { bottom: { style: 'medium', color: { argb: argb(C.accent) } } };
        cell.alignment = { vertical: 'middle', horizontal: cell.alignment && cell.alignment.horizontal || 'left' };
      });
      row.height = 20;
    };

    /* ── Report sheet */
    const ws = wb.addWorksheet('Report', { views: [{ showGridLines: false }] });
    ws.columns = [
      { width: 24 }, { width: 12 }, { width: 9 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 13 },
    ];
    ws.getCell('A1').value = 'Observation Report';
    ws.getCell('A1').font = { size: 18, bold: true, color: { argb: argb(C.text) } };
    ws.getRow(1).height = 28;

    let r = 3;
    for (const [k, v] of metaRows(m)) {
      ws.getCell(r, 1).value = k;
      ws.getCell(r, 1).font = { color: { argb: argb(C.muted) } };
      ws.getCell(r, 2).value = v;
      ws.getCell(r, 2).font = { bold: true };
      r++;
    }

    r += 1;
    ws.getCell(r, 1).value = 'Summary';
    ws.getCell(r, 1).font = { size: 13, bold: true };
    r++;
    const head = ['Behaviour', 'Type', 'Count', 'Rate/min', 'Total time', 'Mean bout', '% of session', '% of intervals'];
    const hr = ws.getRow(r);
    hr.values = head;
    head.forEach((_, i) => { if (i >= 2) hr.getCell(i + 1).alignment = { horizontal: 'right' }; });
    styleHeader(hr);
    r++;
    m.summary.forEach((s, i) => {
      const row = ws.getRow(r);
      row.values = [
        s.name, s.type === 'event' ? 'Event' : 'Duration', s.count, s.ratePerMin,
        s.totalDuration == null ? '—' : s.totalDuration / DAY,
        s.meanDuration == null ? '—' : s.meanDuration / DAY,
        s.pctSession == null ? '—' : s.pctSession / 100,
        s.pctIntervals == null ? 'n/a' : s.pctIntervals / 100,
      ];
      row.getCell(3).numFmt = '0';
      row.getCell(4).numFmt = '0.00';
      row.getCell(5).numFmt = TIME_FMT;
      row.getCell(6).numFmt = TIME_FMT;
      row.getCell(7).numFmt = '0.0%';
      row.getCell(8).numFmt = '0.0%';
      row.eachCell((cell, c) => {
        cell.border = { bottom: thin };
        if (c >= 3) cell.alignment = { horizontal: 'right' };
        if (typeof cell.value === 'string' && c >= 3) cell.font = { color: { argb: argb(C.muted) } };
        if (i % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(C.zebra) } };
      });
      row.getCell(2).font = { color: { argb: argb(C.muted) } };
      r++;
    });
    ws.getCell(r, 1).value = '% of intervals counts complete intervals only.';
    ws.getCell(r, 1).font = { italic: true, size: 9, color: { argb: argb(C.muted) } };
    r += 2;

    // Charts as pictures (Excel charts can't be generated reliably in the browser).
    const placeImage = (title, img) => {
      if (!img) return;
      ws.getCell(r, 1).value = title;
      ws.getCell(r, 1).font = { size: 13, bold: true };
      r++;
      const id = wb.addImage({ base64: img.url, extension: 'png' });
      ws.addImage(id, { tl: { col: 0, row: r - 1 }, ext: { width: img.w, height: img.h } });
      r += Math.ceil(img.h / 17) + 2; // rows are 15–20 px depending on the app; leave room
    };
    placeImage('Time on vs off', m.charts.pies);
    placeImage('Event frequency', m.charts.bars);

    /* ── Intervals sheet */
    const wi = wb.addWorksheet('Intervals', { views: [{ state: 'frozen', ySplit: 1 }] });
    wi.columns = [
      { header: 'Interval', width: 10 }, { header: 'Start', width: 10 }, { header: 'End', width: 10 },
      ...m.behaviors.map((b) => ({ header: b.name, width: Math.max(12, Math.min(28, b.name.length + 4)) })),
    ];
    styleHeader(wi.getRow(1));
    for (const iv of m.intervals) {
      const row = wi.addRow([
        iv.complete ? iv.index : iv.index + '*', iv.start / DAY, iv.end / DAY,
        ...m.behaviors.map((b) => (iv.scores[b.id] == null ? 'n/a' : iv.scores[b.id] ? '✓' : '')),
      ]);
      row.getCell(1).alignment = { horizontal: 'left' };
      row.getCell(2).numFmt = TIME_FMT;
      row.getCell(3).numFmt = TIME_FMT;
      m.behaviors.forEach((b, j) => {
        const cell = row.getCell(4 + j);
        cell.alignment = { horizontal: 'center' };
        const v = iv.scores[b.id];
        if (v) {
          cell.font = { bold: true, color: { argb: argb('#1f7a45') } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('#e3f6ea') } };
        } else if (v == null) {
          cell.font = { color: { argb: argb(C.muted) } };
        }
      });
      row.eachCell({ includeEmpty: true }, (cell) => { cell.border = { bottom: thin }; });
      if (!iv.complete) row.eachCell((cell) => { cell.font = { ...(cell.font || {}), italic: true, color: { argb: argb(C.muted) } }; });
    }
    const totalRow = wi.addRow(['Scored', null, null, ...m.summary.map((s) =>
      s.intervalsScored == null ? 'n/a' : `${s.intervalsScored}/${s.intervalsTotal} (${pct1(s.pctIntervals)})`)]);
    totalRow.eachCell((cell, c) => {
      cell.font = { bold: true };
      cell.border = { top: { style: 'medium', color: { argb: argb(C.text) } } };
      if (c >= 4) cell.alignment = { horizontal: 'center' };
    });
    if (m.intervals.some((iv) => !iv.complete)) {
      const note = wi.addRow(['* Incomplete final interval, left out of the percentages.']);
      note.getCell(1).font = { italic: true, size: 9, color: { argb: argb(C.muted) } };
    }

    /* ── Events sheet */
    const we = wb.addWorksheet('Events', { views: [{ state: 'frozen', ySplit: 1 }] });
    we.columns = [
      { header: 'Time', width: 10 }, { header: 'Interval', width: 9 }, { header: 'Behaviour', width: 24 },
      { header: 'Key', width: 6 }, { header: 'Type', width: 10 }, { header: 'Action', width: 12 }, { header: 'Note', width: 50 },
    ];
    styleHeader(we.getRow(1));
    const byId = Object.fromEntries(m.behaviors.map((b) => [b.id, b]));
    for (const ev of m.events) {
      const b = ev.behaviorId ? byId[ev.behaviorId] : null;
      const row = we.addRow([
        ev.t / DAY, Math.floor(ev.t / m.meta.intervalSec) + 1,
        b ? b.name : '', b ? b.key.toUpperCase() : '', b ? (b.type === 'event' ? 'Event' : 'Duration') : '',
        ACTION[ev.kind] || ev.kind, ev.text || '',
      ]);
      row.getCell(1).numFmt = TIME_FMT;
      row.getCell(2).alignment = { horizontal: 'left' };
      row.getCell(7).alignment = { wrapText: true, vertical: 'top' };
      if (ev.kind === 'pause' || ev.kind === 'resume') row.eachCell((c) => { c.font = { color: { argb: argb(C.muted) } }; });
      row.eachCell({ includeEmpty: true }, (cell) => { cell.border = { bottom: thin }; });
    }
    const end = we.addRow([m.meta.endT / DAY, null, '', '', '', 'Session ended', '']);
    end.getCell(1).numFmt = TIME_FMT;
    end.eachCell((c) => { c.font = { bold: true }; });
    we.autoFilter = { from: 'A1', to: 'G1' };

    // Print nicely: fit columns to one page wide, repeat header rows.
    wb.eachSheet((sheet) => {
      sheet.pageSetup = { ...sheet.pageSetup, paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    });
    wi.pageSetup.printTitlesRow = '1:1';
    we.pageSetup.printTitlesRow = '1:1';

    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  root.ObsReport = { buildPDF, buildXLSX };
})(window);
