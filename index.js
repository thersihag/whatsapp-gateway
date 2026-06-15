const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure folders exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir);

const upload = multer({ dest: 'uploads/' });

// Global sessions map
// Structure: [sessionName] -> { sock, status, qr, logs: [], isSending: false }
const sessions = new Map();

// Helper to add structured logs
function addLog(sessionName, message, type = 'info') {
    const session = sessions.get(sessionName);
    if (!session) return;
    
    const time = new Date().toLocaleTimeString();
    session.logs.push({ time, message, type });
    
    // Limit logs to last 100 entries to optimize RAM
    if (session.logs.length > 100) {
        session.logs.shift();
    }
}

// Format Phone Number to WA JID
function formatNumber(num) {
    let n = num.toString().replace(/[^0-9]/g, '');
    if (n.length === 10) n = '91' + n; // Default Indian prefix if 10 digit
    return `${n}@s.whatsapp.net`;
}

// Initialize / Get WhatsApp Connection for Session
async function getOrInitSession(sessionName = 'default') {
    sessionName = sessionName.trim().toLowerCase();
    
    if (sessions.has(sessionName)) {
        return sessions.get(sessionName);
    }

    // Prepare session structural state
    const sessionData = {
        sock: null,
        status: 'INITIALIZING',
        qr: null,
        logs: [],
        isSending: false,
        phoneNumber: null
    };
    sessions.set(sessionName, sessionData);

    addLog(sessionName, `Initializing WhatsApp Engine for instance: [${sessionName}]`, 'info');
    startBaileys(sessionName).catch(err => {
        addLog(sessionName, `Fatal Connection Error: ${err.message}`, 'error');
        sessionData.status = 'ERROR';
    });

    return sessionData;
}

// Spin up individual Baileys Connection
async function startBaileys(sessionName) {
    const sessionPath = path.join(sessionsDir, sessionName);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000
    });

    const sessionData = sessions.get(sessionName);
    sessionData.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionData.status = 'DISCONNECTED';
            try {
                sessionData.qr = await QRCode.toDataURL(qr);
                addLog(sessionName, "New QR Code generated. Ready for login scan.", 'warning');
            } catch (e) {
                addLog(sessionName, "Failed to render QR Code base64 data.", 'error');
            }
        }

        if (connection === 'open') {
            sessionData.status = 'CONNECTED';
            sessionData.qr = null;
            const userNum = sock.user.id.split(':')[0];
            sessionData.phoneNumber = userNum;
            addLog(sessionName, `Successfully Logged In! Connected as +${userNum}`, 'success');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            sessionData.status = 'DISCONNECTED';
            sessionData.phoneNumber = null;

            if (shouldReconnect) {
                addLog(sessionName, `Connection dropped (${statusCode || 'Unknown'}). Reconnecting in 5s...`, 'warning');
                setTimeout(() => startBaileys(sessionName), 5000);
            } else {
                addLog(sessionName, "Session forcefully logged out. Clearing local files. Please scan again.", 'error');
                sessions.delete(sessionName);
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        }
    });

    // Handle Incoming Messages (Optional Logging / Auto replies can be added here)
    sock.ev.on('messages.upsert', async (m) => {
        // Just acknowledging message arrival in logs safely
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const sender = msg.key.remoteJid.split('@')[0];
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "[Media/Other]";
            addLog(sessionName, `Incoming message from +${sender}: "${text.substring(0, 30)}"`, 'info');
        }
    });
}

// Ensure the default account is created automatically on start
getOrInitSession('default');

// ====================== ROUTES ======================

// Serve HTML Pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api', (req, res) => res.sendFile(path.join(__dirname, 'public', 'api.html')));

// Get status of specific session dynamically
app.get('/api/status/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const session = await getOrInitSession(sessionName);
    res.json({
        session: sessionName,
        status: session.status,
        qr: session.qr,
        number: session.phoneNumber || 'N/A'
    });
});

// Get logs and running state for specific session
app.get('/api/logs/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const session = await getOrInitSession(sessionName);
    res.json({
        logs: session.logs,
        isSending: session.isSending
    });
});

