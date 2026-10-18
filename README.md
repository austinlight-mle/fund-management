# Fund Manager

A desktop app (Electron + SQLite) for tracking how money flows each month: fund inputs, purchases with their items, and the balance carried over from one month to the next. It targets Windows and also runs on macOS and Linux. The UI is available in English and Korean.

## Quick start

```bash
npm install
npm start            # opens the app with your own database
npm run demo         # opens the app on a separate demo database with sample data
```

Sign in with **admin / admin**. On first sign-in you must choose a new password (you can change the username too).

Ready-made apps for Windows, macOS and Linux are published on the repository's **Releases** page each time `main` is updated (see [Releases (CI/CD)](#releases-cicd)). To build locally, run `npm run dist` (Windows), `npm run dist:mac` (on a Mac) or `npm run dist:linux`; output goes to `dist/`.

## Using the app

The sidebar lists **Categories, Products, Funds, Purchases, Monthly Report, Settings**; the app opens on Purchases.

- **Theme**: Dark (default) or Light. Switch it with the sun/moon button in the sidebar or on the sign-in screen, or in Settings → *General*. The whole window follows the theme: sidebar, pages, scrollbars and date pickers.
- **Currency**: Chinese yuan (default, ¥ with 2 decimals), US dollar ($ with 2 decimals) or Korean won (₩, no decimals), set in Settings → *General*.
- **Messages** appear briefly in the top-right corner. Clicks pass through them, so they never block a button.

### Purchases page

- **Month bar**: ◀ / ▶ switch months (the current month opens by default), **This month** jumps back, and **Confirm month** / **Reopen month** control the month's status.
- **Left pane** lists all records of the month by date, with a running balance:
  - Fund records are shown in **green (+)**: *Carried over* (created automatically) and *Fund input* (added with **Add fund**).
  - Purchases are shown in **red (−)**. Their amount is the sum of `price × qty` over their items.
  - **Click** a purchase to select it. **Double-click** it to edit its summary and date; the editor also shows its cost.
  - **Double-click the empty row** at the bottom to add a purchase. After you press Enter it is selected and the first item row opens.
  - The footer shows Carried over, Funds in, Spent and **Money left**.
- **Right pane** shows the items of the selected purchase:
  - **Double-click the empty row** to add an item, or double-click an item to edit it.
  - While you type a product name, registered names are suggested (↑/↓ and Enter, or click), each with its standard or its number of standards. A name that isn't registered is marked **New** and added to the product table when you save.
  - **Standard** (size, volume, model, e.g. 1L / 500ml): after you pick a name, all of its standards are listed in the *Standard* field.
    - If the name has a single standard, it is filled in for you.
    - If it has several, you must choose one before the row is accepted, or type a new standard on purpose. A new standard is added as its own product with the same category.
    - Choosing a standard fills in the last price you paid for it.
  - Each row shows `price × qty`, and the footer shows the total cost. Nothing is written until you press **Save**; **Revert** discards your changes. After saving, the total equals the purchase's amount in the left pane.
  - Shortcuts: Enter in *Qty* finishes the row and starts a new one, and Esc cancels the edit.
- Leaving a purchase with unsaved item changes asks for confirmation.

### Month confirmation and carry-over

- **Confirm month** stores the month's *money left* as a **carried-over** fund record (`type = 0`) dated on the **1st of the next month**. If that record already exists, its amount is overwritten, so there is never more than one carry-over per month.
- A confirmed month is **locked**: its purchases, items and fund inputs can't be added, changed, deleted, or moved in or out of it. **Reopen month** unlocks it, and confirming it again overwrites the carry-over.
- If later months are already confirmed, confirming an earlier month refreshes their carry-over amounts as well (a cascade), so the chain always adds up.
- Warnings appear when the previous month hasn't been confirmed yet, or when a carry-over no longer matches the previous month's money left.
- Months that haven't started yet can't be confirmed.

