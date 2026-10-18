'use strict';

// Builds the styled Monthly Report workbook (ExcelJS). Pure function of the
// report data + display options, so it is unit-tested without Electron.

const ExcelJS = require('exceljs');
const { MONEY_SCALE } = require('./validate');

const C = {
  ink: 'FF0F172A',
  muted: 'FF64748B',
  headerFill: 'FF1F3A5F',
  headerInk: 'FFFFFFFF',
  border: 'FFD5DCE6',
  zebra: 'FFF6F8FB',
  totalFill: 'FFE6EDF7',
  sectionFill: 'FFEAF1FB',
  dayFill: 'FFEFF4FA',
  saturday: 'FF1D4ED8',
  sunday: 'FFC62828',
  tab: 'FF2A78D6',
};

const SYMBOL = { CNY: '¥', USD: '$', KRW: '₩' };

const ROW = { title: 30, subtitle: 18, header: 26, body: 20, band: 22, total: 22, section: 22 };

function numberFormats(currency, decimals) {
  const sym = SYMBOL[currency] ?? '';
  const n = decimals > 0 ? `#,##0.${'0'.repeat(decimals)}` : '#,##0';
  const zero = decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
  return {
    money: `"${sym}"${n};[Red]-"${sym}"${n};"${sym}"${zero}`,
    moneyDash: `"${sym}"${n};[Red]-"${sym}"${n};"-"`,
    signed: `[Color10]+"${sym}"${n};[Red]-"${sym}"${n};"${sym}"${zero}`,
    int: '#,##0',
    intDash: '#,##0;-#,##0;"-"',
    percent: '0.0%',
    change: '+0.0%;-0.0%;0.0%',
    date: 'yyyy-mm-dd',
  };
}

/** Display width of a string in Excel character units (CJK counts double). */
function textWidth(text) {
  let w = 0;
  for (const ch of String(text ?? '')) w += /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-￯]/.test(ch) ? 2 : 1;
  return w;
}

const excelDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const major = (minor) => (minor === null || minor === undefined ? null : minor / MONEY_SCALE);
const colLetter = (n) => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

class SheetBuilder {
  constructor(wb, name, ctx, { landscape = false } = {}) {
    this.ctx = ctx;
    this.ws = wb.addWorksheet(name, {
      properties: { tabColor: { argb: C.tab }, defaultRowHeight: ROW.body },
      views: [{ showGridLines: false }],
      pageSetup: {
        paperSize: 9,
        orientation: landscape ? 'landscape' : 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
      },
    });
    this.ws.headerFooter.oddFooter = `&L&8${ctx.appName}&R&8&P / &N`;
    this.widths = [];
  }

  font(extra = {}) {
    return { name: this.ctx.fontName, size: 10, color: { argb: C.ink }, ...extra };
  }

  track(col, text) {
    this.widths[col] = Math.max(this.widths[col] || 0, textWidth(text));
  }

  measure(type, value) {
    if (value === null || value === undefined || value === '') return '';
    const { fmtNumber, symbol } = this.ctx;
    switch (type) {
      case 'money':
      case 'moneyDash':
      case 'signed':
        return `+${symbol}${fmtNumber(value)}`;
      case 'int':
      case 'intDash':
        return String(Math.round(value).toLocaleString('en-US'));
      case 'percent':
      case 'change':
        return `+${(value * 100).toFixed(1)}%`;
      case 'date':
        return '2026-10-31';
      default:
        return String(value);
    }
  }

  /** Big title + subtitle spanning the table width. */
  title(text, subtitle, lastCol) {
    const ws = this.ws;
    ws.mergeCells(1, 1, 1, lastCol);
    Object.assign(ws.getCell(1, 1), { value: text, font: this.font({ size: 16, bold: true }), alignment: { vertical: 'middle' } });
    ws.getRow(1).height = ROW.title;
    ws.mergeCells(2, 1, 2, lastCol);
    Object.assign(ws.getCell(2, 1), { value: subtitle, font: this.font({ size: 9, italic: true, color: { argb: C.muted } }), alignment: { vertical: 'middle' } });
    ws.getRow(2).height = ROW.subtitle;
  }