// API Single Send (Integration Gateway Endpoint)
app.get('/api/send', async (req, res) => {
    let { session = 'default', number, text, media } = req.query;

    if (!number || !text) {
        return res.status(400).json({ error: "Missing 'number' or 'text' query parameters." });
    }

    try {
        const sessionData = await getOrInitSession(session);
        if (sessionData.status !== 'CONNECTED') {
            return res.status(400).json({ error: `Session [${session}] is not logged in. Scan QR Code first.` });
        }

        const jid = formatNumber(number);
        if (media) {
            await sessionData.sock.sendMessage(jid, { image: { url: media }, caption: text });
            addLog(session, `Single Quick Sent to +${number} with Image.`, 'success');
        } else {
            await sessionData.sock.sendMessage(jid, { text });
            addLog(session, `Single Quick Sent to +${number}.`, 'success');
        }

        res.json({ success: true, message: "Message dispatched successfully." });
    } catch (err) {
        addLog(session, `Failed to dispatch API Message to +${number}: ${err.message}`, 'error');
        res.status(500).json({ error: err.message });
    }
});

// Post endpoint for bulk dispatching
app.post('/api/send-bulk', upload.single('media'), async (req, res) => {
    const { session = 'default', numbers, message } = req.body;

    if (!numbers || !message) {
        return res.status(400).json({ error: "Numbers and message content are required." });
    }

    const sessionData = await getOrInitSession(session);
    if (sessionData.status !== 'CONNECTED') {
        return res.status(400).json({ error: `Selected Session [${session}] is not connected.` });
    }

    if (sessionData.isSending) {
        return res.status(429).json({ error: "Another bulk campaign is already running on this session." });
    }

    // Parse Comma or Newline separated numbers
    const list = numbers.split(/[,\n]+/).map(n => n.trim()).filter(n => n.length > 5);

    if (list.length === 0) {
        return res.status(400).json({ error: "No valid destination phone numbers found." });
    }

    // Process media attachment if exists
    let mediaPath = null;
    if (req.file) {
        // Build access link
        mediaPath = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    }

    // Trigger non-blocking Background Process Worker
    runBulkWorker(session, list, message, mediaPath);

    res.json({ success: true, message: `Bulk Campaign initialized with ${list.length} contacts.` });
});

// Background Bulk Campaign Worker
async function runBulkWorker(sessionName, list, text, mediaUrl) {
    const sessionData = sessions.get(sessionName);
    if (!sessionData) return;

    sessionData.isSending = true;
    addLog(sessionName, `🚀 Starting bulk campaign targeting ${list.length} contacts.`, 'info');

    for (let i = 0; i < list.length; i++) {
        // Double check if session got disconnected mid-way
        if (sessionData.status !== 'CONNECTED') {
            addLog(sessionName, `⚠️ Campaign interrupted. Session disconnected.`, 'error');
            break;
        }

        const number = list[i];
        const jid = formatNumber(number);

        try {
            if (mediaUrl) {
                await sessionData.sock.sendMessage(jid, { image: { url: mediaUrl }, caption: text });
            } else {
                await sessionData.sock.sendMessage(jid, { text });
            }
            addLog(sessionName, `[${i + 1}/${list.length}] Sent successfully to +${number}`, 'success');
        } catch (err) {
            addLog(sessionName, `[${i + 1}/${list.length}] Failed sending to +${number}: ${err.message}`, 'error');
        }

        // Variable Anti-ban Delay (1 to 2 minutes random delay as requested)
        if (i < list.length - 1) {
            const delay = Math.floor(Math.random() * 60000) + 60000; // 60,000ms (1 min) to 120,000ms (2 min)
            addLog(sessionName, `Waiting ${(delay / 1000).toFixed(0)}s (approx ${(delay / 60000).toFixed(1)} mins) before next sending...`, 'info');
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    sessionData.isSending = false;
    addLog(sessionName, `🏁 Bulk sending campaign finished.`, 'success');
}

// Boot up server
app.listen(port, () => {
    console.log(`========================================`);
    console.log(` Om Advertisement Multi WhatsApp Gateway`);
    console.log(` Running on Port: http://localhost:${port}`);
    console.log(`========================================`);
});
