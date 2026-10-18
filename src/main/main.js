'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, Menu, dialog, shell, nativeTheme, screen } = require('electron');
const { openDatabase } = require('../core/db');
const { createServices } = require('../core/services');
const { formatLocalDate } = require('../core/dates');
const { buildReportWorkbook } = require('../core/report-excel');
const { registerIpc } = require('./ipc');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const INDEX_HTML = path.join(RENDERER_DIR, 'index.html');
const THEME_BACKGROUND = { dark: '#0b1120', light: '#f4f6f9' }; // matches --bg in app.css

// Data location: --data-dir=<path> or FUND_MANAGE_DATA_DIR override the default
// per-user folder (%APPDATA%/Fund Manager on Windows).
function resolveDataDir() {
  const arg = process.argv.find((a) => a.startsWith('--data-dir='));
  if (arg) return path.resolve(arg.slice('--data-dir='.length));
  if (process.env.FUND_MANAGE_DATA_DIR) return path.resolve(process.env.FUND_MANAGE_DATA_DIR);
  return null;
}

const customDataDir = resolveDataDir();
if (customDataDir) app.setPath('userData', customDataDir);
const dataDir = app.getPath('userData');
const dbFile = path.join(dataDir, 'fund-manage.db');

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

let mainWindow = null;
let services = null;

function t(key, params) {
  return services.i18n.t(services.settings.getAll().language, key, params);
}

async function backupDatabase() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: t('settings.data.backup'),
    defaultPath: path.join(app.getPath('documents'), `fund-manage-backup-${formatLocalDate(new Date())}.db`),
    filters: [{ name: 'SQLite', extensions: ['db', 'sqlite'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await services.db.backup(result.filePath);
  return { canceled: false, file: result.filePath };
}

let lastExportFile = null;

/** Monthly Report → styled .xlsx, written where the user chooses. */
async function exportReport(month) {
  const settings = services.settings.getAll();
  const lang = settings.language;
  const report = services.report.getMonthReport(month);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: t('report.export'),
    defaultPath: path.join(app.getPath('documents'), `${t('report.excel.fileName', { month })}.xlsx`),
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const workbook = buildReportWorkbook(report, {
    t: (key, params) => services.i18n.t(lang, key, params),
    lang,
    locale: lang === 'ko' ? 'ko-KR' : 'en-US',
    currency: settings.currency,
    decimals: settings.currencyDecimals,
    generatedAt: new Date(),
    appName: t('app.title'),
  });
  await workbook.xlsx.writeFile(result.filePath);
  lastExportFile = result.filePath;
  return { canceled: false, file: result.filePath };
}

/** Opens only the file this app just exported (never a renderer-supplied path). */
async function openLastExport() {
  if (!lastExportFile) return { opened: false };
  const error = await shell.openPath(lastExportFile);
  return { opened: !error, error: error || null };
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: t('menu.file'),
      submenu: [
        { label: t('settings.data.backup'), click: () => backupDatabase().catch((e) => console.error(e)) },
        { label: t('settings.data.openFolder'), click: () => shell.openPath(dataDir) },
        { type: 'separator' },
        isMac ? { role: 'close', label: t('menu.close') } : { role: 'quit', label: t('menu.quit') },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload', label: t('menu.reload') },
        { role: 'toggleDevTools', label: t('menu.devTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.resetZoom') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Native controls (scrollbars, date pickers, dialogs) and the window background follow the theme. */
function applyTheme(theme) {
  nativeTheme.themeSource = theme;
  if (mainWindow) mainWindow.setBackgroundColor(THEME_BACKGROUND[theme]);
}

function createWindow() {
  const { theme } = services.settings.getAll();
  applyTheme(theme);
  const work = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1440, work.width),
    height: Math.min(900, work.height),
    minWidth: Math.min(1240, work.width),
    minHeight: Math.min(640, work.height),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: THEME_BACKGROUND[theme],
    title: 'Fund Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // The UI is a local single page app: block navigation and new windows.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  // The renderer vetoes unload while purchase items are unsaved; ask the user.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: [t('items.discard'), t('common.cancel')],
      defaultId: 1,
      cancelId: 1,
      title: t('items.unsavedTitle'),
      message: t('items.unsavedTitle'),
      detail: t('items.unsavedMessage'),
    });
    if (choice === 0) event.preventDefault(); // proceed with closing / reloading
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // The theme is passed along so the page can apply it before its first paint.
  mainWindow.loadFile(INDEX_HTML, { query: { theme } });
}

function samePath(a, b) {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Only our own index.html may call the IPC API. */
function isTrustedSender(event) {
  const url = event.senderFrame && event.senderFrame.url;
  if (!url || !url.startsWith('file:')) return false;
  try {
    const file = decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    return samePath(file, INDEX_HTML);
  } catch {
    return false;
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  if (!hasInstanceLock) return;
  const db = openDatabase(dbFile);
  services = createServices(db);
  services.settings.ensureDefaults({ locale: app.getLocale() });

  registerIpc(ipcMain, {
    services,
    isTrustedSender,
    actions: {
      appInfo: () => ({
        version: app.getVersion(),
        electron: process.versions.electron,
        platform: process.platform,
        dataDir,
        dbFile,
      }),
      languageChanged: () => buildMenu(),
      themeChanged: (theme) => applyTheme(theme),
      backupDatabase,
      exportReport,
      openLastExport,
      openDataFolder: () => shell.openPath(dataDir).then((err) => ({ error: err || null })),
    },
  });

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (services) services.db.close();
});
