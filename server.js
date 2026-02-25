const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const { WebSocketServer, WebSocket } = require('ws');

// ===== CONFIG =====
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'encodenote.db');

// ===== DATABASE SETUP =====
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // faster writes
db.exec(`
    CREATE TABLE IF NOT EXISTS vaults (
        hash TEXT PRIMARY KEY,
        salt TEXT NOT NULL,
        iv TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s','now'))
    )
`);

const getVault = db.prepare('SELECT salt, iv, ciphertext FROM vaults WHERE hash = ?');
const upsertVault = db.prepare(`
    INSERT INTO vaults (hash, salt, iv, ciphertext, updated_at)
    VALUES (?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(hash) DO UPDATE SET
        salt = excluded.salt,
        iv = excluded.iv,
        ciphertext = excluded.ciphertext,
        updated_at = strftime('%s','now')
`);

// ===== EXPRESS APP =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve frontend
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'code.html'));
});

// GET vault
app.get('/api/note/:hash', (req, res) => {
    const hash = req.params.hash.replace(/[^a-f0-9]/gi, '');
    const vault = getVault.get(hash);
    if (vault) {
        res.json(vault);
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

// PUT vault
app.put('/api/note/:hash', (req, res) => {
    const hash = req.params.hash.replace(/[^a-f0-9]/gi, '');
    const { salt, iv, ciphertext } = req.body;

    if (!salt || !iv || !ciphertext) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    try {
        upsertVault.run(hash, salt, iv, ciphertext);
        res.json({ ok: true });

        // Broadcast to other clients watching this vault
        broadcastToVault(hash, { type: 'updated' });
    } catch (err) {
        res.status(500).json({ error: 'Write failed' });
    }
});

// ===== HTTP + WEBSOCKET SERVER =====
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Track which clients are watching which vaults
// Map<hash, Set<WebSocket>>
const vaultClients = new Map();

wss.on('connection', (ws) => {
    ws.vaultHash = null;

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);

            if (msg.type === 'join' && msg.hash) {
                // Leave previous vault if any
                leaveVault(ws);

                // Join new vault
                ws.vaultHash = msg.hash;
                if (!vaultClients.has(msg.hash)) {
                    vaultClients.set(msg.hash, new Set());
                }
                vaultClients.get(msg.hash).add(ws);

                // Send confirmation with count of connected users
                const count = vaultClients.get(msg.hash).size;
                ws.send(JSON.stringify({ type: 'joined', users: count }));

                // Notify others that a user joined
                broadcastToVault(msg.hash, { type: 'users', count }, ws);
            }
        } catch { }
    });

    ws.on('close', () => {
        const hash = ws.vaultHash;
        leaveVault(ws);
        // Notify remaining clients
        if (hash && vaultClients.has(hash)) {
            const count = vaultClients.get(hash).size;
            broadcastToVault(hash, { type: 'users', count });
        }
    });
});

function leaveVault(ws) {
    if (ws.vaultHash && vaultClients.has(ws.vaultHash)) {
        vaultClients.get(ws.vaultHash).delete(ws);
        if (vaultClients.get(ws.vaultHash).size === 0) {
            vaultClients.delete(ws.vaultHash);
        }
    }
    ws.vaultHash = null;
}

function broadcastToVault(hash, data, excludeWs = null) {
    if (!vaultClients.has(hash)) return;
    const msg = JSON.stringify(data);
    for (const client of vaultClients.get(hash)) {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

// ===== START =====
server.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║   ENCODENOTE SERVER ACTIVE           ║`);
    console.log(`  ║   http://localhost:${PORT}              ║`);
    console.log(`  ║   SQLite: ${path.basename(DB_PATH).padEnd(27)}║`);
    console.log(`  ║   WebSocket: READY                   ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
});
