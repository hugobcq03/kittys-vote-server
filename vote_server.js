/**
 * Serveur de vote — Kitty's Crates FR
 * Mode push : Railway → AzurHosts WebSocket → BDS
 * Dès qu'un vote arrive, la clé est donnée directement via WS
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const CONFIG = {
    port: process.env.PORT || 3000,
    vote_secret: "Hugobo12@!?",

    // ── AzurHosts WebSocket ──────────────────────────────────
    // Récupère ces valeurs depuis l'URL de ton panel :
    // azura.azurhosts.com/azurbox/5f7152a9/server/21ef08c4/console
    azur_box_id:    process.env.AZUR_BOX_ID    || "5f7152a9",
    azur_server_id: process.env.AZUR_SERVER_ID || "21ef08c4",
    azur_token:     process.env.AZUR_TOKEN     || "",  // ← à remplir (voir ci-dessous)
    // URL WS : wss://azura.azurhosts.com/azurhosts/api/user/transmit
    azur_ws_url:    "wss://azura.azurhosts.com/azurhosts/api/user/transmit",
    azur_enc_session_id: process.env.AZUR_ENC_SESSION_ID || "",

    sites: {
        "serveur-minecraft.fr":  { playerField: "username", secretField: "key",    displayName: "Serveur-Minecraft.fr" },
        "top-serveurs.net":      { playerField: "pseudo",   secretField: "token",  displayName: "Top-Serveurs.net" },
        "classement-serveur.fr": { playerField: "player",   secretField: "secret", displayName: "Classement-Serveur.fr" }
    }
};

// ── Base JSON ──────────────────────────────────────────────
const DB_FILE = path.join(__dirname, "votes.json");
function loadDb() {
    try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch {}
    return { votes: [], pending_offline: [] };
}
function saveDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8"); }

function addVote(player, site) {
    const db = loadDb();
    const vote = { id: Date.now(), player, site, timestamp: Date.now(), delivered: false };
    db.votes.push(vote);
    saveDb(db);
    return vote;
}

function markDelivered(id) {
    const db = loadDb();
    const v = db.votes.find(v => v.id === Number(id));
    if (v) { v.delivered = true; saveDb(db); }
}

function addPendingOffline(player, site, qty) {
    const db = loadDb();
    if (!db.pending_offline) db.pending_offline = [];
    const existing = db.pending_offline.find(p => p.player.toLowerCase() === player.toLowerCase());
    if (existing) { existing.qty += qty; }
    else { db.pending_offline.push({ player, site, qty }); }
    saveDb(db);
}

function getPendingOffline(player) {
    const db = loadDb();
    if (!db.pending_offline) return null;
    return db.pending_offline.find(p => p.player.toLowerCase() === player.toLowerCase()) || null;
}

function clearPendingOffline(player) {
    const db = loadDb();
    if (!db.pending_offline) return;
    db.pending_offline = db.pending_offline.filter(p => p.player.toLowerCase() !== player.toLowerCase());
    saveDb(db);
}

// ── AzurHosts WebSocket ────────────────────────────────────
// Envoie une commande au BDS via le WebSocket AzurHosts
function sendCommandToBDS(command) {
    return new Promise((resolve, reject) => {
        if (!CONFIG.azur_token) {
            reject(new Error("AZUR_TOKEN non configuré"));
            return;
        }

        const ws = new WebSocket(CONFIG.azur_ws_url, {
            headers: {
                "Cookie": `token=${CONFIG.azur_token}`,
                "Origin": "https://azura.azurhosts.com"
            }
        });

        const timeout = setTimeout(() => {
            ws.terminate();
            reject(new Error("Timeout WebSocket"));
        }, 10000);

        let authenticated = false;

        ws.on("open", () => {
            console.log(`[WS] Connexion ouverte, authentification...`);

            // 1. S'authentifier
            ws.send(JSON.stringify({
                event: "auth",
                token: CONFIG.azur_token,
                encSessionId: CONFIG.azur_enc_session_id
            }));
        });

        ws.on("message", (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                console.log(`[WS] Message reçu : ${JSON.stringify(msg).substring(0, 150)}`);

                if (!authenticated && msg.event === "authenticated") {
                    authenticated = true;

                    // 2. S'abonner au serveur via transmit HTTP (comme le panel)
                    const reqId = Date.now() + "-vote";
                    ws.send(JSON.stringify({
                        event: "transmit",
                        requestId: reqId,
                        action: "http",
                        data: {
                            method: "GET",
                            path: `/api/extend/user/server/${CONFIG.azur_server_id}/subusers`
                        }
                    }));
                    console.log(`[WS] Abonnement serveur ${CONFIG.azur_server_id}`);

                    // 3. Envoyer la commande après l'abonnement
                    setTimeout(() => {
                        ws.send(JSON.stringify({
                            event: "send_command",
                            data: command
                        }));
                        console.log(`[WS] Commande envoyée : ${command}`);

                        setTimeout(() => {
                            clearTimeout(timeout);
                            ws.close();
                            resolve(true);
                        }, 2000);
                    }, 1500);
                }
            } catch {}
        });

        ws.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        ws.on("close", () => {
            clearTimeout(timeout);
        });
    });
}

// ── Donner une clé via commande BDS ───────────────────────
async function giveKeyToBDSPlayer(playerName, qty, siteName) {
    const cmd = `give ${playerName} kittys:votecrate_key ${qty}`;
    try {
        await sendCommandToBDS(cmd);
        console.log(`✅ Clé donnée à ${playerName} via BDS (${siteName})`);

        // Broadcast dans le chat
        await sendCommandToBDS(
            `tellraw @a {"rawtext":[{"text":"§6✦ §l${playerName}§r §6a voté sur §e${siteName}§6 ! Votez aussi !"}]}`
        );
        return true;
    } catch (e) {
        console.error(`❌ Erreur envoi commande BDS : ${e.message}`);
        return false;
    }
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
        if (body.username !== undefined)    { siteConfig = CONFIG.sites["serveur-minecraft.fr"]; }
        else if (body.pseudo !== undefined) { siteConfig = CONFIG.sites["top-serveurs.net"]; }
        else                               { siteConfig = CONFIG.sites["classement-serveur.fr"]; }
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

    const vote = addVote(playerName, detectedSite);
    console.log(`✅ Vote enregistré : ${playerName} (${detectedSite})`);

    // Tenter de donner la clé immédiatement via BDS
    const success = await giveKeyToBDSPlayer(playerName, 1, detectedSite);

    if (success) {
        markDelivered(vote.id);
        res.status(200).json({ success: true, player: playerName, site: detectedSite, delivered: true });
    } else {
        // Joueur hors ligne ou erreur WS → mise en attente scoreboard
        addPendingOffline(playerName, detectedSite, 1);
        console.log(`⏳ ${playerName} hors ligne — clé mise en attente`);
        res.status(200).json({ success: true, player: playerName, site: detectedSite, delivered: false, pending: true });
    }
});

// ── Route login : appelée par l'addon au spawn du joueur ───
// L'addon envoie toujours un POST /bedrock/login quand un joueur se connecte
// Railway vérifie s'il a des clés en attente et les envoie via BDS
app.post("/bedrock/login", async (req, res) => {
    const secret = req.headers["x-secret"];
    if (secret !== CONFIG.vote_secret) return res.status(403).json({ error: "Accès refusé" });

    const { player } = req.body;
    if (!player) return res.status(400).json({ error: "Joueur manquant" });

    const pending = getPendingOffline(player);
    if (!pending) {
        return res.json({ success: true, keys: 0 });
    }

    console.log(`[Login] ${player} connecté — ${pending.qty} clé(s) en attente`);
    const success = await giveKeyToBDSPlayer(player, pending.qty, pending.site);

    if (success) {
        clearPendingOffline(player);
        // Message de bienvenue
        await sendCommandToBDS(
            `tellraw ${player} {"rawtext":[{"text":"§a✦ §lBienvenue !§r §aVous aviez §e${pending.qty} clé(s) de vote§a en attente !"}]}`
        );
        res.json({ success: true, keys: pending.qty });
    } else {
        res.json({ success: false, keys: pending.qty, error: "Impossible de donner les clés" });
    }
});

// ── Santé & stats ──────────────────────────────────────────
app.get("/health", (req, res) => {
    res.json({ status: "ok", mode: "azurhosts-websocket-push" });
});

app.get("/admin/stats", (req, res) => {
    const db = loadDb();
    res.json({
        total_votes: db.votes.length,
        pending_votes: db.votes.filter(v => !v.delivered).length,
        pending_offline: db.pending_offline || [],
        recent: db.votes.slice(-20).reverse()
    });
});

app.listen(CONFIG.port, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║   Serveur de vote Kitty's Crates                 ║
║   Mode : AzurHosts WebSocket Push               ║
║   Port : ${CONFIG.port}                                   ║
╚══════════════════════════════════════════════════╝
    `);

    if (!CONFIG.azur_token) {
        console.warn("⚠️  AZUR_TOKEN non configuré ! Les commandes BDS ne fonctionneront pas.");
        console.warn("   → Ajoute AZUR_TOKEN dans les variables d'environnement Railway.");
    }
});