  section(row, text, lastCol) {
    const ws = this.ws;
    for (let c = 1; c <= lastCol; c++) {
      const cell = ws.getCell(row, c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.sectionFill } };
      cell.border = { bottom: { style: 'medium', color: { argb: C.tab } } };
    }
    Object.assign(ws.getCell(row, 1), { value: text, font: this.font({ size: 11, bold: true }), alignment: { vertical: 'middle' } });
    ws.getRow(row).height = ROW.section;
  }

  style(cell, type, { bold = false, fill = null, indent = 0, color = null, align = null } = {}) {
    const fmt = this.ctx.formats[type];
    if (fmt) cell.numFmt = fmt;
    const numeric = ['money', 'moneyDash', 'signed', 'int', 'intDash', 'percent', 'change'].includes(type);
    cell.alignment = { vertical: 'middle', horizontal: align || (numeric ? 'right' : type === 'date' ? 'center' : 'left'), indent };
    cell.font = this.font({ bold, ...(color ? { color: { argb: color } } : {}) });
    const side = { style: 'thin', color: { argb: C.border } };
    cell.border = { top: side, bottom: side, left: side, right: side };
    if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  }

  /**
   * Writes a table. columns: [{ header, type }]; rows: [{ values: [...], bold, fill, indent: {col: n}, colors: {col: argb} }].
   * Returns the first/last data row numbers.
   */
  table(startRow, columns, rows, { zebra = true, total = null } = {}) {
    const ws = this.ws;
    const header = ws.getRow(startRow);
    header.height = ROW.header;
    columns.forEach((col, i) => {
      const cell = header.getCell(i + 1);
      cell.value = col.header;
      cell.font = this.font({ bold: true, color: { argb: C.headerInk } });
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerFill } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      const side = { style: 'thin', color: { argb: C.headerFill } };
      cell.border = { top: side, bottom: side, left: side, right: side };
      this.track(i + 1, col.header);
    });
    let r = startRow;
    rows.forEach((row, index) => {
      r += 1;
      const excelRow = ws.getRow(r);
      excelRow.height = row.height || ROW.body;
      const fill = row.fill || (zebra && index % 2 === 1 ? C.zebra : null);
      columns.forEach((col, i) => {
        const cell = excelRow.getCell(i + 1);
        const value = row.values[i];
        cell.value = value === undefined ? null : value;
        this.style(cell, col.type, {
          bold: row.bold,
          fill,
          indent: (row.indent && row.indent[i]) || 0,
          color: row.colors && row.colors[i],
        });
        this.track(i + 1, `${'  '.repeat((row.indent && row.indent[i]) || 0)}${this.measure(col.type, value instanceof Date ? 'date' : value)}`);
      });
    });
    const first = startRow + 1;
    const last = r;
    if (total) {
      r += 1;
      const excelRow = ws.getRow(r);
      excelRow.height = ROW.total;
      columns.forEach((col, i) => {
        const cell = excelRow.getCell(i + 1);
        cell.value = total(i, colLetter(i + 1), first, last) ?? null;
        this.style(cell, i === 0 ? 'text' : col.type, { bold: true, fill: C.totalFill });
        cell.border = { ...cell.border, top: { style: 'medium', color: { argb: C.headerFill } } };
        const v = cell.value && typeof cell.value === 'object' && 'result' in cell.value ? cell.value.result : cell.value;
        this.track(i + 1, this.measure(i === 0 ? 'text' : col.type, v));
      });
    }
    return { first, last, end: r };
  }

  finish({ min = 10, max = 48, fixed = {}, freezeRow = null, filter = null } = {}) {
    const ws = this.ws;
    this.widths.forEach((w, col) => {
      if (!col) return;
      ws.getColumn(col).width = fixed[col] ?? Math.min(max, Math.max(min, Math.ceil(w * 1.1) + 3));
    });
    if (freezeRow) {
      ws.views = [{ state: 'frozen', ySplit: freezeRow, topLeftCell: `A${freezeRow + 1}`, showGridLines: false }];
      ws.pageSetup.printTitlesRow = `${freezeRow}:${freezeRow}`;
    }
    if (filter) ws.autoFilter = filter;
  }
}