### Monthly Report

Everything about one month on a single page. It follows the month you last viewed on the Purchases page.

- **Stat tiles**: carried over, funds in, spent (with the change vs last month), money left, purchases (items and products), average spending per day.
- **Daily money flow**: two charts sharing the day axis:
  - spending per day (columns);
  - money left at the end of each day (line, with fund inputs marked).

  Hover, or focus the chart and use ←/→, to see a day's spending, funds and balance. **Show table** switches to the same numbers as a table.
- **Spending by category**: top-level categories and their subcategories, with amounts and share of spending.
- **Top products**: where most of the money went.
- **All products bought**: every product and standard with purchase count, quantity, average price, price range, total, share and last purchase date. Search it, and click a column to sort.
- **Daily journal**: every record by date: fund inputs, purchases and each purchased item (standard, category, price × qty), with the money left after each record. Click a purchase to open it on the Purchases page.
- **Export to Excel**: saves a styled `.xlsx` in the current language and currency, with four sheets:
  - *Summary*: overview and spending by category.
  - *Daily*: one row per day, with `SUM` totals.
  - *Products*: one row per product and standard.
  - *Details*: the journal with item lines, banded by day.

  All four sheets have column widths sized to their content, set row heights, navy header rows, number and date formats (negative amounts in red), frozen header rows, filters, and landscape/fit-to-width print setup. After exporting, **Open exported file** opens it.

### Other pages

- **Funds**: every fund record for a year, with monthly subtotals. Fund inputs can be added, edited and deleted. Carried-over records are read-only.
- **Products**: search by name or standard, filter by category (subcategories included) or *Uncategorized*, and see usage statistics (purchases, total quantity, total spent, last price, last purchase date). The same name can exist once per **standard** (e.g. Milk 1L and Milk 500ml); each one is a separate product with its own prices and statistics. A product that is used in purchases can't be deleted; mark it *inactive* to hide it from suggestions.
- **Categories**: nested tree. Add top-level categories or subcategories, rename, move to another parent (moving a category under itself or one of its descendants is blocked), set the sort order, and delete. A category that has subcategories can't be deleted; its products become *Uncategorized* when it is deleted.
- **Settings**:
  - *General*: language, theme and currency.
  - *Account*: change username and password.
  - *Two-step verification*: Google Authenticator.
  - *Users*: add users, reset passwords, delete users.
  - *Dictionary*: edit translations.
  - *Data*: database location and backup.

### Two-step verification (optional)

Settings → *Two-step verification* → scan the QR code with Google Authenticator (or any TOTP app) → enter the 6-digit code. You then get 8 one-time **recovery codes**; keep them safe. From then on, sign-in asks for a code after the password. Codes can't be reused, and wrong codes count toward the lockout.

Five wrong passwords or codes lock the account for 5 minutes.

### Language and dictionary

All texts come from two flat dictionaries, one key per text:

- `src/i18n/en.json`
- `src/i18n/ko.json`

To change a Korean wording, edit the value in `ko.json`, or use **Settings → Dictionary** inside the app. Changes made there are stored in the database (`translation_override` table), and clearing a field restores the default. The two files must keep the same keys; `npm test` checks this, along with the `{placeholders}` and that every key used in the code exists.

## Data

The database is a single SQLite file:

- Windows: `%APPDATA%\Fund Manager\fund-manage.db`
- macOS: `~/Library/Application Support/Fund Manager/`
- Linux: `~/.config/Fund Manager/`

Settings → *Data* shows the exact path and makes a backup copy (a safe online backup). To use another folder, run `npm start -- --data-dir=<folder>` or set `FUND_MANAGE_DATA_DIR`.

When a new version changes the database schema, the existing file is copied first, e.g. `fund-manage.db.v1.bak`. Upgrades run in transactions with foreign-key checks, and existing data is kept: products from before the *standard* column get an empty standard.

### Schema

