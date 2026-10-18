'use strict';

/*
 * End-to-end test: drives the real Electron app through its UI with Playwright.
 * A fresh, temporary data folder is used so your own database is never touched.
 *
 *   npm run test:e2e            (screenshots are written to e2e/screenshots)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const ExcelJS = require('exceljs');
const totp = require('../src/core/totp');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'screenshots');
const PASSWORD = 'Passw0rd!';
const MINUS = '−';

const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const CUR = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const PREV = `${prevDate.getFullYear()}-${pad2(prevDate.getMonth() + 1)}`;
const monthName = (m) => new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long' }).format(new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1));
const shortMonth = (m) => new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short' }).format(new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1));

// Default currency is Chinese yuan: ¥ and two decimals.
const num = (n) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const yuan = (n) => `¥${num(n)}`;
const plus = (n) => `+${num(n)}`;
const minus = (n) => `${MINUS}${num(n)}`;

let page;
let app;
const pageErrors = [];

async function text(selector) {
  return ((await page.locator(selector).first().textContent()) || '').trim();
}

/** Polls until the element's text contains (or matches) the expectation. */
async function expectText(selector, expected, timeout = 6000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = ((await page.locator(selector).first().textContent({ timeout: 300 })) || '').trim();
      if (expected instanceof RegExp ? expected.test(last) : last.includes(expected)) return last;
    } catch {
      last = '(not found)';
    }
    await page.waitForTimeout(80);
  }
  throw new Error(`Expected "${selector}" to contain ${expected} but it was ${JSON.stringify(last)}`);
}

/** Waits for a toast containing the text (older toasts may still be visible). */
async function expectToast(contains, kind = '') {
  await page.locator(`.toast${kind ? `.toast-${kind}` : ''}`, { hasText: contains }).first().waitFor({ timeout: 6000 });
}

async function expectCount(selector, count, timeout = 6000) {
  const started = Date.now();
  let n;
  while (Date.now() - started < timeout) {
    n = await page.locator(selector).count();
    if (n === count) return;
    await page.waitForTimeout(80);
  }
  throw new Error(`Expected ${count} × "${selector}" but found ${n}`);
}

