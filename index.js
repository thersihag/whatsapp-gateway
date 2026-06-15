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

// Middleware configuration
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure target file directories exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir);

const upload = multer({ dest: 'uploads/' });

// In-Memory Global Session Registry
// Mapping: sessionName (string) -> { sock, status, qr, logs: [], isSending: boolean, phoneNumber: string|null }
const sessions = new Map();

/**
 * Registers structured transaction logs into session memory.
 * Limits memory usage by keeping only the last 100 log entries.
 */
function addLog(sessionName, message, type = 'info') {
    const session = sessions.get(sessionName);
    if (!session) return;
    
    const time = new Date().toLocaleTimeString();
    session.logs.push({ time, message, type });
    
    if (session.logs.length > 100) {
        session.logs.shift();
    }
}

/**
 * Formats a given string into a valid WhatsApp JID format.
 */
function formatNumber(num) {
    let n = num.toString().replace(/[^0-9]/g, '');
    if (n.length === 10) n = '91' + n; // Default Indian Country Code Prefix if 10-digit
    return `${n}@s.whatsapp.net`;
}

/**
 * Retrieves an active session or initializes a new one.
 */
async function getOrInitSession(sessionName = 'default') {
    sessionName = sessionName.trim().toLowerCase();
    
    if (sessions.has(sessionName)) {
        return sessions.get(sessionName);
    }

    const sessionData = {
        sock: null,
        status: 'INITIALIZING',
        qr: null,
        logs: [],
        isSending: false,
        phoneNumber: null
    };
    sessions.set(sessionName, sessionData);

    addLog(sessionName, `Initializing WhatsApp Engine connection for instance: [${sessionName}]`, 'info');
    startBaileys(sessionName).catch(err => {
        addLog(sessionName, `Fatal connection initialization error: ${err.message}`, 'error');
        sessionData.status = 'ERROR';
    });

    return sessionData;
}

/**
 * Establishes authentication states and sets up Baileys event listeners.
 */
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
                addLog(sessionName, "New authentication QR Code generated. Awaiting device scan.", 'warning');
            } catch (e) {
                addLog(sessionName, "Failed to render QR Code to DataURL format.", 'error');
            }
        }

        if (connection === 'open') {
            sessionData.status = 'CONNECTED';
            sessionData.qr = null;
            const userNum = sock.user.id.split(':')[0];
            sessionData.phoneNumber = userNum;
            addLog(sessionName, `Successful authentication! Active session connected as +${userNum}`, 'success');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            sessionData.status = 'DISCONNECTED';
            sessionData.phoneNumber = null;

            if (shouldReconnect) {
                addLog(sessionName, `Session disconnected (${statusCode || 'Unknown Code'}). Reconnecting in 5 seconds...`, 'warning');
                setTimeout(() => startBaileys(sessionName), 5000);
            } else {
                addLog(sessionName, "Log out request completed. Cleaning local session storage files.", 'error');
                sessions.delete(sessionName);
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const sender = msg.key.remoteJid.split('@')[0];
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "[Media Attachment]";
            addLog(sessionName, `Message received from +${sender}: "${text.substring(0, 45)}"`, 'info');
        }
    });
}

// Automatically initiate default session on start
getOrInitSession('default');

// ====================== CONTROLLERS & ENDPOINTS ======================

// Helper redirect API endpoint
app.get('/api/redirect/:sessionName', (req, res) => {
    const { sessionName } = req.params;
    const targetSession = sessionName ? encodeURIComponent(sessionName.trim().toLowerCase()) : 'default';
    res.redirect(`http://omadvertisements.in/whatsapp-number.php?=session_id=${targetSession}`);
});

// Dynamic Status Endpoint
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

// Log and State Endpoint
app.get('/api/logs/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const session = await getOrInitSession(sessionName);
    res.json({
        logs: session.logs,
        isSending: session.isSending
    });
});

