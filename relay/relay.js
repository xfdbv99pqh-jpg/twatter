// ================================================================
// TWATTER RELAY — A Nostr relay server (NIP-01, NIP-02, NIP-04, NIP-09, NIP-11, NIP-16)
// ================================================================
// Usage: npm start
// Config via environment variables (see defaults below)
// ================================================================

const { WebSocketServer } = require("ws");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

// ======================== CONFIG ========================
const PORT = parseInt(process.env.PORT || "7777");
const DB_PATH = process.env.DB_PATH || "./twatter-relay.db";
const MAX_EVENT_SIZE = parseInt(process.env.MAX_EVENT_SIZE || "65536"); // 64KB
const MAX_SUBSCRIPTIONS = parseInt(process.env.MAX_SUBS || "20");
const MAX_FILTERS_PER_SUB = parseInt(process.env.MAX_FILTERS || "10");
const RELAY_NAME = process.env.RELAY_NAME || "Twatter Relay";
const RELAY_DESC = process.env.RELAY_DESC || "A Twatter community Nostr relay. No algorithms, just time.";
const RELAY_CONTACT = process.env.RELAY_CONTACT || "";
const ENABLE_NIP04 = process.env.ENABLE_NIP04 !== "false";

// Pro gating config
const PAYMENT_SERVER = process.env.PAYMENT_SERVER || "http://localhost:7779";
const FREE_RATE_LIMIT = parseInt(process.env.FREE_RATE_LIMIT || "10");  // events per minute
const PRO_RATE_LIMIT = parseInt(process.env.PRO_RATE_LIMIT || "100");   // events per minute
const FREE_CONTENT_LIMIT = parseInt(process.env.FREE_CONTENT_LIMIT || "300");  // chars
const PRO_CONTENT_LIMIT = parseInt(process.env.PRO_CONTENT_LIMIT || "2000");   // chars
const PRO_CACHE_TTL = parseInt(process.env.PRO_CACHE_TTL || "300");     // seconds (5 min)

// ======================== DATABASE ========================
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("cache_size = -64000"); // 64MB cache

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    kind INTEGER NOT NULL,
    tags TEXT NOT NULL,
    content TEXT NOT NULL,
    sig TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pubkey ON events(pubkey);
  CREATE INDEX IF NOT EXISTS idx_kind ON events(kind);
  CREATE INDEX IF NOT EXISTS idx_created_at ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_kind_pubkey ON events(kind, pubkey);
  CREATE INDEX IF NOT EXISTS idx_kind_created ON events(kind, created_at);

  CREATE TABLE IF NOT EXISTS tags (
    event_id TEXT NOT NULL,
    tag_name TEXT NOT NULL,
    tag_value TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tags ON tags(tag_name, tag_value);
  CREATE INDEX IF NOT EXISTS idx_tags_event ON tags(event_id);
`);

// Prepared statements for performance
const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertTag = db.prepare(`
  INSERT INTO tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)
`);
const deleteEvent = db.prepare(`DELETE FROM events WHERE id = ?`);
const deleteTags = db.prepare(`DELETE FROM tags WHERE event_id = ?`);
const getEventById = db.prepare(`SELECT * FROM events WHERE id = ?`);

// Replaceable events (kind 0, 3, 10000-19999): keep only latest per pubkey+kind
const deleteReplaceable = db.prepare(`
  DELETE FROM events WHERE kind = ? AND pubkey = ? AND created_at < ?
`);
// Parameterized replaceable (kind 30000-39999): keep only latest per pubkey+kind+d-tag
const deleteParamReplaceable = db.prepare(`
  DELETE FROM events WHERE kind = ? AND pubkey = ? AND id IN (
    SELECT e.id FROM events e
    JOIN tags t ON t.event_id = e.id AND t.tag_name = 'd'
    WHERE e.kind = ? AND e.pubkey = ? AND t.tag_value = ? AND e.created_at < ?
  )