All money columns are **INTEGER minor units = value × 100** (¥12.50 → `1250`, ₩12,000 → `1200000`). Integer math keeps every sum exact; the currency setting only controls display and input precision.

| Table | Purpose | Main columns |
| --- | --- | --- |
| `category` | Nested product categories | `id`, `name`, `parent_id` → category, `description`, `sort_order`, timestamps. Sibling names are unique (case-insensitive). |
| `product` | Products by name and standard | `id`, `name`, `standard` ('' = none; name + standard unique, case-insensitive), `category_id` → category (NULL = uncategorized), `memo`, `is_active`, timestamps |
| `fund` | Money in | `id`, `type` (0 = carried over, 1 = fund input), `amount`, `date`, `memo`, `source_month` (type 0), `created_by`, timestamps. At most one `type = 0` row per month, always dated on the 1st. |
| `purchase` | One purchase / receipt | `id`, `summary`, `date`, `memo`, `created_by`, timestamps |
| `purchase_list` | Items of a purchase | `id`, `purchase_id` → purchase (cascade delete), `product_id` → product, `price` (unit price), `count`, `memo`, `sort_order`, timestamps |
| `user` | Sign-in | `id`, `username`, `password_hash` (scrypt), `must_change_password`, `totp_enabled`, `totp_secret`, `totp_last_step`, `recovery_codes` (hashed), `failed_login_count`, `locked_until`, `last_login_at`, `password_changed_at`, `is_active`, timestamps |
| `month_closing` | Confirmed (locked) months | `month`, `closing_balance`, `carry_over_fund_id`, `confirmed_by`, `confirmed_at` |
| `app_setting` | Language, theme and currency | `key`, `value` |
| `translation_override` | Dictionary edits | `lang`, `key`, `value` |

The month view (all records, running balance, totals, previous-month check and confirmation state) is computed by **one SQL query**, `MONTH_LEDGER_SQL` in [src/core/services/ledger.js](src/core/services/ledger.js). A test asserts that rendering a month runs exactly one statement.

## Tests

```bash
npm test             # 44 unit/integration tests (node:test, in-memory SQLite)
npm run test:e2e     # drives the real Electron app with Playwright (temporary data folder)
npm run test:all
```

- **`test/ledger.test.js`** seeds six months of pseudo-random funds, purchases and items. It then checks every entry amount, running balance, total, carry-over chain and the all-time identity against a calculation done independently in the test. It also covers re-confirm overwrite, the cascade, locking, negative balances, the single-query guarantee and performance on 30,000 items.
- **`test/report.test.js`** checks the Monthly Report against the same seeded data, computed independently: summary, every day, every category and subcategory, every product and standard, and the journal. It also writes the Excel file, reads it back, and checks the sheets, values, `SUM` formulas, number formats, header styles, column widths, row heights, frozen panes and the Korean/won variant.
- **`test/migration.test.js`** upgrades a v1 database: products keep their ids, purchase links and categories, and the backup file is written.
- **The other files** cover authentication (default admin, forced change, lockout, TOTP against the RFC 6238 vectors, replay protection, recovery codes), categories, products and standards, purchases (transactional save, auto-created products), money parsing and the dictionaries.
- **The E2E run** uses the UI to do the full workflow: login, password change, language switch, categories, products, purchases by double-click, autocomplete, choosing a standard (and the error when none is chosen), adding a new standard, saving items, confirm, carry-over, reopen and re-confirm, funds, the Monthly Report (numbers, chart hover, sorting, journal link, Excel export read back), 2FA sign-in with a code and with a recovery code, the dictionary editor, theme and currency. It saves screenshots to `e2e/screenshots/`.

## Releases (CI/CD)

GitHub Actions workflows live in [.github/workflows](.github/workflows):

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every pull request (and called by `release.yml`) | unit tests on Windows, macOS and Linux; end-to-end test of the real app on Windows (screenshots are kept as an artifact) |
| `release.yml` | every push to `main`, or run it by hand | tests → builds on Windows, macOS and Linux in parallel → a GitHub release tagged `vX.Y.N` with every installer attached |