// API Single Direct Message Dispatch
app.get('/api/send', async (req, res) => {
    let { session = 'default', number, text, media } = req.query;

    if (!number || !text) {
        return res.status(400).json({ error: "Missing required 'number' or 'text' query variables." });
    }

    try {
        const sessionData = await getOrInitSession(session);
        if (sessionData.status !== 'CONNECTED') {
            return res.status(400).json({ error: `Instance session [${session}] is offline. Authenticate with QR code first.` });
        }

        const jid = formatNumber(number);
        if (media) {
            await sessionData.sock.sendMessage(jid, { image: { url: media }, caption: text });
            addLog(session, `Single message containing media dispatched to +${number}.`, 'success');
        } else {
            await sessionData.sock.sendMessage(jid, { text });
            addLog(session, `Single text message dispatched to +${number}.`, 'success');
        }

        res.json({ success: true, message: "Payload successfully dispatched to WhatsApp engine queue." });
    } catch (err) {
        addLog(session, `Transmission to +${number} failed: ${err.message}`, 'error');
        res.status(500).json({ error: err.message });
    }
});

// Campaign Bulk Message Endpoint
app.post('/api/send-bulk', upload.single('media'), async (req, res) => {
    const { session = 'default', numbers, message } = req.body;

    if (!numbers || !message) {
        return res.status(400).json({ error: "Parameters 'numbers' and 'message' are mandatory." });
    }

    const sessionData = await getOrInitSession(session);
    if (sessionData.status !== 'CONNECTED') {
        return res.status(400).json({ error: `Selected instance [${session}] is currently offline.` });
    }

    if (sessionData.isSending) {
        return res.status(429).json({ error: "Another campaign is currently executing on this instance." });
    }

    const list = numbers.split(/[,\n]+/).map(n => n.trim()).filter(n => n.length > 5);
    if (list.length === 0) {
        return res.status(400).json({ error: "No valid destination phone numbers found within inputs." });
    }

    let mediaPath = null;
    if (req.file) {
        mediaPath = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    }

    // Trigger non-blocking worker thread
    runBulkWorker(session, list, message, mediaPath);

    res.json({ success: true, message: `Bulk dispatch campaign configured successfully. Target count: ${list.length}` });
});