`);

// ======================== PRO STATUS CACHE ========================
// In-memory cache: pubkey -> { isPro: bool, expiresAt: timestamp }
const proCache = new Map();

function fetchProStatus(pubkey) {
  return new Promise((resolve) => {
    const url = `${PAYMENT_SERVER}/pro/${pubkey}`;
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(data.isPro === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function isProPubkey(pubkey) {
  const now = Math.floor(Date.now() / 1000);
  const cached = proCache.get(pubkey);
  if (cached && cached.expiresAt > now) {
    return cached.isPro;
  }
  const isPro = await fetchProStatus(pubkey);
  proCache.set(pubkey, { isPro, expiresAt: now + PRO_CACHE_TTL });
  return isPro;
}

// Evict stale cache entries every 10 minutes
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [key, val] of proCache) {
    if (val.expiresAt <= now) proCache.delete(key);
  }
}, 600_000);

// ======================== RATE LIMITING ========================
// Per-pubkey sliding window: Map<pubkey, number[]> of event timestamps
const rateLimitWindows = new Map();

function checkRateLimit(pubkey, isPro) {
  const limit = isPro ? PRO_RATE_LIMIT : FREE_RATE_LIMIT;
  const now = Date.now();
  const windowMs = 60_000; // 1 minute window

  if (!rateLimitWindows.has(pubkey)) {
    rateLimitWindows.set(pubkey, []);
  }
  const timestamps = rateLimitWindows.get(pubkey);

  // Remove timestamps outside the window
  const cutoff = now - windowMs;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }

  if (timestamps.length >= limit) {
    return false; // Rate limited
  }

  timestamps.push(now);
  return true;
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, timestamps] of rateLimitWindows) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
      rateLimitWindows.delete(key);
    }
  }
}, 300_000);

// ======================== EVENT VALIDATION ========================
function verifyEventId(event) {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const hash = crypto.createHash("sha256").update(serialized).digest("hex");
  return hash === event.id;
}

function validateEvent(event) {
  if (!event || typeof event !== "object") return "invalid: not an object";
  if (typeof event.id !== "string" || !/^[0-9a-f]{64}$/.test(event.id)) return "invalid: bad id";
  if (typeof event.pubkey !== "string" || !/^[0-9a-f]{64}$/.test(event.pubkey)) return "invalid: bad pubkey";
  if (typeof event.created_at !== "number" || event.created_at < 0) return "invalid: bad created_at";
  if (typeof event.kind !== "number" || event.kind < 0) return "invalid: bad kind";
  if (!Array.isArray(event.tags)) return "invalid: bad tags";
  if (typeof event.content !== "string") return "invalid: bad content";
  if (typeof event.sig !== "string" || !/^[0-9a-f]{128}$/.test(event.sig)) return "invalid: bad sig";
  if (JSON.stringify(event).length > MAX_EVENT_SIZE) return "invalid: too large";
  if (!verifyEventId(event)) return "invalid: id mismatch";
  if (event.kind === 4 && !ENABLE_NIP04) return "blocked: DMs disabled";
  // Reject events too far in the future (5 min grace)
  if (event.created_at > Math.floor(Date.now() / 1000) + 300) return "invalid: timestamp in future";
  return null;
}

// ======================== STORE EVENT ========================
const storeEvent = db.transaction((event) => {
  // Handle replaceable events (NIP-16)
  if (event.kind === 0 || event.kind === 3 || (event.kind >= 10000 && event.kind < 20000)) {
    deleteReplaceable.run(event.kind, event.pubkey, event.created_at);
  }
  // Handle parameterized replaceable events
  if (event.kind >= 30000 && event.kind < 40000) {
    const dTag = event.tags.find((t) => t[0] === "d")?.[1] || "";
    deleteParamReplaceable.run(event.kind, event.pubkey, event.kind, event.pubkey, dTag, event.created_at);
  }
  // Handle NIP-09 deletion events
  if (event.kind === 5) {
    for (const tag of event.tags) {
      if (tag[0] === "e") {
        const target = getEventById.get(tag[1]);
        if (target && target.pubkey === event.pubkey) {
          deleteTags.run(tag[1]);
          deleteEvent.run(tag[1]);
        }
      }
    }
  }

  const result = insertEvent.run(event.id, event.pubkey, event.created_at, event.kind, JSON.stringify(event.tags), event.content, event.sig);
  if (result.changes > 0) {
    for (const tag of event.tags) {
      if (tag.length >= 2 && tag[0].length === 1) {
        insertTag.run(event.id, tag[0], tag[1]);
      }
    }
    return true;
  }
  return false; // duplicate
});

// ======================== QUERY EVENTS ========================
function queryEvents(filter) {
  const conditions = [];
  const params = [];

  if (filter.ids?.length) {
    conditions.push(`e.id IN (${filter.ids.map(() => "?").join(",")})`);
    params.push(...filter.ids);
  }
  if (filter.authors?.length) {
    conditions.push(`e.pubkey IN (${filter.authors.map(() => "?").join(",")})`);
    params.push(...filter.authors);
  }
  if (filter.kinds?.length) {
    conditions.push(`e.kind IN (${filter.kinds.map(() => "?").join(",")})`);
    params.push(...filter.kinds);
  }
  if (filter.since) {
    conditions.push(`e.created_at >= ?`);
    params.push(filter.since);
  }
  if (filter.until) {
    conditions.push(`e.created_at <= ?`);
    params.push(filter.until);
  }

  // Tag filters (#e, #p, etc.)
  const tagFilters = Object.entries(filter).filter(([k]) => k.startsWith("#") && k.length === 2);
  for (const [key, values] of tagFilters) {
    if (Array.isArray(values) && values.length) {
      const tagName = key.slice(1);
      conditions.push(`e.id IN (SELECT event_id FROM tags WHERE tag_name = ? AND tag_value IN (${values.map(() => "?").join(",")}))`);
      params.push(tagName, ...values);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filter.limit || 500, 5000);
  const sql = `SELECT e.* FROM events e ${where} ORDER BY e.created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return rows.map((r) => ({
    id: r.id,
    pubkey: r.pubkey,
    created_at: r.created_at,
    kind: r.kind,
    tags: JSON.parse(r.tags),
    content: r.content,
    sig: r.sig,
  }));
}

