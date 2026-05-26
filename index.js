const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

const upload = multer({ dest: 'uploads/' });

const sessions = new Map(); // Store multiple sockets

// Create sessions folder
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir);

// Helper to get session path
function getSessionPath(name) {
    return path.join(sessionsDir, name);
}

// Connect WhatsApp Account
async function connectWhatsApp(sessionName = 'default') {
    if (sessions.has(sessionName)) return sessions.get(sessionName);

    const sessionPath = getSessionPath(sessionName);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        keepAliveIntervalMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrData = await QRCode.toDataURL(qr);
            console.log(`[${sessionName}] QR Generated`);
            // You can store qrData if needed
        }

        if (connection === 'open') {
            console.log(`[${sessionName}] ✅ Connected as ${sock.user.id}`);
        }

        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
            setTimeout(() => connectWhatsApp(sessionName), 5000);
        }
    });

    sessions.set(sessionName, sock);
    return sock;
}

// Format Number
function formatNumber(num) {
    let n = num.toString().replace(/[^0-9]/g, '');
    if (n.length === 10) n = '91' + n;
    return `${n}@s.whatsapp.net`;
}

// ====================== ROUTES ======================

// Main Dashboard
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// **New API Dashboard**
app.get('/api', (req, res) => res.sendFile(path.join(__dirname, 'public', 'api.html')));

// Status of specific account
app.get('/api/status/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const sock = sessions.get(sessionName);
    res.json({ connected: !!sock && sock.user });
});

// **Single Send API** (Best for external apps)
app.get('/api/send', async (req, res) => {
    const { session = 'default', number, text, media } = req.query;

    if (!number || !text) return res.status(400).json({ error: "number and text required" });

    try {
        const sock = sessions.get(session) || await connectWhatsApp(session);
        const jid = formatNumber(number);

        if (media) {
            await sock.sendMessage(jid, { image: { url: media }, caption: text });
        } else {
            await sock.sendMessage(jid, { text });
        }

        res.json({ success: true, message: "Sent successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => {
    console.log(`Om Advertisement Multi WhatsApp Gateway Running on ${port}`);
    // Connect default account on start
    connectWhatsApp('default');
});