**Version**: the release takes major and minor from `package.json` and uses the workflow run number as the patch number. For example, `1.0.0` in `package.json` gives releases `1.0.1`, `1.0.2`, and so on. The number is also stamped into the app (Settings → *Data*). Change major or minor in `package.json` to start a new series.

**Release assets**:

| Platform | Files |
| --- | --- |
| Windows (x64) | `FundManager-X.Y.N-win-x64-setup.exe` (installer), `FundManager-X.Y.N-win-x64-portable.exe` (no install) |
| macOS (Apple Silicon / Intel) | `FundManager-X.Y.N-mac-arm64.dmg`, `…-mac-x64.dmg`, plus `.zip` versions of both |
| Linux (x64 / arm64) | `FundManager-X.Y.N-linux-x86_64.AppImage`, `…-linux-arm64.AppImage`, `fund-manage_X.Y.N_amd64.deb`, `…_arm64.deb` |

**Opening unsigned builds**: without signing certificates, each OS warns once.

- **Windows**: SmartScreen shows "Windows protected your PC". Click *More info* → *Run anyway*.
- **macOS**: the app is ad-hoc signed, not notarized. Right-click the app → *Open* → *Open* (or *System Settings → Privacy & Security → Open Anyway*). If macOS says the app "is damaged", run `xattr -dr com.apple.quarantine "/Applications/Fund Manager.app"`.
- **Linux**: run `chmod +x FundManager-*.AppImage` before starting the AppImage, or install the `.deb` with `sudo apt install ./fund-manage_*.deb`.

**Code signing (optional)**: add these repository secrets (*Settings → Secrets and variables → Actions*) and the next release is signed:

| Secret | Purpose |
| --- | --- |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows code-signing certificate (`.pfx`, base64-encoded) and its password |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | Apple "Developer ID Application" certificate (`.p12`, base64-encoded) and its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Apple notarization, so macOS opens the app without warnings |

Builds need no compiler: better-sqlite3 ships prebuilt binaries for every platform, CI installs with `npm ci --ignore-scripts`, and each package keeps only its own platform's binaries.

**App icon**: `build/icon.png` (1024×1024), drawn by `npm run icon` (`scripts/make-icon.js`). Replace the PNG to rebrand; electron-builder makes the Windows, macOS and Linux icons from it.

## Project structure

```
src/
  core/               plain Node: database, schema, business logic (unit-tested)
    migrations.js     schema + default admin user
    services/         ledger, report, categories, products, funds, purchases, users, auth, settings, i18n
    report-excel.js   styled Excel workbook for the Monthly Report
  main/               Electron main process, IPC (auth-guarded), preload bridge
  renderer/           UI (vanilla JS modules, CSS), pages/ for each screen
  i18n/               en.json, ko.json dictionaries
scripts/              start.js (launcher), seed.js (demo data), make-icon.js, after-pack.js (macOS ad-hoc signing)
build/                icon.png (build resources for electron-builder)
test/                 node:test suites
e2e/                  Playwright end-to-end run
.github/workflows/    ci.yml (tests), release.yml (build + publish on main)
```

Security notes:

- The renderer runs sandboxed with context isolation and no Node access.
- Every data call goes through the IPC bridge and requires a fully signed-in session.
- Navigation and new windows are blocked.

## Troubleshooting

- `TypeError: Cannot read properties of undefined (reading 'setPath')` means the shell has `ELECTRON_RUN_AS_NODE=1` set (VS Code's extension host sets it, for example). `npm start` clears it for you; if you run `electron .` directly, unset it first.
- `npm install` warns that better-sqlite3 has an install script that isn't allowed. That's intended (`allowScripts` in `package.json`): the prebuilt binaries are used, and nothing needs to be compiled.