// ======================== WEBSOCKET SERVER ========================
const server = http.createServer((req, res) => {
  // NIP-11 relay information
  if (req.headers.accept === "application/nostr+json") {
    res.writeHead(200, { "Content-Type": "application/nostr+json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      name: RELAY_NAME,
      description: RELAY_DESC,
      pubkey: "",
      contact: RELAY_CONTACT,
      supported_nips: [1, 2, 4, 9, 11, 16],
      software: "twatter-relay",
      version: "1.1.0",
      limitation: {
        max_message_length: MAX_EVENT_SIZE,
        max_subscriptions: MAX_SUBSCRIPTIONS,
        max_filters: MAX_FILTERS_PER_SUB,
        payment_required: false,
      },
      fees: {
        subscription: [{ amount: 800, unit: "cents/month", description: "Twatter Pro — higher limits" }],
      },
    }));
    return;
  }
  // Health check
  res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
  res.end("Twatter Relay is running.");
});

const wss = new WebSocketServer({ server });

let connectionCount = 0;
const stats = { events_stored: 0, events_received: 0, connections_total: 0, rate_limited: 0, pro_blocked: 0 };

wss.on("connection", (ws, req) => {
  connectionCount++;
  stats.connections_total++;
  const clientId = `${req.socket.remoteAddress}:${connectionCount}`;
  const subscriptions = new Map(); // subId -> filters[]

  console.log(`[+] ${clientId} connected (${wss.clients.size} total)`);

  ws.on("message", async (raw) => {
    let msg;
    try {
      const str = raw.toString();
      if (str.length > MAX_EVENT_SIZE * 2) {
        ws.send(JSON.stringify(["NOTICE", "message too large"]));
        return;
      }
      msg = JSON.parse(str);
    } catch {
      ws.send(JSON.stringify(["NOTICE", "invalid JSON"]));
      return;
    }

    if (!Array.isArray(msg) || msg.length < 2) {
      ws.send(JSON.stringify(["NOTICE", "invalid message format"]));
      return;
    }

    const type = msg[0];

    // ---- EVENT ----
    if (type === "EVENT") {
      const event = msg[1];
      stats.events_received++;

      // Basic validation first (sync, fast)
      const err = validateEvent(event);
      if (err) {
        ws.send(JSON.stringify(["OK", event?.id || "", false, err]));
        return;
      }

      // Check Pro status (async, cached)
      const isPro = await isProPubkey(event.pubkey);

      // Content length check for text notes (kind 1) and profiles (kind 0)
      if (event.kind === 1) {
        const limit = isPro ? PRO_CONTENT_LIMIT : FREE_CONTENT_LIMIT;
        if (event.content.length > limit) {
          stats.pro_blocked++;
          const msg = isPro
            ? `blocked: content too long (max ${limit} chars)`
            : `blocked: content too long (max ${limit} chars for free tier — upgrade to Twatter Pro for ${PRO_CONTENT_LIMIT} chars)`;
          ws.send(JSON.stringify(["OK", event.id, false, msg]));
          return;
        }
      }

      // Rate limiting
      if (!checkRateLimit(event.pubkey, isPro)) {
        stats.rate_limited++;
        const limit = isPro ? PRO_RATE_LIMIT : FREE_RATE_LIMIT;
        ws.send(JSON.stringify([
          "OK", event.id, false,
          `rate-limited: max ${limit} events/min${isPro ? "" : " — upgrade to Twatter Pro for higher limits"}`,
        ]));
        return;
      }

      try {
        const stored = storeEvent(event);
        if (stored) {
          stats.events_stored++;
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
          broadcastEvent(event, ws);
        } else {
          ws.send(JSON.stringify(["OK", event.id, true, "duplicate:"]));
        }
      } catch (e) {
        ws.send(JSON.stringify(["OK", event.id, false, `error: ${e.message}`]));
      }
    }

    // ---- REQ (subscribe) ----
    else if (type === "REQ") {
      const subId = msg[1];
      if (typeof subId !== "string" || subId.length > 64) {
        ws.send(JSON.stringify(["NOTICE", "invalid subscription id"]));
        return;
      }
      if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
        ws.send(JSON.stringify(["NOTICE", "too many subscriptions"]));
        return;
      }
      const filters = msg.slice(2).slice(0, MAX_FILTERS_PER_SUB);
      subscriptions.set(subId, filters);

      // Send stored events matching filters
      for (const filter of filters) {
        const events = queryEvents(filter);
        for (const event of events) {
          ws.send(JSON.stringify(["EVENT", subId, event]));
        }
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    }

    // ---- CLOSE (unsubscribe) ----
    else if (type === "CLOSE") {
      const subId = msg[1];
      subscriptions.delete(subId);
    }

    else {
      ws.send(JSON.stringify(["NOTICE", `unknown message type: ${type}`]));
    }
  });

  ws.on("close", () => {
    subscriptions.clear();
    console.log(`[-] ${clientId} disconnected (${wss.clients.size} total)`);
  });

  ws.on("error", () => {
    subscriptions.clear();
  });

  // Store subscriptions on the ws object for broadcasting
  ws._subscriptions = subscriptions;
});

