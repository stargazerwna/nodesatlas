import { app, BrowserWindow, Menu, dialog, shell, Notification, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const iconPath = path.join(rootDir, 'build', 'icon.png');
const HOMEPAGE = 'https://wna.gr/nodeatlas';
const COPYRIGHT = 'Copyright \u00A9 2026 Leonidas Papadopoulos - leonidas@wna.gr';
const APP_USER_MODEL_ID = 'com.netmonitor.nodeatlas';
// The desktop app defaults to its own port so it can run alongside the web app (which stays on 3001).
const API_PORT = Number(process.env.NODEATLAS_PORT || 3030);
process.env.PORT = String(API_PORT);

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let mainWindow;
let backendStarted = false;

function showFatalError(title, error) {
  console.error(title, error);
  dialog.showErrorBox(title, error?.message || String(error));
}

process.on('uncaughtException', (error) => {
  showFatalError('NodeAtlas encountered an unexpected error', error);
  app.quit();
});

process.on('unhandledRejection', (error) => {
  showFatalError('NodeAtlas encountered an unexpected error', error);
  app.quit();
});

function showAboutDialog() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About nodesAtlas',
    message: 'nodesAtlas',
    detail: `Version ${app.getVersion()}\n${COPYRIGHT}\n${HOMEPAGE}`,
    buttons: ['OK'],
  });
}

function showDeviceDownNotification(_event, device = {}) {
  if (!Notification.isSupported()) return false;

  const name = typeof device.name === 'string' && device.name.trim() ? device.name.trim() : 'Device';
  const ip = typeof device.ip === 'string' && device.ip.trim() ? device.ip.trim() : '';
  const notification = new Notification({
    title: `${name} is offline`,
    body: ip ? `${ip} stopped responding to SNMP.` : 'The device stopped responding to SNMP.',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
  });

  notification.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  notification.show();
  return true;
}

ipcMain.handle('nodeatlas:device-down-notification', showDeviceDownNotification);

function buildMenu() {
  app.setAboutPanelOptions({
    applicationName: 'nodesAtlas',
    applicationVersion: app.getVersion(),
    copyright: COPYRIGHT,
    website: HOMEPAGE,
  });

  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [{ label: 'About nodesAtlas', click: showAboutDialog }, { type: 'separator' }, { role: 'quit' }],
    }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Visit nodeatlas.wna.gr', click: () => shell.openExternal(HOMEPAGE) },
        { type: 'separator' },
        { label: 'About nodesAtlas', click: showAboutDialog },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function startBackend() {
  if (backendStarted) return;
  backendStarted = true;

  // app.asar is read-only, so packaged builds must keep their editable config outside it.
  // Portable copies store data next to their own exe (via electron-builder's
  // PORTABLE_EXECUTABLE_DIR) so each copy stays independent; installed builds fall back
  // to the per-user profile since there is no portable folder to use.
  if (app.isPackaged) {
    const dataDir = process.env.PORTABLE_EXECUTABLE_DIR
      ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
      : app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.NODES_CONFIG ||= path.join(dataDir, 'nodes.local.json');
    process.env.LINKS_CONFIG ||= path.join(dataDir, 'links.local.json');
    process.env.WORKSPACE_CONFIG ||= path.join(dataDir, 'workspace.local.json');
  }

  const serverPath = path.join(rootDir, 'server.js');

  try {
    await import(pathToFileURL(serverPath).href);
  } catch (error) {
    showFatalError('NodeAtlas could not start its monitoring service', error.code === 'EADDRINUSE'
      ? new Error(`Port ${API_PORT} is already in use. Close any other running copy of NodeAtlas and try again.`)
      : error);
    app.quit();
    throw error;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1200,
    minHeight: 780,
    title: 'nodesAtlas',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (errorCode === -3) return; // Ignore aborted loads caused by normal navigation.
    showFatalError('NodeAtlas failed to load its interface', new Error(`${errorDescription} (${errorCode})`));
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://github.com/stargazerwna/nodesatlas/releases/tag/')) {
      shell.openExternal(url).catch((error) => console.error('Could not open release page:', error));
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('unresponsive', () => {
    dialog.showMessageBox(mainWindow, { type: 'warning', title: 'NodeAtlas', message: 'NodeAtlas is not responding.' });
  });

  const indexPath = path.join(rootDir, 'dist', 'index.html');

  if (fs.existsSync(indexPath)) {
    mainWindow.loadFile(indexPath, { query: { apiPort: String(API_PORT) } });
    return;
  }

  mainWindow.loadURL(`http://127.0.0.1:5173?apiPort=${API_PORT}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  buildMenu();
  try {
    await startBackend();
  } catch {
    return; // startBackend already reported the error and is quitting the app.
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  showFatalError('NodeAtlas failed to start', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