/**
 * opts: { t(key, params), lang, locale, currency, decimals, generatedAt: Date, appName }
 */
function buildReportWorkbook(report, opts) {
  const { t, locale, currency, decimals } = opts;
  const appName = opts.appName || 'Fund Manager';
  const numberFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const moneyText = (minor) => new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(minor / MONEY_SCALE);
  const monthLabel = (m) => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1));
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const weekday = (iso) => weekdayFmt.format(excelDate(iso));
  const dayIndex = (iso) => excelDate(iso).getUTCDay();
  const ctx = {
    appName,
    fontName: opts.lang === 'ko' ? 'Malgun Gothic' : 'Calibri',
    formats: numberFormats(currency, decimals),
    fmtNumber: (v) => numberFmt.format(v),
    symbol: SYMBOL[currency] ?? '',
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = appName;
  wb.created = opts.generatedAt || new Date();
  wb.title = `${t('report.title')} ${report.month}`;

  const s = report.summary;
  const stamp = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(opts.generatedAt || new Date());
  const subtitle = [
    `${t('report.excel.generated')}: ${stamp}`,
    `${t('report.excel.status')}: ${report.status.confirmed ? t('purchases.statusConfirmed') : t('purchases.statusOpen')}`,
    `${t('settings.general.currency')}: ${currency}`,
  ].join('   ·   ');
  const title = `${t('report.title')} · ${monthLabel(report.month)}`;
  const noSummary = t('purchases.noSummary');

  // ---- Summary ---------------------------------------------------------------
  {
    const sb = new SheetBuilder(wb, t('report.excel.sheetSummary'), ctx);
    sb.title(title, subtitle, 5);
    sb.section(4, t('report.excel.overview'), 5);
    const kpis = [
      [t('purchases.sumCarryOver'), major(s.carryOver), 'money'],
      [t('purchases.sumFundIn'), major(s.fundIn), 'money'],
      [t('purchases.sumSpent'), major(s.spent), 'money'],
      [t('purchases.sumBalance'), major(s.balance), 'money', true],
      [t('report.kpi.purchases'), s.purchaseCount, 'int'],
      [t('report.kpi.itemLines'), s.lineCount, 'int'],
      [t('report.kpi.products'), s.productCount, 'int'],
      [t('report.kpi.quantity'), s.totalQty, 'int'],
      [t('report.kpi.avgPerDay'), major(s.avgDailySpend), 'money'],
      [t('report.kpi.prevSpent'), major(s.prevSpent), 'money'],
      [t('report.kpi.change'), s.spentChange, 'change'],
      [
        s.biggestPurchase
          ? `${t('report.kpi.biggest')}: ${s.biggestPurchase.summary || noSummary} (${s.biggestPurchase.date})`
          : t('report.kpi.biggest'),
        s.biggestPurchase ? major(s.biggestPurchase.cost) : null,
        'money',
      ],
    ];
    kpis.forEach(([label, value, type, bold], i) => {
      const row = 5 + i;
      const labelCell = sb.ws.getCell(row, 1);
      labelCell.value = label;
      sb.style(labelCell, 'text', { bold, fill: i % 2 ? C.zebra : null });
      sb.ws.mergeCells(row, 1, row, 2);
      const valueCell = sb.ws.getCell(row, 3);
      valueCell.value = value;
      sb.style(valueCell, type, { bold, fill: i % 2 ? C.zebra : null });
      sb.ws.getRow(row).height = ROW.body;
      sb.track(3, sb.measure(type, value));
    });

    const catStart = 5 + kpis.length + 2;
    sb.section(catStart, t('report.byCategory'), 5);
    const rows = [];
    for (const cat of report.categories) {
      rows.push({ values: [cat.name ?? t('products.uncategorized'), '', major(cat.spent), cat.share, cat.lineCount], bold: true });
      for (const child of cat.children) {
        rows.push({ values: ['', child.name ?? t('report.directly'), major(child.spent), child.share, child.lineCount], indent: { 1: 1 }, colors: { 0: C.muted } });
      }
    }
    sb.table(
      catStart + 1,
      [
        { header: t('report.col.category'), type: 'text' },
        { header: t('report.col.subcategory'), type: 'text' },
        { header: t('report.col.spent'), type: 'money' },
        { header: t('report.col.share'), type: 'percent' },
        { header: t('report.col.items'), type: 'int' },
      ],
      rows,
      {
        zebra: false,
        total: (i) => [t('report.col.total'), null, major(s.spent), s.spent > 0 ? 1 : 0, s.lineCount][i],
      }
    );
    sb.finish({ min: 10, max: 40 });
    // Overview labels are merged across columns A+B: together they must fit the longest label.
    const labelWidth = Math.max(...kpis.map(([label]) => textWidth(label))) * 1.1 + 3;
    const a = sb.ws.getColumn(1);
    const b = sb.ws.getColumn(2);
    if (a.width + b.width < labelWidth) b.width = Math.min(60, Math.ceil(labelWidth - a.width));
  }

  // ---- Daily -----------------------------------------------------------------
  {
    const sb = new SheetBuilder(wb, t('report.excel.sheetDaily'), ctx);
    sb.title(`${title} — ${t('report.excel.sheetDaily')}`, subtitle, 6);
    const rows = [
      { values: [null, t('purchases.sumCarryOver'), null, null, null, major(s.carryOver)], bold: true, fill: C.sectionFill },
      ...report.days.map((d) => ({
        values: [excelDate(d.date), weekday(d.date), major(d.fundIn), major(d.spent), d.purchaseCount, major(d.balance)],
        colors: dayIndex(d.date) === 6 ? { 1: C.saturday } : dayIndex(d.date) === 0 ? { 1: C.sunday } : {},
      })),
    ];
    const lastBalance = [...report.days].reverse().find((d) => d.balance !== null);
    const { last } = sb.table(
      3,
      [
        { header: t('common.date'), type: 'date' },
        { header: t('report.col.weekday'), type: 'text' },
        { header: t('purchases.sumFundIn'), type: 'moneyDash' },
        { header: t('purchases.sumSpent'), type: 'moneyDash' },
        { header: t('report.kpi.purchases'), type: 'intDash' },
        { header: t('purchases.sumBalance'), type: 'money' },
      ],
      rows,
      {
        total: (i, col, from, to) =>
          [
            t('report.col.total'),
            null,
            { formula: `SUM(${col}${from}:${col}${to})`, result: major(s.fundIn) },
            { formula: `SUM(${col}${from}:${col}${to})`, result: major(s.spent) },
            { formula: `SUM(${col}${from}:${col}${to})`, result: s.purchaseCount },
            lastBalance ? major(lastBalance.balance) : major(s.balance),
          ][i],
      }
    );
    sb.finish({ min: 10, max: 30, freezeRow: 3, filter: { from: { row: 3, column: 1 }, to: { row: last, column: 6 } } });
  }

  // ---- Products --------------------------------------------------------------
  {
    const sb = new SheetBuilder(wb, t('report.excel.sheetProducts'), ctx, { landscape: true });
    sb.title(`${title} — ${t('report.excel.sheetProducts')}`, subtitle, 13);
    const rows = report.products.map((p, i) => ({
      values: [
        i + 1,
        p.name,
        p.standard || '',
        p.categoryPath || t('products.uncategorized'),
        p.purchaseCount,
        p.qty,
        major(p.avgPrice),
        major(p.minPrice),
        major(p.maxPrice),
        major(p.total),
        p.share,
        excelDate(p.firstDate),
        excelDate(p.lastDate),
      ],
    }));
    const { last } = sb.table(
      3,
      [
        { header: '#', type: 'int' },
        { header: t('products.name'), type: 'text' },
        { header: t('products.standard'), type: 'text' },
        { header: t('products.category'), type: 'text' },
        { header: t('report.kpi.purchases'), type: 'int' },
        { header: t('report.col.quantity'), type: 'int' },
        { header: t('report.col.avgPrice'), type: 'money' },
        { header: t('report.col.minPrice'), type: 'money' },
        { header: t('report.col.maxPrice'), type: 'money' },
        { header: t('report.col.spent'), type: 'money' },
        { header: t('report.col.share'), type: 'percent' },
        { header: t('report.col.firstDate'), type: 'date' },
        { header: t('report.col.lastDate'), type: 'date' },
      ],
      rows,
      {
        total: (i, col, from, to) =>
          ({
            0: t('report.col.total'),
            5: { formula: `SUM(${col}${from}:${col}${to})`, result: s.totalQty },
            9: { formula: `SUM(${col}${from}:${col}${to})`, result: major(s.spent) },
            10: s.spent > 0 ? 1 : 0,
          })[i],
      }
    );
    sb.finish({ min: 10, max: 42, fixed: { 1: 6 }, freezeRow: 3, filter: { from: { row: 3, column: 1 }, to: { row: Math.max(last, 3), column: 13 } } });
  }

  // ---- Details (journal) -------------------------------------------------------
  {
    const sb = new SheetBuilder(wb, t('report.excel.sheetJournal'), ctx, { landscape: true });
    const columns = [
      { header: t('common.date'), type: 'date' },
      { header: t('funds.type'), type: 'text' },
      { header: t('purchases.description'), type: 'text' },
      { header: t('products.name'), type: 'text' },
      { header: t('products.standard'), type: 'text' },
      { header: t('products.category'), type: 'text' },
      { header: t('items.price'), type: 'money' },
      { header: t('items.count'), type: 'int' },
      { header: t('items.lineTotal'), type: 'money' },
      { header: t('common.amount'), type: 'signed' },
      { header: t('purchases.sumBalance'), type: 'money' },
    ];
    sb.title(`${title} — ${t('report.excel.sheetJournal')}`, subtitle, columns.length);
    const rows = [];
    const bands = [];
    for (const day of report.journal) {
      bands.push(rows.length);
      const parts = [`${day.date} (${weekday(day.date)})`];
      if (day.spent) parts.push(`${t('purchases.sumSpent')} ${moneyText(day.spent)}`);
      if (day.fundIn) parts.push(`${t('purchases.sumFundIn')} ${moneyText(day.fundIn)}`);
      parts.push(`${t('purchases.sumBalance')} ${moneyText(day.balance ?? 0)}`);
      rows.push({ values: [parts.join('   ·   ')], band: true, bold: true, fill: C.dayFill, height: ROW.band });
      for (const e of day.entries) {
        if (e.kind === 'fund') {
          const carry = e.fundType === 0;
          rows.push({
            values: [
              excelDate(e.date),
              carry ? t('funds.typeCarryOver') : t('funds.typeInput'),
              carry ? t('purchases.carriedOverFrom', { month: e.sourceMonth ? monthLabel(e.sourceMonth) : '' }) : e.summary || '',
              null, null, null, null, null, null,
              major(e.amount),
              major(e.runningBalance),
            ],
          });
        } else {
          rows.push({
            values: [excelDate(e.date), t('report.typePurchase'), e.summary || noSummary, null, null, null, null, null, null, major(-e.cost), major(e.runningBalance)],
            bold: true,
          });
          for (const it of e.items) {
            rows.push({
              values: [null, null, null, it.name, it.standard || '', it.categoryPath || t('products.uncategorized'), major(it.price), it.count, major(it.total), null, null],
              indent: { 3: 1 },
              colors: { 5: C.muted },
            });
          }
        }
      }
    }
    const { first } = sb.table(3, columns, rows, {
      zebra: false,
      total: (i) => ({ 0: t('report.col.total'), 8: major(s.spent), 9: major(s.fundIn + s.carryOver - s.spent), 10: major(s.balance) })[i],
    });
    // Day bands span the whole row.
    for (const index of bands) {
      const r = first + index;
      sb.ws.mergeCells(r, 1, r, columns.length);
      const cell = sb.ws.getCell(r, 1);
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    }
    // Band text is long; it must not drive the date column width.
    sb.widths[1] = Math.max(textWidth(columns[0].header), 10);
    sb.finish({ min: 10, max: 40, freezeRow: 3 });
  }

  return wb;
}

module.exports = { buildReportWorkbook, numberFormats, textWidth };