function broadcastEvent(event, sender) {
  for (const client of wss.clients) {
    if (client === sender || client.readyState !== 1) continue;
    const subs = client._subscriptions;
    if (!subs) continue;
    for (const [subId, filters] of subs) {
      if (matchesAnyFilter(event, filters)) {
        client.send(JSON.stringify(["EVENT", subId, event]));
        break; // Only send once per client
      }
    }
  }
}

function matchesAnyFilter(event, filters) {
  return filters.some((f) => matchesFilter(event, f));
}

function matchesFilter(event, filter) {
  if (filter.ids?.length && !filter.ids.includes(event.id)) return false;
  if (filter.authors?.length && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds?.length && !filter.kinds.includes(event.kind)) return false;
  if (filter.since && event.created_at < filter.since) return false;
  if (filter.until && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#") && key.length === 2 && Array.isArray(values)) {
      const tagName = key.slice(1);
      const eventTagValues = event.tags.filter((t) => t[0] === tagName).map((t) => t[1]);
      if (!values.some((v) => eventTagValues.includes(v))) return false;
    }
  }
  return true;
}

// ======================== START ========================
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║         TWATTER RELAY v1.1.0             ║
  ║──────────────────────────────────────────║
  ║  WebSocket:  ws://localhost:${PORT}        ║
  ║  HTTP Info:  http://localhost:${PORT}       ║
  ║  Database:   ${DB_PATH.padEnd(27)}║
  ║  NIP-04 DMs: ${(ENABLE_NIP04 ? "enabled" : "disabled").padEnd(28)}║
  ║  Free limit: ${String(FREE_CONTENT_LIMIT + " chars / " + FREE_RATE_LIMIT + " ev/min").padEnd(27)}║
  ║  Pro limit:  ${String(PRO_CONTENT_LIMIT + " chars / " + PRO_RATE_LIMIT + " ev/min").padEnd(27)}║
  ╚══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  wss.close();
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Shutting down (SIGTERM)...");
  wss.close();
  db.close();
  process.exit(0);
});

// Log stats every 60s
setInterval(() => {
  console.log(`[stats] clients=${wss.clients.size} stored=${stats.events_stored} received=${stats.events_received} rate_limited=${stats.rate_limited} pro_blocked=${stats.pro_blocked} connections_total=${stats.connections_total}`);
}, 60000);