// Non-blocking Campaign Engine Loop
async function runBulkWorker(sessionName, list, text, mediaUrl) {
    const sessionData = sessions.get(sessionName);
    if (!sessionData) return;

    sessionData.isSending = true;
    addLog(sessionName, `🚀 Starting outbound WhatsApp bulk dispatch targetting ${list.length} destinations.`, 'info');

    for (let i = 0; i < list.length; i++) {
        if (sessionData.status !== 'CONNECTED') {
            addLog(sessionName, `⚠️ Transmission sequence aborted. Session went offline midway.`, 'error');
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
            addLog(sessionName, `[Progress: ${i + 1}/${list.length}] Successfully transmitted to +${number}`, 'success');
        } catch (err) {
            addLog(sessionName, `[Progress: ${i + 1}/${list.length}] Transmission failed for +${number}: ${err.message}`, 'error');
        }

        // Standard dynamic anti-ban execution pauses (4 to 8 seconds variance)
        if (i < list.length - 1) {
            const delay = Math.floor(Math.random() * 4000) + 4000;
            addLog(sessionName, `Anti-ban protection active. Pausing for ${delay / 1000}s before next transmission...`, 'info');
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    sessionData.isSending = false;
    addLog(sessionName, `🏁 Bulk dispatch campaign completed processing.`, 'success');
}

// Inline Dynamic Frontend Dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard - Om Advertisement Gateway</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #f1f1f1; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
    </style>
</head>
<body class="bg-slate-50 text-slate-800 flex flex-col min-h-screen font-sans">

    <!-- Responsive Global Navbar -->
    <nav class="bg-indigo-900 text-white shadow-lg sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex items-center justify-between h-16">
                <!-- Branding -->
                <div class="flex items-center space-x-3">
                    <div class="bg-emerald-500 p-2 rounded-lg text-white">
                        <i class="fa-brands fa-whatsapp text-2xl"></i>
                    </div>
                    <div>
                        <span class="font-extrabold text-xl tracking-tight block">Om Advertisement</span>
                        <span class="text-xs text-indigo-200 block -mt-1">Multi WhatsApp Gateway</span>
                    </div>
                </div>

                <!-- Navigation Options -->
                <div class="hidden md:flex items-center space-x-6">
                    <a href="/" class="hover:text-emerald-400 font-medium transition flex items-center space-x-2">
                        <i class="fa-solid fa-gauge"></i> <span>Dashboard</span>
                    </a>
                    <a href="/api" class="hover:text-emerald-400 text-slate-300 font-medium transition flex items-center space-x-2">
                        <i class="fa-solid fa-code"></i> <span>API Docs</span>
                    </a>
                    <!-- New Requested Navbar Option with dynamic query selection -->
                    <a id="navbar-portal-link" href="http://omadvertisements.in/whatsapp-number.php?=session_id=default" target="_blank" class="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-md font-semibold transition shadow-md flex items-center space-x-2">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i>
                        <span>WhatsApp Portal</span>
                    </a>
                </div>

                <!-- Mobile Menu Button -->
                <div class="md:hidden">
                    <button id="mobile-menu-btn" class="text-indigo-200 hover:text-white focus:outline-none">
                        <i class="fa-solid fa-bars text-2xl"></i>
                    </button>
                </div>
            </div>
        </div>

        <!-- Mobile Drawer -->
        <div id="mobile-menu" class="hidden md:hidden bg-indigo-950 px-4 pt-2 pb-4 space-y-2">
            <a href="/" class="block hover:bg-indigo-800 text-white px-3 py-2 rounded transition">
                <i class="fa-solid fa-gauge mr-2"></i> Dashboard
            </a>
            <a href="/api" class="block hover:bg-indigo-800 text-slate-300 px-3 py-2 rounded transition">
                <i class="fa-solid fa-code mr-2"></i> API Docs
            </a>
            <a id="mobile-portal-link" href="http://omadvertisements.in/whatsapp-number.php?=session_id=default" target="_blank" class="block bg-emerald-600 text-center text-white px-3 py-2 rounded-md font-semibold transition">
                <i class="fa-solid fa-arrow-up-right-from-square mr-2"></i> WhatsApp Portal
            </a>
        </div>
    </nav>

    <!-- Main Content Grid -->
    <main class="flex-grow max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        <!-- Left Column: Session Controls & QR Authentication -->
        <div class="space-y-6 lg:col-span-1">
            <!-- Active Session Selector Card -->
            <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <h2 class="text-lg font-bold text-slate-900 mb-4 flex items-center space-x-2">
                    <i class="fa-solid fa-network-wired text-indigo-600"></i>
                    <span>Select Instance Session</span>
                </h2>
                <div class="flex space-x-2">
                    <input type="text" id="session-input" value="default" placeholder="session-name" class="flex-grow bg-slate-100 border border-slate-300 rounded-lg px-4 py-2 text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-sm" />
                    <button onclick="changeSession()" class="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-4 py-2 rounded-lg transition shadow">
                        Load
                    </button>
                </div>
                <p class="text-xs text-slate-500 mt-2">Manage multiple parallel instances securely in isolation.</p>
            </div>

            <!-- Device Connection Status Card -->
            <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col items-center justify-center text-center">
                <h2 class="text-lg font-bold text-slate-900 mb-4 self-start flex items-center space-x-2 w-full">
                    <i class="fa-solid fa-signal text-indigo-600"></i>
                    <span>Device Connection</span>
                </h2>

                <div id="status-badge" class="px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider mb-6 bg-slate-100 text-slate-500">
                    Unknown
                </div>

                <!-- Session QR Frame & Placeholders -->
                <div class="relative w-56 h-56 border-2 border-slate-200 rounded-lg bg-slate-50 flex items-center justify-center overflow-hidden mb-4">
                    <div id="qr-loading" class="absolute inset-0 flex flex-col items-center justify-center bg-white/90 z-10 transition">
                        <i class="fa-solid fa-circle-notch fa-spin text-4xl text-indigo-600 mb-2"></i>
                        <span class="text-xs text-slate-600 font-semibold">Contacting Instance...</span>
                    </div>
                    <img id="qr-image" class="w-full h-full hidden p-2 object-contain" alt="Scan WhatsApp Creds" />
                    <div id="qr-connected" class="hidden flex-col items-center justify-center text-emerald-600 p-4">
                        <i class="fa-solid fa-circle-check text-5xl mb-3"></i>
                        <span class="font-bold text-sm text-slate-800">Connection Open</span>
                        <span id="connected-number" class="text-xs text-slate-500 mt-1">Number: N/A</span>
                    </div>
                    <div id="qr-error" class="hidden flex-col items-center justify-center text-red-500 p-4">
                        <i class="fa-solid fa-triangle-exclamation text-5xl mb-3"></i>
                        <span class="font-bold text-sm text-slate-800 text-center">Error Loading Session</span>
                    </div>
                </div>

                <p id="instruction-text" class="text-xs text-slate-500 text-center leading-relaxed">
                    Connecting to engine...
                </p>
            </div>
        </div>

        <!-- Right Column: Campaign Manager, Quick Send, & Server Logs -->
        <div class="space-y-6 lg:col-span-2">
            <!-- Outbound Campaign Console Tabs -->
            <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div class="flex border-b border-slate-200">
                    <button onclick="switchTab('bulk')" id="tab-bulk" class="flex-1 py-3 px-4 font-bold text-sm text-center border-b-2 border-indigo-600 text-indigo-600 focus:outline-none flex items-center justify-center space-x-2">
                        <i class="fa-solid fa-mail-bulk"></i> <span>Bulk Broadcaster</span>
                    </button>
                    <button onclick="switchTab('single')" id="tab-single" class="flex-1 py-3 px-4 font-bold text-sm text-center border-b-2 border-transparent text-slate-500 hover:text-slate-800 focus:outline-none flex items-center justify-center space-x-2">
                        <i class="fa-solid fa-paper-plane"></i> <span>Quick Sender</span>
                    </button>
                </div>

                <!-- Tab: Bulk Broadcaster -->
                <div id="view-bulk" class="p-6 space-y-4">
                    <form id="bulk-form" onsubmit="handleBulkSubmit(event)" class="space-y-4">
                        <div>
                            <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Target Phone Numbers</label>
                            <textarea name="numbers" required placeholder="919988776655, 917766554433&#10;Or insert one phone number per line..." rows="4" class="w-full bg-slate-50 border border-slate-300 rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"></textarea>
                            <span class="text-[10px] text-slate-400 block mt-1">Country code included, commas or new-line delimiters supported.</span>
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Message Outbox Content</label>
                                <textarea name="message" required placeholder="Write your advertising payload details here..." rows="4" class="w-full bg-slate-50 border border-slate-300 rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"></textarea>
                            </div>
                            <div>
                                <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Image Attachment (Optional)</label>
                                <div class="border-2 border-dashed border-slate-300 rounded-lg h-28 flex flex-col items-center justify-center bg-slate-50 hover:bg-slate-100 transition relative overflow-hidden">
                                    <input type="file" name="media" accept="image/*" class="absolute inset-0 opacity-0 cursor-pointer" onchange="previewImage(this)" />
                                    <div id="file-placeholder" class="text-center p-2 pointer-events-none">
                                        <i class="fa-regular fa-image text-2xl text-slate-400 mb-1"></i>
                                        <span class="text-xs text-slate-500 block">Click or Drop Image</span>
                                    </div>
                                    <img id="image-thumb" class="absolute inset-0 w-full h-full object-cover hidden" />
                                </div>
                                <div class="text-[10px] text-slate-400 mt-1 flex justify-between">
                                    <span>Supports PNG/JPG/JPEG formats.</span>
                                    <button type="button" onclick="clearMediaFile()" class="text-red-500 font-semibold hover:underline hidden" id="clear-media-btn">Remove</button>
                                </div>
                            </div>
                        </div>

                        <div class="flex items-center justify-between pt-2 border-t border-slate-100">
                            <span class="text-xs text-amber-600 font-semibold flex items-center space-x-1">
                                <i class="fa-solid fa-shield-halved"></i>
                                <span>Anti-Ban: 4-8s safe throttle applied automatically.</span>
                            </span>
                            <button type="submit" id="bulk-submit" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 py-2 rounded-lg transition shadow flex items-center space-x-2">
                                <i class="fa-solid fa-bolt"></i>
                                <span>Dispatch Campaign</span>
                            </button>
                        </div>
                    </form>
                </div>

                <!-- Tab: Quick Sender -->
                <div id="view-single" class="p-6 space-y-4 hidden">
                    <form id="single-form" onsubmit="handleSingleSubmit(event)" class="space-y-4">
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div class="md:col-span-1">
                                <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Target Number</label>
                                <input type="text" name="number" required placeholder="e.g. 919988776655" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                            </div>
                            <div class="md:col-span-2">
                                <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Optional Image Url</label>
                                <input type="url" name="media" placeholder="https://example.com/image.jpg" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                            </div>
                        </div>
                        <div>
                            <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Message Body</label>
                            <textarea name="text" required placeholder="Write simple text message here..." rows="3" class="w-full bg-slate-50 border border-slate-300 rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"></textarea>
                        </div>

                        <div class="flex justify-end pt-2 border-t border-slate-100">
                            <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 py-2 rounded-lg transition shadow flex items-center space-x-2">
                                <i class="fa-solid fa-paper-plane"></i>
                                <span>Send Single Quick</span>
                            </button>
                        </div>
                    </form>
                </div>
            </div>

            <!-- Server Transaction Live Logger -->
            <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col h-80">
                <div class="flex justify-between items-center mb-4">
                    <h2 class="text-lg font-bold text-slate-900 flex items-center space-x-2">
                        <i class="fa-solid fa-terminal text-indigo-600"></i>
                        <span>Instance Engine Logs</span>
                    </h2>
                    <span class="text-xs bg-slate-100 text-slate-600 px-3 py-1 rounded-full font-mono tracking-wider">
                        Live Tracking
                    </span>
                </div>
                <!-- Log List -->
                <div id="logs-container" class="bg-slate-900 text-slate-200 flex-grow rounded-lg p-4 font-mono text-xs overflow-y-auto space-y-1.5 border border-slate-800">
                    <div class="text-slate-500">// Terminal connection initialized. Waiting for log updates...</div>
                </div>
            </div>
        </div>
    </main>

    <!-- Global Toast Alert Portal -->
    <div id="toast" class="fixed bottom-5 right-5 z-50 transform translate-y-10 opacity-0 transition duration-300 bg-slate-900 text-white px-5 py-3 rounded-lg shadow-xl flex items-center space-x-2 text-sm border border-slate-700">
        <i id="toast-icon" class="fa-solid fa-circle-info"></i>
        <span id="toast-message">Operation Completed</span>
    </div>

    <!-- JS Client Logics -->
    <script>
        let activeSession = 'default';
        let currentTab = 'bulk';
        let statusPollInterval;
        let logsPollInterval;

        // Mobile drawer toggles
        document.getElementById('mobile-menu-btn').addEventListener('click', () => {
            const menu = document.getElementById('mobile-menu');
            menu.classList.toggle('hidden');
        });

        // Trigger session swaps
        function changeSession() {
            const input = document.getElementById('session-input').value.trim().toLowerCase();
            if(!input) return showToast('Please write a valid session label.', 'error');
            
            activeSession = input;
            
            // Rewrite Dynamic Redirect Navbars URL targeting the session input
            const redirectUrl = \`http://omadvertisements.in/whatsapp-number.php?=session_id=\${encodeURIComponent(activeSession)}\`;
            document.getElementById('navbar-portal-link').setAttribute('href', redirectUrl);
            document.getElementById('mobile-portal-link').setAttribute('href', redirectUrl);
            
            showToast(\`Initiating view swap to session: "\${activeSession}"\`, 'success');
            refreshState();
        }

        // Tab switches
        function switchTab(tab) {
            currentTab = tab;
            document.getElementById('tab-bulk').className = tab === 'bulk' ? 'flex-1 py-3 px-4 font-bold text-sm text-center border-b-2 border-indigo-600 text-indigo-600 focus:outline-none flex items-center justify-center space-x-2' : 'flex-1 py-3 px-4 font-bold text-sm text-center border-b-2 border-transparent text-slate-500 hover:text-slate-800 focus:outline-none flex items-center justify-center space-x-2';
            document.getElementById('tab-single').className = tab === 'single' ? 'flex-1 py-3 px-4 font-bold text-sm text-center border-b-2 border-indigo-600 text-indigo-600 focus:outline-none flex items-center justify-center space-x-2' : 'flex-1 py-3 px-4 font-bold text-sm text-center border-b-2 border-transparent text-slate-500 hover:text-slate-800 focus:outline-none flex items-center justify-center space-x-2';
            
            document.getElementById('view-bulk').style.display = tab === 'bulk' ? 'block' : 'none';
            document.getElementById('view-single').style.display = tab === 'single' ? 'block' : 'none';
        }

        // File picker thumbnails
        function previewImage(input) {
            const thumb = document.getElementById('image-thumb');
            const placeholder = document.getElementById('file-placeholder');
            const clearBtn = document.getElementById('clear-media-btn');
            
            if (input.files && input.files[0]) {
                const reader = new FileReader();
                reader.onload = function(e) {
                    thumb.src = e.target.result;
                    thumb.classList.remove('hidden');
                    placeholder.classList.add('hidden');
                    clearBtn.classList.remove('hidden');
                }
                reader.readAsDataURL(input.files[0]);
            }
        }

        function clearMediaFile() {
            const input = document.querySelector('input[name="media"]');
            const thumb = document.getElementById('image-thumb');
            const placeholder = document.getElementById('file-placeholder');
            const clearBtn = document.getElementById('clear-media-btn');
            
            input.value = '';
            thumb.classList.add('hidden');
            placeholder.classList.remove('hidden');
            clearBtn.classList.add('hidden');
        }

        // Fetching statuses
        async function fetchStatus() {
            const qrLoading = document.getElementById('qr-loading');
            const qrImg = document.getElementById('qr-image');
            const qrConnected = document.getElementById('qr-connected');
            const qrError = document.getElementById('qr-error');
            const badge = document.getElementById('status-badge');
            const instructions = document.getElementById('instruction-text');

            try {
                const response = await fetch(\`/api/status/\${activeSession}\`);
                const data = await response.json();

                badge.className = 'px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider mb-6 ';
                if(data.status === 'CONNECTED') {
                    badge.className += 'bg-emerald-100 text-emerald-800';
                    badge.innerText = 'Connected';
                    qrLoading.classList.add('hidden');
                    qrImg.classList.add('hidden');
                    qrError.classList.add('hidden');
                    qrConnected.classList.remove('hidden');
                    document.getElementById('connected-number').innerText = 'Number: +' + data.number;
                    instructions.innerText = 'Device successfully authorized. Gateway is listening for campaign commands.';
                } else if (data.status === 'DISCONNECTED') {
                    badge.className += 'bg-amber-100 text-amber-800';
                    badge.innerText = 'Scan QR';
                    qrConnected.classList.add('hidden');
                    qrError.classList.add('hidden');
                    
                    if (data.qr) {
                        qrImg.src = data.qr;
                        qrImg.classList.remove('hidden');
                        qrLoading.classList.add('hidden');
                        instructions.innerText = 'Open WhatsApp on your mobile client, select Linked Devices > Link a Device, and scan this code.';
                    } else {
                        qrImg.classList.add('hidden');
                        qrLoading.classList.remove('hidden');
                        instructions.innerText = 'Generating new engine session credentials. Standby...';
                    }
                } else {
                    badge.className += 'bg-rose-100 text-rose-800';
                    badge.innerText = data.status || 'ERROR';
                    qrConnected.classList.add('hidden');
                    qrImg.classList.add('hidden');
                    qrLoading.classList.add('hidden');
                    qrError.classList.remove('hidden');
                    instructions.innerText = 'An execution error has halted this session. Validate node terminal outputs.';
                }
            } catch(e) {
                badge.className = 'px-4 py-1.5 rounded-full text-xs font-bold uppercase bg-rose-100 text-rose-800 mb-6';
                badge.innerText = 'DISCONNECTED';
                qrConnected.classList.add('hidden');
                qrImg.classList.add('hidden');
                qrLoading.classList.add('hidden');
                qrError.classList.remove('hidden');
                instructions.innerText = 'Failed to locate backend connection services. Ensure Server is running.';
            }
        }

        // Fetching live execution logs
        async function fetchLogs() {
            try {
                const response = await fetch(\`/api/logs/\${activeSession}\`);
                const data = await response.json();
                
                const container = document.getElementById('logs-container');
                
                // Track campaign button locks
                const submitBtn = document.getElementById('bulk-submit');
                if (data.isSending) {
                    submitBtn.disabled = true;
                    submitBtn.className = 'bg-slate-400 text-white font-bold px-6 py-2 rounded-lg cursor-not-allowed flex items-center space-x-2';
                    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Sending Campaign...</span>';
                } else {
                    submitBtn.disabled = false;
                    submitBtn.className = 'bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 py-2 rounded-lg transition shadow flex items-center space-x-2';
                    submitBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> <span>Dispatch Campaign</span>';
                }

                if (!data.logs || data.logs.length === 0) {
                    container.innerHTML = '<div class="text-slate-500">// Awaiting transaction logs...</div>';
                    return;
                }

                let html = '';
                data.logs.forEach(log => {
                    let color = 'text-slate-300';
                    if (log.type === 'success') color = 'text-emerald-400';
                    if (log.type === 'warning') color = 'text-amber-400';
                    if (log.type === 'error') color = 'text-rose-400';
                    
                    html += \`<div class="\${color}"><span class="text-slate-500">[\${log.time}]</span> \${log.message}</div>\`;
                });

                const atBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 40;
                container.innerHTML = html;
                
                if (atBottom) {
                    container.scrollTop = container.scrollHeight;
                }
            } catch(e) {}
        }

        // Bulk Form execution submits
        async function handleBulkSubmit(e) {
            e.preventDefault();
            const form = document.getElementById('bulk-form');
            const formData = new FormData(form);
            formData.append('session', activeSession);

            showToast('Submitting campaign variables...', 'info');

            try {
                const response = await fetch('/api/send-bulk', {
                    method: 'POST',
                    body: formData
                });
                const result = await response.json();
                
                if (result.success) {
                    showToast(result.message, 'success');
                    form.reset();
                    clearMediaFile();
                } else {
                    showToast(result.error || 'Failed to dispatch.', 'error');
                }
            } catch (err) {
                showToast('Failed to connect to API server.', 'error');
            }
        }

        // Single Form execution submits
        async function handleSingleSubmit(e) {
            e.preventDefault();
            const form = document.getElementById('single-form');
            const data = new FormData(form);
            
            const number = data.get('number');
            const text = encodeURIComponent(data.get('text'));
            const media = encodeURIComponent(data.get('media'));

            showToast('Dispatching test message payload...', 'info');

            try {
                const url = \`/api/send?session=\${activeSession}&number=\${number}&text=\${text}\${media ? '&media='+media : ''}\`;
                const response = await fetch(url);
                const result = await response.json();

                if (result.success) {
                    showToast(result.message, 'success');
                    form.reset();
                } else {
                    showToast(result.error || 'Transmission failed.', 'error');
                }
            } catch (err) {
                showToast('Error connecting with gateway routing api.', 'error');
            }
        }

        // Visual Toaster Alerts
        function showToast(message, type = 'info') {
            const toast = document.getElementById('toast');
            const text = document.getElementById('toast-message');
            const icon = document.getElementById('toast-icon');

            text.innerText = message;
            
            icon.className = 'fa-solid ';
            if(type === 'success') {
                icon.className += 'fa-circle-check text-emerald-400';
            } else if (type === 'error') {
                icon.className += 'fa-triangle-exclamation text-rose-400';
            } else {
                icon.className += 'fa-circle-info text-sky-400';
            }

            toast.classList.remove('opacity-0', 'translate-y-10');
            toast.classList.add('opacity-100', 'translate-y-0');

            setTimeout(() => {
                toast.classList.remove('opacity-100', 'translate-y-0');
                toast.classList.add('opacity-0', 'translate-y-10');
            }, 4000);
        }

        function refreshState() {
            clearInterval(statusPollInterval);
            clearInterval(logsPollInterval);
            
            fetchStatus();
            fetchLogs();
            
            statusPollInterval = setInterval(fetchStatus, 3000);
            logsPollInterval = setInterval(fetchLogs, 2000);
        }

        // Main initial bootstrap onload
        window.onload = function() {
            refreshState();
        };
    </script>
</body>
</html>
    `);
});

