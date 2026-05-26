const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const { exec } = require('child_process');

// Start your existing index.js server automatically inside the desktop app
require('./index.js'); 

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        title: "Om Advertisement - Multi WhatsApp Gateway",
        icon: path.join(__dirname, 'public', 'favicon.ico'), // You can add an icon here
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        backgroundColor: '#020617' // Slate 950 matching your dashboard
    });

    // Load the local server
    mainWindow.loadURL('http://localhost:3000');

    // Remove Default Menu bar for premium look
    Menu.setApplicationMenu(null);

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

app.on('ready', () => {
    // Wait 1.5 seconds for express server to boot up safely, then open UI
    setTimeout(createWindow, 1500);
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', function () {
    if (mainWindow === null) {
        createWindow();
    }
});
```
eof

---

### 2. Updated Package Configuration (`package.json`)
Isme desktop app packaging config (`electron-builder` and `electron`) dependencies integrated hain.

```json:Package Configuration:package.json
{
  "name": "om-advertisement-whatsapp-gateway",
  "version": "2.0.0",
  "description": "Enterprise Multi-Instance Bulk WhatsApp Gateway Desktop",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build-exe": "electron-builder --windows"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.6.0",
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "multer": "^1.4.5-lts.1",
    "pino": "^9.1.0",
    "qrcode": "^1.5.3"
  },
  "devDependencies": {
    "electron": "^28.2.0",
    "electron-builder": "^24.9.1"
  },
  "build": {
    "appId": "com.omadvertisement.gateway",
    "productName": "Om_WhatsApp_Gateway",
    "directories": {
      "output": "dist"
    },
    "win": {
      "target": "portable"
    },
    "files": [
      "main.js",
      "index.js",
      "package.json",
      "public/**/*",
      "node_modules/**/*"
    ]
  },
  "author": "Om Advertisement",
  "license": "ISC"
}
```
eof

---

### Isko Desktop App (`.exe`) Kaise Banayein? (Step-by-Step Guide):

Aapko bas apne computer par ek baar setup karna hoga taaki `.exe` compile ho sake:

1. **Prerequisite:** Apne computer par [Node.js](https://nodejs.org/) (LTS Version) download karke install kar lijiye (agar pehle se nahi hai).
2. **Code Save Kariye:** Apne project folder ke andar upar diye gaye dono files (`main.js` aur `package.json`) ko save kar lijiye.
3. **Open Terminal/CMD:** Apne project folder ke andar Command Prompt (CMD) ya VS Code terminal ko open kijiye.
4. **Dependencies Install Kijiye:** CMD mein ye command run kijiye dependencies download karne ke liye:
   ```bash
   npm install
   ```
5. **Direct Run Test (Bina compile kiye run karne ke liye):**
   ```bash
   npm start
   ```
   *Ye automatically bina browser ke desktop window mein aapka gateway dashboard load kar dega!*

6. **Create `.exe` File (Executable):**
   Jab aapka app local system par bilkul sahi chalne lage, toh single port-free `.exe` file banane ke liye CMD mein ye command chalaein:
   ```bash
   npm run build-exe
   ```
   *Ye process complete hone ke baad, aapke project folder ke andar ek **`dist/`** naam ka folder ban jayega. Uske andar aapko **`Om_WhatsApp_Gateway.exe`** mil jayegi!*

Is portable `.exe` ko aap copy karke kisi bhi Windows computer ya RDP par direct double-click karke bina kisi tension ke lifetime free chala sakte hain! 

Bataiye bhai, kya aapko local system par step 4 aur step 5 ko test karne mein koi dikkat aa rahi hai?
