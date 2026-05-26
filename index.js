const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Global Variables
let sock = null;
let qrCodeData = null;
let connectionStatus = 'DISCONNECTED';
let loggedInUser = null;
let systemLogs = [];
let isSending = false;

const sessionDir = path.join(__dirname, 'wa_session');

// Logger Function
function addLog(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    systemLogs.push({ time, message, type });
    if (systemLogs.length > 100) systemLogs.shift();
}

// Connect to WhatsApp
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 5000,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCodeData = await QRCode.toDataURL(qr);
                connectionStatus = 'DISCONNECTED';
                addLog("New QR Code Generated. Please scan to connect.", "info");
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = reason !== DisconnectReason.loggedOut;

                connectionStatus = 'DISCONNECTED';
                qrCodeData = null;
                loggedInUser = null;

                addLog(`Connection closed. Reason: ${reason || 'Unknown'}`, "error");

                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 5000);
                } else {
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
                    addLog("Session expired. Please login again.", "warn");
                }
            } else if (connection === 'open') {
                connectionStatus = 'CONNECTED';
                qrCodeData = null;
                loggedInUser = sock.user.id.split(':')[0];
                addLog(`✅ Successfully Connected as ${loggedInUser}`, "success");
            }
        });

    } catch (error) {
        addLog(`Engine Error: ${error.message}`, "error");
    }
}

// Format Phone Number
function formatNumber(rawNum) {
    let num = rawNum.toString().replace(/[^0-9]/g, '');
    if (num.length === 10) num = '91' + num;
    return num.length >= 10 ? `${num}@s.whatsapp.net` : null;
}

// Bulk Send (30 seconds delay)
async function processBulkSend(numbersList, message, mediaPath = null) {
    if (isSending) return;
    isSending = true;

    addLog("🚀 Bulk sending process started...", "success");

    for (let i = 0; i < numbersList.length; i++) {
        const jid = formatNumber(numbersList[i]);
        if (!jid) {
            addLog(`❌ Invalid number skipped: ${numbersList[i]}`, "error");
            continue;
        }

        try {
            if (mediaPath) {
                await sock.sendMessage(jid, {
                    image: { url: mediaPath },
                    caption: message
                });
            } else {
                await sock.sendMessage(jid, { text: message });
            }
            addLog(`✅ Message sent successfully to ${numbersList[i]}`, "success");
        } catch (err) {
            addLog(`❌ Failed to send to ${numbersList[i]}: ${err.message}`, "error");
        }

        if (i < numbersList.length - 1) {
            addLog(`⏳ Waiting 30 seconds before next message...`, "warn");
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }

    addLog("🎉 Bulk Campaign Completed Successfully!", "success");
    isSending = false;
}

// ======================== API ROUTES ========================

// Get Connection Status
app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        number: loggedInUser,
        qr: qrCodeData,
        isSending: isSending
    });
});

// Get Live Logs
app.get('/api/logs', (req, res) => {
    res.json({ logs: systemLogs, isSending });
});

// **Single Message Quick Send API**
app.get('/api/send', async (req, res) => {
    if (connectionStatus !== 'CONNECTED') {
        return res.status(400).json({ error: "WhatsApp is not connected" });
    }

    const { number, text, media } = req.query;
    if (!number || !text) {
        return res.status(400).json({ error: "Number and text are required" });
    }

    try {
        const jid = formatNumber(number);
        if (!jid) return res.status(400).json({ error: "Invalid phone number" });

        if (media) {
            await sock.sendMessage(jid, { image: { url: media }, caption: text });
        } else {
            await sock.sendMessage(jid, { text: text });
        }

        res.json({ success: true, message: "Message sent successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bulk Send with Media Upload Support
app.post('/api/send-bulk', upload.single('media'), (req, res) => {
    if (connectionStatus !== 'CONNECTED') return res.status(400).json({ error: "WhatsApp not connected" });
    if (isSending) return res.status(400).json({ error: "Another campaign is already running" });

    const { numbers, message } = req.body;
    const mediaFile = req.file;

    if (!numbers || !message) {
        return res.status(400).json({ error: "Numbers and message are required" });
    }

    const numbersList = numbers.split(',').map(n => n.trim()).filter(Boolean);

    const mediaPath = mediaFile ? path.join('uploads', mediaFile.filename) : null;

    processBulkSend(numbersList, message, mediaPath);

    res.json({ success: true, message: "Bulk sending started in background" });
});

// Logout
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        res.json({ success: true, message: "Logged out successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serve Uploaded Media Files
app.use('/uploads', express.static('uploads'));

// ======================== FRONTEND ========================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html')); // We will create this next
});

app.listen(port, () => {
    console.log(`🚀 Om Advertisement WhatsApp Gateway running on port ${port}`);
    connectToWhatsApp();
});