async function shot(name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function selectByText(selector, label) {
  const value = await page.$eval(selector, (el, wanted) => [...el.options].find((o) => o.textContent.includes(wanted))?.value, label);
  assert.ok(value !== undefined, `option "${label}" in ${selector}`);
  await page.selectOption(selector, value);
}

async function nav(route) {
  await page.click(`a[data-route=${route}]`);
  await page.waitForSelector(`a[data-route=${route}].active`);
}

async function dialogAction(id) {
  await page.click(`dialog.modal [data-action=${id}]`);
  await page.waitForSelector('dialog.modal', { state: 'detached' });
}

async function login(username, password) {
  await page.waitForSelector('#login-username');
  await page.fill('#login-username', username);
  await page.fill('#login-password', password);
  await page.click('#login-submit');
}

/** Adds an item in the right pane: type name, optionally pick a suggestion, enter price and qty. */
async function addItem({ type, pick, price, count }) {
  const row = '.item-row.editing';
  const product = page.locator(`${row} .item-product`).last();
  await product.waitFor();
  await product.fill(type);
  if (pick) {
    await page.locator('.ac-popup:not([hidden]) .ac-item', { hasText: pick }).first().waitFor();
    await product.press('Enter');
    assert.equal(await product.inputValue(), pick);
  } else {
    await page.locator('.ac-popup:not([hidden]) .ac-footer').first().waitFor();
  }
  await page.locator(`${row} .item-price`).last().fill(String(price));
  const qty = page.locator(`${row} .item-count`).last();
  await qty.fill(String(count));
  await qty.press('Enter'); // finishes the row and opens a new empty one
}

async function newPurchase(date, summary) {
  await page.dblclick('#ledger-new-row');
  await page.waitForSelector('#ledger-edit-row');
  await page.fill('#edit-date', date);
  await page.fill('#edit-summary', summary);
  await page.press('#edit-summary', 'Enter');
  await expectText('#items-title', summary);
  await page.waitForSelector('.item-row.editing .item-product');
}

async function addFund(date, memo, amount) {
  await page.click('#add-fund');
  await page.waitForSelector('#ledger-edit-row');
  await page.fill('#edit-date', date);
  await page.fill('#edit-summary', memo);
  await page.fill('#edit-amount', amount);
  await page.press('#edit-amount', 'Enter');
  await page.waitForSelector('#ledger-edit-row', { state: 'detached' });
}

async function saveItems(expectedTotal) {
  await page.click('#items-save');
  await expectToast('Items saved', 'success');
  await expectText('#items-total', expectedTotal);
  await expectText('#items-match', 'Matches the cost');
}

const purchaseRow = (summary) => `.ledger-row.kind-purchase:has-text("${summary}")`;

const steps = [
  ['login rejects a wrong password, then forces the default password change', async () => {
    await page.waitForSelector('#login-username');
    await expectText('.login-hint', 'admin / admin');
    await shot('01-login');
    await login('admin', 'wrong');
    await expectText('.form-error', 'Wrong username or password');
    await login('admin', 'admin');
    await page.waitForSelector('#change-new');
    await shot('02-must-change-password');
    await page.fill('#change-current', 'admin');
    await page.fill('#change-new', PASSWORD);
    await page.fill('#change-confirm', PASSWORD);
    await page.click('#change-submit');
    await page.waitForSelector('#ledger-body');
    await expectText('#month-title', monthName(CUR));
  }],

  ['dark theme by default; sidebar and page follow the theme; navigation order', async () => {
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    const colors = () =>
      page.evaluate(() => ({
        page: getComputedStyle(document.body).backgroundColor,
        sidebar: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
        pane: getComputedStyle(document.querySelector('.pane')).backgroundColor,
      }));
    assert.deepEqual(await colors(), { page: 'rgb(11, 17, 32)', sidebar: 'rgb(17, 24, 39)', pane: 'rgb(17, 24, 39)' });
    await page.click('.sidebar .theme-toggle');
    await page.waitForSelector('html[data-theme=light]');
    assert.deepEqual(await colors(), { page: 'rgb(244, 246, 249)', sidebar: 'rgb(255, 255, 255)', pane: 'rgb(255, 255, 255)' });
    await page.click('.sidebar .theme-toggle');
    await page.waitForSelector('html[data-theme=dark]');
    const order = await page.$$eval('.nav-list a', (links) => links.map((a) => a.dataset.route));
    assert.deepEqual(order, ['categories', 'products', 'funds', 'purchases', 'report', 'settings']);
  }],

  ['language switches between English and Korean', async () => {
    await page.click('.sidebar .lang-btn[data-lang=ko]');
    await expectText('a[data-route=purchases]', '구매 내역');
    await expectText('#sum-balance', '남은 금액');
    await page.click('.sidebar .lang-btn[data-lang=en]');
    await expectText('a[data-route=purchases]', 'Purchases');
  }],

  ['categories: create nested tree, block deleting a parent', async () => {
    await nav('categories');
    await page.click('#category-add-root');
    await page.fill('#category-name', 'Food');
    await page.click('#category-save');
    await page.waitForSelector('.tree-node[data-name="Food"].selected');
    await page.click('#category-add-child');
    await page.fill('#category-name', 'Groceries');
    await page.click('#category-save');
    await page.waitForSelector('.tree-node[data-name="Groceries"].selected');
    await expectText('#category-path', 'Food > Groceries');
    await page.click('#category-add-root');
    await page.fill('#category-name', 'Transport');
    await page.click('#category-save');
    await expectCount('.tree-node', 3);
    const pad = (name) => page.$eval(`.tree-node[data-name="${name}"]`, (el) => parseInt(el.style.paddingLeft, 10));
    assert.ok((await pad('Groceries')) > (await pad('Food')), 'Groceries is indented under Food');
    await page.click('.tree-node[data-name="Food"]');
    await page.click('#category-delete');
    await expectToast('subcategor', 'error');
    await shot('03-categories');
  }],

  ['products: add products in categories, the same name with two standards', async () => {
    await nav('products');
    for (const [name, standard, cat] of [['Milk', '1L', 'Groceries'], ['Milk', '500ml', 'Groceries'], ['Bus fare', '', 'Transport']]) {
      await page.click('#products-add');
      await page.fill('#product-name', name);
      await page.fill('#product-standard', standard);
      await selectByText('#product-category', cat);
      await dialogAction('save');
      await page.waitForSelector(`#products-table tr:has-text("${name}")`);
    }
    // The same name + standard twice is refused.
    await page.click('#products-add');
    await page.fill('#product-name', 'milk');
    await page.fill('#product-standard', '1l');
    await page.click('dialog.modal [data-action=save]');
    await expectText('dialog.modal .form-error', 'name and standard already exists');
    await dialogAction('cancel');
    await expectText('#products-count', '3 products');
    const standards = await page.$$eval('#products-table tbody tr', (rows) => rows.map((r) => `${r.cells[0].textContent}|${r.cells[1].textContent}`));
    assert.deepEqual(standards, ['Bus fare|—', 'Milk|1L', 'Milk|500ml']);
    await expectText('#products-table tr:has-text("500ml")', 'Food > Groceries');
  }],

  ['purchases: fund input shows green and updates money left', async () => {
    await nav('purchases');
    await addFund(`${CUR}-01`, 'Salary', '3,000,000');
    await expectText('.ledger-row.kind-fund:has-text("Salary") .amount', plus(3000000));
    assert.match(await page.getAttribute('.ledger-row.kind-fund:has-text("Salary") .amount', 'class'), /amount-plus/);
    await expectText('#sum-in', plus(3000000));
    await expectText('#sum-balance', yuan(3000000));
  }],

  ['purchases: double-click to add a purchase, choose a standard, new product, save items', async () => {
    await newPurchase(`${CUR}-05`, 'E-Mart');
    // Autocomplete suggests the registered name together with its number of standards.
    const product = page.locator('.item-row.editing .item-product').last();
    await product.fill('Mi');
    await page.locator('.ac-popup:not([hidden]) .ac-item', { hasText: 'Milk' }).waitFor();
    await expectText('.ac-popup:not([hidden]) .ac-item', '2 standards');
    await shot('04-autocomplete');
    await product.press('Enter');
    assert.equal(await product.inputValue(), 'Milk');
    // Picking the name lists its standards in the standard field.
    const standard = page.locator('.item-row.editing .item-standard').last();
    await page.locator('.ac-popup:not([hidden]) .ac-item', { hasText: '500ml' }).waitFor();
    assert.equal(await standard.evaluate((el) => el === document.activeElement), true);
    assert.deepEqual(await page.$$eval('.ac-popup:not([hidden]) .ac-item .ac-name', (els) => els.map((e) => e.textContent).sort()), ['1L', '500ml']);
    await shot('04b-standards');
    await page.locator('.item-row.editing .item-price').last().fill('2500');
    const qty = page.locator('.item-row.editing .item-count').last();
    await qty.fill('2');
    // Leaving the standard empty is refused while the name has standards.
    await qty.press('Enter');
    await expectText('.item-row.editing .row-error', 'several standards');
    await page.locator('.ac-popup:not([hidden]) .ac-item', { hasText: '500ml' }).click();
    assert.equal(await standard.inputValue(), '500ml');
    await qty.press('Enter');
    await page.waitForSelector('.item-row:not(.editing):has-text("500ml")');
    // An unregistered product is offered as new and created on save.
    await addItem({ type: 'Bread', price: 3200, count: 3 });
    await expectText('#items-total', yuan(14600));
    await expectText('#items-unsaved', 'Unsaved');
    await saveItems(yuan(14600));
    await expectToast('New products added: Bread');
    // Toasts sit in the top-right corner of the window.
    const toastBox = await page.evaluate(() => {
      const r = document.querySelector('.toast').getBoundingClientRect();
      return { right: Math.round(window.innerWidth - r.right), top: Math.round(r.top) };
    });
    assert.ok(toastBox.right <= 24 && toastBox.top <= 24, `toast at ${JSON.stringify(toastBox)}`);
    await expectText(`${purchaseRow('E-Mart')} .amount`, minus(14600));
    assert.match(await page.getAttribute(`${purchaseRow('E-Mart')} .amount`, 'class'), /amount-minus/);
    await expectText('#sum-spent', minus(14600));
    await expectText('#sum-balance', yuan(2985400));
    const lines = await page.$$eval('#items-body .line-total', (els) => els.map((e) => e.textContent));
    assert.deepEqual(lines, [num(5000), num(9600)]);
  }],

  ['purchases: double-clicking a purchase edits summary/date and shows its cost', async () => {
    await page.dblclick(purchaseRow('E-Mart'));
    await page.waitForSelector('#ledger-edit-row');
    await expectText('#edit-cost', minus(14600));
    assert.equal(await page.inputValue('#edit-summary'), 'E-Mart');
    assert.equal(await page.inputValue('#edit-date'), `${CUR}-05`);
    await page.fill('#edit-summary', 'E-Mart groceries');
    await page.press('#edit-summary', 'Enter');
    await expectText('#items-title', 'E-Mart groceries');
    await expectText(`${purchaseRow('E-Mart groceries')} .desc-text`, 'E-Mart groceries');
  }],

  ['purchases: second purchase and running balance', async () => {
    await newPurchase(`${CUR}-07`, 'Bus');
    await addItem({ type: 'Bus', pick: 'Bus fare', price: 1500, count: 10 });
    await saveItems(yuan(15000));
    await expectText('#sum-balance', yuan(2970400));
    const running = await page.$$eval('#ledger-body .ledger-row .running', (els) => els.map((e) => e.textContent));
    assert.deepEqual(running, [num(3000000), num(2985400), num(2970400)]);
    await shot('05-purchases');
  }],

  ['purchases: edit and remove items, totals stay in sync with the list', async () => {
    await page.click(purchaseRow('E-Mart groceries'));
    await expectText('#items-title', 'E-Mart groceries');
    await page.dblclick('.item-row:has-text("Milk")');
    await page.locator('.item-row.editing .item-count').fill('3');
    await expectText('#items-total', yuan(17100));
    await saveItems(yuan(17100));
    await expectText('#sum-balance', yuan(2967900));
    await page.click('.item-row:has-text("Bread") .row-delete');
    await expectText('#items-total', yuan(7500));
    await saveItems(yuan(7500));
    await expectText(`${purchaseRow('E-Mart groceries')} .amount`, minus(7500));
    await expectText('#sum-balance', yuan(2977500));
  }],

  ['purchases: unsaved item changes are guarded when switching purchase', async () => {
    await page.dblclick('.item-row:has-text("Milk")');
    await page.locator('.item-row.editing .item-count').fill('5');
    await expectText('#items-total', yuan(12500));
    await page.click(purchaseRow('Bus'));
    await expectText('dialog.modal .modal-title', 'Discard changes?');
    await dialogAction('cancel');
    await expectText('#items-title', 'E-Mart groceries');
    // Starting a new purchase is guarded as well.
    await page.dblclick('#ledger-new-row');
    await expectText('dialog.modal .modal-title', 'Discard changes?');
    await dialogAction('cancel');
    await expectCount('#ledger-edit-row', 0);
    await expectText('#items-total', yuan(12500));
    await page.click('#items-revert');
    await expectText('#items-total', yuan(7500));
    await page.click(purchaseRow('Bus'));
    await expectText('#items-title', 'Bus');
  }],

  ['previous month: confirm creates the carried-over record on the 1st', async () => {
    await page.click('#prev-month');
    await expectText('#month-title', monthName(PREV));
    await addFund(`${PREV}-10`, 'Bonus', '1000000');
    await newPurchase(`${PREV}-12`, 'Gas station');
    await addItem({ type: 'Fuel', price: 50000, count: 1 });
    await saveItems(yuan(50000));
    await expectText('#sum-balance', yuan(950000));
    await page.click('#confirm-month');
    await expectText('dialog.modal .confirm-message', yuan(950000));
    await dialogAction('confirm');
    await expectToast('Confirmed', 'success');
    await expectText('#month-status', 'Confirmed');
    await page.waitForSelector('.banner-locked');
    await expectCount('#ledger-new-row', 0);
    await expectCount('#add-fund', 0);
    await page.dblclick(purchaseRow('Gas station'));
    await expectToast('is confirmed');
    await shot('06-confirmed-month');
  }],

  ['current month shows the carried-over amount and the new money left', async () => {
    await page.click('#next-month');
    await expectText('#month-title', monthName(CUR));
    const carry = '.ledger-row.kind-carry';
    await expectText(`${carry} .desc-text`, shortMonth(PREV));
    await expectText(`${carry} .amount`, plus(950000));
    await expectText('#sum-carry', plus(950000));
    await expectText('#sum-balance', yuan(3927500));
    await page.dblclick(carry);
    await expectToast('created automatically');
  }],

  ['reopen + change + confirm again overwrites the carried-over amount', async () => {
    await page.click('#prev-month');
    await page.click('#reopen-month');
    await dialogAction('confirm');
    await expectText('#month-status', 'Open');
    await newPurchase(`${PREV}-20`, 'Snack');
    await addItem({ type: 'Chips', price: 3000, count: 1 });
    await saveItems(yuan(3000));
    await expectText('#sum-balance', yuan(947000));
    await page.click('#next-month');
    await page.waitForSelector('.banner-warn'); // carried-over amount no longer matches
    await page.click('#prev-month');
    await page.click('#confirm-month');
    await dialogAction('confirm');
    await expectText('#month-status', 'Confirmed');
    await page.click('#next-month');
    await expectCount('.ledger-row.kind-carry', 1);
    await expectText('.ledger-row.kind-carry .amount', plus(947000));
    await expectText('#sum-balance', yuan(3924500));
    await expectCount('.banner-warn', 0);
  }],

  ['funds page lists inputs and the system carried-over record', async () => {
    await nav('funds');
    await page.waitForSelector('#funds-table');
    const sameYear = PREV.slice(0, 4) === CUR.slice(0, 4);
    await expectCount('#funds-table .fund-row', sameYear ? 3 : 2);
    await expectText('#funds-table', 'Carried over');
    await expectText('#funds-totals', sameYear ? yuan(4000000) : yuan(3000000));
    await shot('07-funds');
  }],

  ['products page shows auto-created products and usage statistics', async () => {
    await nav('products');
    await page.waitForSelector('#products-table');
    await expectText('#products-count', '6 products');
    await expectText('#products-table tr:has-text("Bread")', 'Uncategorized');
    const milk = await page.$$eval('#products-table tr:has-text("500ml") td', (tds) => tds.map((td) => td.textContent.trim()));
    assert.equal(milk[3], '1'); // purchases
    assert.equal(milk[4], '3'); // total qty
    assert.equal(milk[5], num(7500)); // total spent
    assert.equal(milk[6], num(2500)); // last price
    const milk1l = await page.$$eval('#products-table tr:has-text("1L") td', (tds) => tds.map((td) => td.textContent.trim()));
    assert.equal(milk1l[3], '0'); // the other standard was not bought
    await shot('08-products');
  }],

  ['a new standard typed in a purchase becomes a product with the same category', async () => {
    await nav('purchases');
    await newPurchase(`${CUR}-09`, 'Corner shop');
    const product = page.locator('.item-row.editing .item-product').last();
    await product.fill('milk');
    await page.locator('.ac-popup:not([hidden]) .ac-item', { hasText: 'Milk' }).waitFor();
    await product.press('Enter');
    const standard = page.locator('.item-row.editing .item-standard').last();
    await page.locator('.ac-popup:not([hidden]) .ac-item', { hasText: '1L' }).waitFor();
    await standard.fill('2L');
    await expectText('.ac-popup:not([hidden]) .ac-footer', 'new standard for Milk');
    await page.locator('.item-row.editing .item-price').last().fill('4200');
    await page.locator('.item-row.editing .item-count').last().press('Enter');
    await saveItems(yuan(4200));
    await expectToast('New products added: Milk (2L)');
    await nav('products');
    await expectText('#products-table tr:has-text("2L")', 'Food > Groceries');
    // Remove the purchase again so the remaining numbers stay as before.
    await nav('purchases');
    await page.click(`${purchaseRow('Corner shop')} .row-delete`);
    await dialogAction('confirm');
    await expectText('#sum-balance', yuan(3924500));
  }],

  ['monthly report: headline numbers, charts, tables, journal and a styled Excel export', async () => {
    await nav('report');
    await expectText('#report-month', monthName(CUR));
    await expectText('#kpi-carry .kpi-value', yuan(947000));
    await expectText('#kpi-in .kpi-value', yuan(3000000));
    await expectText('#kpi-spent .kpi-value', yuan(22500));
    await expectText('#kpi-balance .kpi-value', yuan(3924500));
    await expectText('#kpi-purchases .kpi-value', '2');
    // Daily money flow: one column per spending day; hovering shows that day.
    await expectCount('#report-flow-chart .chart-bar', 2);
    // The chart's hit layer sits above the bars (the whole day column is the target).
    const barBox = await page.locator('#report-flow-chart .chart-bar').first().boundingBox();
    await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
    await expectText('#report-flow-chart .chart-tooltip', yuan(7500));
    await expectText('#report-flow-chart .chart-tooltip', yuan(3939500));
    await expectText('#report-categories', 'Food');
    await expectText('#report-categories', 'Transport');
    await expectText('#report-top', '500ml');
    // All products: sorted by spending, re-sortable, totals match.
    const names = () => page.$$eval('#report-products-table tbody tr', (rows) => rows.map((r) => `${r.cells[0].textContent}|${r.cells[1].textContent}`));
    assert.deepEqual(await names(), ['Bus fare|—', 'Milk|500ml']);
    await page.click('#report-products-table [data-sort=name]');
    await page.click('#report-products-table [data-sort=name]');
    assert.deepEqual(await names(), ['Milk|500ml', 'Bus fare|—']);
    await expectText('#report-products-total', yuan(22500));
    await expectCount('#report-journal-table .journal-purchase', 2);
    await expectCount('#report-journal-table .journal-item', 2);
    await shot('14-report');
    await page.locator('#report-products').screenshot({ path: path.join(SHOTS, '14b-report-products.png') });
    await page.locator('#report-journal').screenshot({ path: path.join(SHOTS, '14c-report-journal.png') });
    // Table view of the chart.
    await page.click('#report-flow-toggle');
    await expectCount('#report-daily-table tbody tr', new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
    await page.click('#report-flow-toggle');

    // Excel export: the save dialog is answered in the main process.
    const file = path.join(os.tmpdir(), `fund-manage-e2e-${Date.now()}.xlsx`);
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, file);
    await page.click('#report-export');
    await expectToast('Exported', 'success');
    await page.waitForSelector('#report-open-export');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Daily', 'Products', 'Details']);
    const products = wb.getWorksheet('Products');
    assert.equal(products.getCell('B4').value, 'Bus fare');
    assert.equal(products.getCell('C5').value, '500ml');
    const total = products.getCell('J6').value;
    assert.equal(Math.round(total.result * 100), 2250000);
    assert.equal(products.getRow(3).getCell(1).fill.fgColor.argb, 'FF1F3A5F');
    fs.rmSync(file, { force: true });

    // A purchase in the journal opens on the Purchases page.
    await page.click('#report-journal-table .journal-open >> text=Bus');
    await expectText('#items-title', 'Bus');
    await expectText('#month-title', monthName(CUR));
  }],

  ['two-step verification with Google Authenticator codes', async () => {
    await nav('settings');
    await page.click('#tab-security');
    await page.click('#totp-begin');
    await page.waitForSelector('#totp-qr');
    const secret = (await text('#totp-secret')).replace(/\s/g, '');
    assert.match(secret, /^[A-Z2-7]{32}$/);
    await shot('09-2fa-setup');
    await page.fill('#totp-code', totp.totp(secret));
    await page.click('#totp-confirm');
    await page.waitForSelector('#recovery-codes');
    const codes = await page.$$eval('#recovery-codes code', (els) => els.map((e) => e.textContent));
    assert.equal(codes.length, 8);
    await dialogAction('done');
    await expectText('#totp-status', 'on');

    await page.click('#logout-btn');
    await login('admin', PASSWORD);
    await page.waitForSelector('#login-code');
    const valid = new Set([-1, 0, 1].map((d) => totp.totp(secret, { time: Date.now() + d * 30000 })));
    await page.fill('#login-code', ['000000', '111111', '222222', '333333'].find((c) => !valid.has(c)));
    await page.click('#login-verify');
    await expectText('.form-error', 'not valid');
    // Next time step: the code used during setup cannot be replayed.
    await page.fill('#login-code', totp.totp(secret, { time: Date.now() + 30000 }));
    await page.click('#login-verify');
    await page.waitForSelector('#logout-btn'); // back in the app (on the page used last)
    await expectText('.user-name', 'admin');

    await page.click('#logout-btn');
    await login('admin', PASSWORD);
    await page.waitForSelector('#login-code');
    await page.click('text=Use a recovery code');
    await page.fill('#login-code', codes[0]);
    await page.click('#login-verify');
    await page.waitForSelector('#logout-btn');
    await nav('settings');
    await page.click('#tab-security');
    await expectText('#recovery-left', '7 recovery codes left');
  }],

  ['dictionary editor changes a Korean label', async () => {
    await nav('settings');
    await page.click('#tab-dictionary');
    await page.fill('#dict-search', 'nav.funds');
    const ko = 'textarea[data-key="nav.funds"][data-lang="ko"]';
    await page.waitForSelector(ko);
    await page.fill(ko, '자금 내역');
    await page.press(ko, 'Tab');
    await expectToast('Saved', 'success');
    await shot('10-dictionary');
    await page.click('.sidebar .lang-btn[data-lang=ko]');
    await expectText('a[data-route=funds]', '자금 내역');
    await nav('purchases');
    await expectText('#sum-balance', '남은 금액');
    await shot('11-purchases-korean');
    await nav('settings');
    await page.fill('#dict-search', 'nav.funds');
    await page.click(`${ko} + button`);
    await page.click('.sidebar .lang-btn[data-lang=en]');
    await expectText('a[data-route=funds]', 'Funds');
  }],

  ['currency: USD / KRW / CNY only, CNY by default; theme selectable in settings', async () => {
    await nav('settings');
    await page.click('#tab-general');
    assert.deepEqual(await page.$$eval('#setting-currency option', (opts) => opts.map((o) => o.value)), ['USD', 'KRW', 'CNY']);
    assert.equal(await page.inputValue('#setting-currency'), 'CNY');
    assert.equal(await page.inputValue('#setting-theme'), 'dark');
    await page.selectOption('#setting-currency', 'KRW');
    await expectToast('Saved', 'success');
    await nav('purchases');
    await expectText('#sum-balance', '₩3,924,500'); // same stored amounts, won formatting
    await nav('settings');
    await page.click('#tab-general');
    await page.selectOption('#setting-currency', 'CNY');
    await nav('purchases');
    await expectText('#sum-balance', yuan(3924500));
    await shot('12-dark-theme');

    await nav('settings');
    await page.click('#tab-general');
    await page.selectOption('#setting-theme', 'light');
    await page.waitForSelector('html[data-theme=light]');
    await nav('purchases');
    await page.click(purchaseRow('E-Mart groceries'));
    await expectText('#items-title', 'E-Mart groceries');
    await shot('13-light-theme');
    await nav('report');
    await page.waitForSelector('#report-flow-chart .chart-bar');
    await shot('15-report-light');
    await nav('purchases');
    await page.click('.sidebar .theme-toggle');
    await page.waitForSelector('html[data-theme=dark]');
    await page.click('#logout-btn');
    await page.waitForSelector('.login-card .theme-toggle');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  }],

  ['no renderer errors were raised', async () => {
    assert.deepEqual(pageErrors, []);
  }],
];

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-manage-e2e-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  app = await electron.launch({ args: [ROOT, `--data-dir=${dataDir}`], cwd: ROOT, env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });

  let failed = 0;
  for (const [name, fn] of steps) {
    const started = Date.now();
    try {
      await fn();
      console.log(`  ✔ ${name} (${Date.now() - started} ms)`);
    } catch (err) {
      failed += 1;
      console.log(`  ✖ ${name}\n    ${err.stack || err}`);
      await page.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {});
      break;
    }
  }
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(failed ? `\nE2E FAILED` : `\nE2E passed: ${steps.length} steps. Screenshots: ${SHOTS}`);
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  if (app) await app.close().catch(() => {});
  process.exit(1);
});