// Inline Dynamic API Documentation Page
app.get('/api', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API Docs - Om Advertisement Gateway</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-slate-50 text-slate-800 flex flex-col min-h-screen font-sans">

    <!-- Responsive Global Navbar -->
    <nav class="bg-indigo-900 text-white shadow-lg sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex items-center justify-between h-16">
                <!-- Branding -->
                <div class="flex items-center space-x-3">
                    <div class="bg-emerald-500 p-2 rounded-lg text-white">
                        <i class="fa-brands fa-whatsapp text-2xl"></i>
                    </div>
                    <div>
                        <span class="font-extrabold text-xl tracking-tight block">Om Advertisement</span>
                        <span class="text-xs text-indigo-200 block -mt-1">Multi WhatsApp Gateway</span>
                    </div>
                </div>

                <!-- Navigation Options -->
                <div class="hidden md:flex items-center space-x-6">
                    <a href="/" class="hover:text-emerald-400 text-slate-300 font-medium transition flex items-center space-x-2">
                        <i class="fa-solid fa-gauge"></i> <span>Dashboard</span>
                    </a>
                    <a href="/api" class="hover:text-emerald-400 font-medium transition flex items-center space-x-2">
                        <i class="fa-solid fa-code"></i> <span>API Docs</span>
                    </a>
                    <a id="navbar-portal-link" href="http://omadvertisements.in/whatsapp-number.php?=session_id=default" target="_blank" class="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-md font-semibold transition shadow-md flex items-center space-x-2">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i>
                        <span>WhatsApp Portal</span>
                    </a>
                </div>
            </div>
        </div>
    </nav>

    <!-- Content Container -->
    <main class="flex-grow max-w-4xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-6 md:p-8">
            <h1 class="text-2xl font-extrabold text-slate-900 mb-2 flex items-center space-x-2">
                <i class="fa-solid fa-book-bookmark text-indigo-600"></i>
                <span>API Integration Documentation</span>
            </h1>
            <p class="text-slate-600 text-sm leading-relaxed mb-6">
                Integrate external platforms (CRMs, ERPs, automation builders, Zapier, websites) securely with your Om Advertisement instances via straightforward GET/POST payloads.
            </p>

            <div class="space-y-8">
                <!-- Endpoint Section: Redirect -->
                <div class="border-t border-slate-100 pt-6">
                    <div class="flex items-center space-x-2 mb-2">
                        <span class="bg-blue-600 text-white text-xs font-bold px-2.5 py-1 rounded">GET</span>
                        <code class="text-slate-800 font-mono text-sm font-bold">/api/redirect/:sessionName</code>
                    </div>
                    <p class="text-xs text-slate-500 mb-3">Seamlessly routes user browser agents into the central WhatsApp management portal attaching the target session identifier value.</p>
                </div>

                <!-- Endpoint Section: Send Single -->
                <div class="border-t border-slate-100 pt-6">
                    <div class="flex items-center space-x-2 mb-2">
                        <span class="bg-emerald-600 text-white text-xs font-bold px-2.5 py-1 rounded">GET</span>
                        <code class="text-slate-800 font-mono text-sm font-bold">/api/send</code>
                    </div>
                    <p class="text-xs text-slate-500 mb-3">Sends a quick text or media-based message payload directly to a specified destination target in real-time.</p>
                    
                    <h3 class="text-xs font-bold uppercase text-slate-600 mb-1">Query Parameters:</h3>
                    <ul class="list-disc pl-5 text-xs text-slate-600 space-y-1 mb-4">
                        <li><strong class="font-mono text-indigo-600">session</strong> (Optional, default is 'default'): Target instance label identifier.</li>
                        <li><strong class="font-mono text-indigo-600">number</strong> (Required): Target country code formatted number (e.g., 919988776655).</li>
                        <li><strong class="font-mono text-indigo-600">text</strong> (Required): URL Encoded message content body.</li>
                        <li><strong class="font-mono text-indigo-600">media</strong> (Optional): Absolute external image path URL to include.</li>
                    </ul>

                    <h3 class="text-xs font-bold uppercase text-slate-600 mb-1">Example Request:</h3>
                    <pre class="bg-slate-900 text-emerald-400 font-mono text-[11px] p-3 rounded-lg overflow-x-auto">
http://localhost:3000/api/send?session=default&number=919988776655&text=Hello%20World!
                    </pre>
                </div>

                <!-- Endpoint Section: Bulk Campaign -->
                <div class="border-t border-slate-100 pt-6">
                    <div class="flex items-center space-x-2 mb-2">
                        <span class="bg-orange-600 text-white text-xs font-bold px-2.5 py-1 rounded">POST</span>
                        <code class="text-slate-800 font-mono text-sm font-bold">/api/send-bulk</code>
                    </div>
                    <p class="text-xs text-slate-500 mb-3">Fires an off-loaded background campaign thread delivering customized marketing packages sequentially to listed phone targets.</p>

                    <h3 class="text-xs font-bold uppercase text-slate-600 mb-1">Body Attributes (multipart/form-data):</h3>
                    <ul class="list-disc pl-5 text-xs text-slate-600 space-y-1">
                        <li><strong class="font-mono text-indigo-600">session</strong>: String identifying the targeted WhatsApp session context.</li>
                        <li><strong class="font-mono text-indigo-600">numbers</strong>: Comma/new-line list of valid recipient destination targets.</li>
                        <li><strong class="font-mono text-indigo-600">message</strong>: Text message string content payload.</li>
                        <li><strong class="font-mono text-indigo-600">media</strong>: Binary file input containing marketing image assets.</li>
                    </ul>
                </div>
            </div>
        </div>
    </main>
</body>
</html>
    `);
});

// Boot and Listen
app.listen(port, () => {
    console.log(`=================================================`);
    console.log(` Om Advertisement Multi WhatsApp Gateway App`);
    console.log(` Application server running: http://localhost:${port}`);
    console.log(`=================================================`);
});
