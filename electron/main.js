const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

// In production, serve from dist/. In dev, connect to Vite dev server.
const isDev = process.env.ELECTRON_DEV === "true";

function createWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 860,
    minWidth: 380,
    minHeight: 600,
    title: "Twatter",
    backgroundColor: "#0a0a0a",
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Open external links in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  return win;
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
