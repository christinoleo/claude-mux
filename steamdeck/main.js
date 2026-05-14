const { app, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

const REMOTE_URL = 'https://ubuntu.taimen-pirarucu.ts.net:3456';

autoUpdater.logger = log;
log.transports.file.level = 'info';

function createWindow() {
	const win = new BrowserWindow({
		width: 1280,
		height: 800,
		title: 'claude-mux',
		autoHideMenuBar: true,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false
		}
	});
	win.loadURL(REMOTE_URL);
	return win;
}

app.whenReady().then(() => {
	createWindow();
	autoUpdater.checkForUpdatesAndNotify().catch((e) => log.error('updater', e));
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
