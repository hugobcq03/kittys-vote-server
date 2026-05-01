/**
 * Serveur de vote — Kitty's Crates FR
 * Mode HTTP Polling (sans RCON)
 * L'addon Bedrock vient chercher les votes toutes les 10s
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const CONFIG = {
    port: 26626,
    vote_secret: "Hugobo12@!?",
    sites: {
        "serveur-minecraft.fr": { playerField: "username", secretField: "key", displayName: "Serveur-Minecraft.fr" },
        "top-serveurs.net":     { playerField: "pseudo",   secretField: "token", displayName: "Top-Serveurs.net" },
        "classement-serveur.fr":{ playerField: "player",   secretField: "secret", displayName: "Classement-Serveur.fr" }
    }
};

// ── Base JSON ──────────────────────────────────────────────
const DB_FILE = path.join(__dirname, "votes.json");

function loadDb() {
    try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
    catch {}
    return { votes: [] };
}
function saveDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8"); }

function addVote(player, site) {
    const db = loadDb();
    db.votes.push({ id: Date.now(), player, site, timestamp: Date.now(), delivered: false });
    saveDb(db);
}
function getPendingVotes() { return loadDb().votes.filter(v => !v.delivered); }
function markDelivered(id) {
    const db = loadDb();
    const v = db.votes.find(v => v.id === id);
    if (v) { v.delivered = true; saveDb(db); }
}

// ── Express ────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ── Webhook vote (sites de vote → Node.js) ─────────────────
app.post("/vote", async (req, res) => {
    const body = req.body;
    console.log("[Vote] Reçu:", JSON.stringify(body));

    let siteConfig = null, detectedSite = null;
    const referer = (req.headers.referer || req.headers.origin || "").toLowerCase();

    for (const [siteId, cfg] of Object.entries(CONFIG.sites)) {
        if (referer.includes(siteId) || body.site === siteId) {
            siteConfig = cfg; detectedSite = cfg.displayName; break;
        }
    }
    if (!siteConfig) {
        if (body.username !== undefined)     { siteConfig = CONFIG.sites["serveur-minecraft.fr"]; }
        else if (body.pseudo !== undefined)  { siteConfig = CONFIG.sites["top-serveurs.net"]; }
        else                                 { siteConfig = CONFIG.sites["classement-serveur.fr"]; }
        detectedSite = siteConfig.displayName;
    }

    const playerName = body[siteConfig.playerField];
    if (!playerName) return res.status(400).json({ error: "Pseudo manquant" });

    if (CONFIG.vote_secret) {
        const received = body[siteConfig.secretField] || body.key || body.secret || body.token;
        if (received !== CONFIG.vote_secret) {
            console.warn(`[Vote] Secret invalide pour ${playerName}`);
            return res.status(403).json({ error: "Accès refusé" });
        }
    }

    addVote(playerName, detectedSite);
    console.log(`✅ Vote enregistré : ${playerName} (${detectedSite})`);
    res.status(200).json({ success: true, player: playerName, site: detectedSite });
});

// ── Route Bedrock polling — l'addon vient chercher les votes ─
app.post("/bedrock/pending", (req, res) => {
    const secret = req.headers["x-secret"];
    if (secret !== CONFIG.vote_secret) return res.status(403).json({ error: "Accès refusé" });

    const { players } = req.body;
    if (!players || !Array.isArray(players)) return res.status(400).json({ error: "Liste joueurs manquante" });

    const pending = getPendingVotes().filter(v =>
        players.some(p => p.toLowerCase() === v.player.toLowerCase())
    );

    res.json({ votes: pending.map(v => ({ id: v.id, player: v.player, site: v.site, quantity: 1 })) });
});

// ── Route confirmation livraison ───────────────────────────
app.post("/bedrock/confirm", (req, res) => {
    const secret = req.headers["x-secret"];
    if (secret !== CONFIG.vote_secret) return res.status(403).json({ error: "Accès refusé" });

    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "ID manquant" });

    markDelivered(id);
    console.log(`✅ Vote ${id} confirmé livré`);
    res.json({ success: true });
});

// ── Santé & stats ──────────────────────────────────────────
app.get("/health", (req, res) => {
    res.json({ status: "ok", mode: "http-polling" });
});

app.get("/admin/stats", (req, res) => {
    const db = loadDb();
    res.json({
        total_votes: db.votes.length,
        pending_votes: db.votes.filter(v => !v.delivered).length,
        recent: db.votes.slice(-20).reverse()
    });
});

app.listen(CONFIG.port, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║   Serveur de vote Kitty's Crates — :${CONFIG.port}       ║
║   Webhook  : http://mn03.azurhosts.com:${CONFIG.port}/vote  ║
║   Santé    : http://mn03.azurhosts.com:${CONFIG.port}/health ║
║   Mode     : HTTP Polling (sans RCON)            ║
╚══════════════════════════════════════════════════╝
    `);
});
