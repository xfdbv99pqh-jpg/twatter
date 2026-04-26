/**
 * Twatter Payment Server v3.1.0 — NWC Edition
 * Uses Nostr Wallet Connect (NIP-47) via @getalby/sdk
 * No HTTP API auth needed — NWC handles everything over Nostr relays
 */

import WebSocket from "ws";
globalThis.WebSocket = WebSocket;
import http from "http";
import crypto from "crypto";
import Database from "better-sqlite3";
import { nwc } from "@getalby/sdk";

// Config
var PORT = parseInt(process.env.PORT || "7779", 10);
var DB_PATH = process.env.DB_PATH || "./twatter-payments.db";
var NWC_URL = process.env.NWC_URL || "";
var PRO_PRICE_USD = parseFloat(process.env.PRO_PRICE_USD || "5.00");
var PRO_PRICE_SATS = parseInt(process.env.PRO_PRICE_SATS || "0"); // 0 = use dynamic USD pricing
var PRO_DURATION_DAYS = parseInt(process.env.PRO_DURATION_DAYS || "30");
var ZAP_FEE_PERCENT = parseFloat(process.env.ZAP_FEE_PERCENT || "2.0");
var CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

// BTC price cache
var btcPriceCache = { usd: 0, fetchedAt: 0 };
var BTC_PRICE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function getBtcPriceUsd() {
  var now = Date.now();
  if (btcPriceCache.usd > 0 && now - btcPriceCache.fetchedAt < BTC_PRICE_CACHE_TTL) {
    return btcPriceCache.usd;
  }
  // Try multiple price sources
  var sources = [
    { url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", parse: function(d) { return parseFloat(d.result.XXBTZUSD.c[0]); } },
    { url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", parse: function(d) { return parseFloat(d.data.amount); } },
    { url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", parse: function(d) { return d.bitcoin.usd; } }
  ];
  for (var i = 0; i < sources.length; i++) {
    try {
      var res = await fetch(sources[i].url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      var data = await res.json();
      var price = sources[i].parse(data);
      if (price && price > 0) {
        btcPriceCache = { usd: price, fetchedAt: now };
        console.log("[payment] BTC price updated: $" + price.toFixed(2) + " (source " + (i + 1) + ")");
        return price;
      }
    } catch(e) { continue; }
  }
  // Fallback to cached even if stale
  if (btcPriceCache.usd > 0) return btcPriceCache.usd;
  throw new Error("Could not fetch BTC price from any source");
}

function usdToSats(usd, btcPrice) {
  return Math.round((usd / btcPrice) * 100000000);
}

async function getProPriceSats() {
  if (PRO_PRICE_SATS > 0) return PRO_PRICE_SATS; // manual override
  var btcPrice = await getBtcPriceUsd();
  return usdToSats(PRO_PRICE_USD, btcPrice);
}

// NWC Client
var nwcClient = null;

if (NWC_URL) {
  try {
    nwcClient = new nwc.NWCClient({ nostrWalletConnectUrl: NWC_URL });
    console.log("[payment] NWC client initialized");
  } catch(e) {
    console.error("[payment] Failed to init NWC client:", e.message);
  }
} else {
  console.warn("[payment] WARNING: NWC_URL not set. Lightning invoices will fail.");
  console.warn("[payment] Set up Alby Hub and paste your NWC connection string.");
}

// Database
var db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec([
  "CREATE TABLE IF NOT EXISTS subscribers (",
  "  pubkey            TEXT PRIMARY KEY,",
  "  status            TEXT NOT NULL DEFAULT 'inactive',",
  "  expires_at        INTEGER,",
  "  total_paid_sats   INTEGER NOT NULL DEFAULT 0,",
  "  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),",
  "  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_sub_status ON subscribers(status);",
  "CREATE INDEX IF NOT EXISTS idx_sub_expires ON subscribers(expires_at);",
  "CREATE TABLE IF NOT EXISTS invoices (",
  "  invoice_id      TEXT PRIMARY KEY,",
  "  payment_hash    TEXT,",
  "  pubkey          TEXT NOT NULL,",
  "  amount_sats     INTEGER NOT NULL,",
  "  bolt11          TEXT NOT NULL,",
  "  status          TEXT NOT NULL DEFAULT 'pending',",
  "  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),",
  "  paid_at         INTEGER",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_inv_pubkey ON invoices(pubkey);",
  "CREATE INDEX IF NOT EXISTS idx_inv_status ON invoices(status);",
  "CREATE INDEX IF NOT EXISTS idx_inv_hash ON invoices(payment_hash);"
].join("\n"));

db.exec([
  "CREATE TABLE IF NOT EXISTS zap_transactions (",
  "  id                TEXT PRIMARY KEY,",
  "  sender_pubkey     TEXT NOT NULL,",
  "  recipient_lud16   TEXT NOT NULL,",
  "  total_sats        INTEGER NOT NULL,",
  "  fee_sats          INTEGER NOT NULL,",
  "  payout_sats       INTEGER NOT NULL,",
  "  payment_hash      TEXT,",
  "  bolt11_in         TEXT,",
  "  status            TEXT NOT NULL DEFAULT 'pending',",
  "  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),",
  "  paid_in_at        INTEGER,",
  "  paid_out_at       INTEGER",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_zap_status ON zap_transactions(status);",
  "CREATE INDEX IF NOT EXISTS idx_zap_sender ON zap_transactions(sender_pubkey);"
].join("\n"));

var insertZap = db.prepare(
  "INSERT INTO zap_transactions (id, sender_pubkey, recipient_lud16, total_sats, fee_sats, payout_sats, payment_hash, bolt11_in) " +
  "VALUES (@id, @sender_pubkey, @recipient_lud16, @total_sats, @fee_sats, @payout_sats, @payment_hash, @bolt11_in)"
);
var getZap = db.prepare("SELECT * FROM zap_transactions WHERE id = ?");
var getZapByHash = db.prepare("SELECT * FROM zap_transactions WHERE payment_hash = ?");
var markZapPaidIn = db.prepare("UPDATE zap_transactions SET status = 'paid_in', paid_in_at = unixepoch() WHERE id = ?");
var markZapComplete = db.prepare("UPDATE zap_transactions SET status = 'complete', paid_out_at = unixepoch() WHERE id = ?");
var markZapFailed = db.prepare("UPDATE zap_transactions SET status = 'payout_failed' WHERE id = ?");
var getPendingZaps = db.prepare("SELECT * FROM zap_transactions WHERE status = 'pending' AND created_at > unixepoch() - 600");
var getPaidInZaps = db.prepare("SELECT * FROM zap_transactions WHERE status = 'paid_in'");

var upsertSubscriber = db.prepare(
  "INSERT INTO subscribers (pubkey, status, expires_at, total_paid_sats, updated_at) " +
  "VALUES (@pubkey, @status, @expires_at, @total_paid_sats, unixepoch()) " +
  "ON CONFLICT(pubkey) DO UPDATE SET " +
  "status = excluded.status, expires_at = excluded.expires_at, " +
  "total_paid_sats = subscribers.total_paid_sats + excluded.total_paid_sats, updated_at = unixepoch()"
);
var getSubscriber = db.prepare("SELECT * FROM subscribers WHERE pubkey = ?");
var insertInvoice = db.prepare(
  "INSERT OR REPLACE INTO invoices (invoice_id, payment_hash, pubkey, amount_sats, bolt11, status) " +
  "VALUES (@invoice_id, @payment_hash, @pubkey, @amount_sats, @bolt11, 'pending')"
);
var getInvoice = db.prepare("SELECT * FROM invoices WHERE invoice_id = ?");
var getInvoiceByHash = db.prepare("SELECT * FROM invoices WHERE payment_hash = ?");
var markInvoicePaid = db.prepare("UPDATE invoices SET status = 'paid', paid_at = unixepoch() WHERE invoice_id = ?");
var getPendingInvoices = db.prepare("SELECT * FROM invoices WHERE status = 'pending' AND created_at > unixepoch() - 3600");

// Create a Lightning invoice via NWC
async function createLightningInvoice(amountSats, description) {
  if (!nwcClient) throw new Error("NWC not configured");
  var result = await nwcClient.makeInvoice({
    amount: amountSats * 1000, // NWC expects millisats
    description: description || "Twatter Pro"
  });
  return {
    invoice_id: result.payment_hash || crypto.randomBytes(16).toString("hex"),
    payment_hash: result.payment_hash || "",
    bolt11: result.invoice || result.payment_request || ""
  };
}

// Check invoice status via NWC
async function checkInvoiceStatus(paymentHash) {
  if (!nwcClient) return false;
  try {
    var result = await nwcClient.lookupInvoice({ payment_hash: paymentHash });
    return (result.settled_at != null && result.settled_at !== 0) || (typeof result.preimage === "string" && result.preimage.length > 10);
  } catch(e) {
    return false;
  }
}

// Helpers
function isValidPubkey(pubkey) {
  return typeof pubkey === "string" && /^[0-9a-f]{64}$/.test(pubkey);
}

function sendJSON(res, status, data) {
  var body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on("data", function(c) { chunks.push(c); });
    req.on("end", function() { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function activateProForPubkey(pubkey, amountSats) {
  var nowTs = Math.floor(Date.now() / 1000);
  var existing = getSubscriber.get(pubkey);
  var expiresAt;
  if (existing && existing.status === "active" && existing.expires_at > nowTs) {
    expiresAt = existing.expires_at + PRO_DURATION_DAYS * 86400;
  } else {
    expiresAt = nowTs + PRO_DURATION_DAYS * 86400;
  }
  upsertSubscriber.run({ pubkey: pubkey, status: "active", expires_at: expiresAt, total_paid_sats: amountSats });
  console.log("[payment] Pro activated: " + pubkey.slice(0, 16) + "... expires " + new Date(expiresAt * 1000).toISOString());
  return expiresAt;
}

// POST /checkout
async function handleCheckout(req, res) {
  var body;
  try {
    var raw = await readBody(req);
    body = JSON.parse(raw.toString());
  } catch(e) {
    return sendJSON(res, 400, { error: "Invalid JSON body" });
  }
  var pubkey = body.pubkey;
  if (!isValidPubkey(pubkey)) return sendJSON(res, 400, { error: "Invalid pubkey" });
  var existing = getSubscriber.get(pubkey);
  var nowTs = Math.floor(Date.now() / 1000);
  if (existing && existing.status === "active" && existing.expires_at > nowTs) {
    return sendJSON(res, 200, {
      alreadyPro: true, expiresAt: existing.expires_at,
      daysRemaining: Math.ceil((existing.expires_at - nowTs) / 86400)
    });
  }
  try {
    var priceSats = await getProPriceSats();
    var invoice = await createLightningInvoice(
      priceSats,
      "Twatter Pro " + PRO_DURATION_DAYS + " days for " + pubkey.slice(0, 8) + "..."
    );
    insertInvoice.run({
      invoice_id: invoice.invoice_id, payment_hash: invoice.payment_hash,
      pubkey: pubkey, amount_sats: priceSats, bolt11: invoice.bolt11
    });
    return sendJSON(res, 200, {
      charge_id: invoice.invoice_id, payment_hash: invoice.payment_hash,
      bolt11: invoice.bolt11, amount_sats: priceSats, price_usd: PRO_PRICE_USD, expires_in: 600
    });
  } catch(err) {
    console.error("[payment] Invoice creation error:", err.message);
    return sendJSON(res, 500, { error: "Failed to create Lightning invoice. Is Alby Hub running?" });
  }
}

// GET /pro/:pubkey
function handleProCheck(req, res, pubkey) {
  if (!isValidPubkey(pubkey)) return sendJSON(res, 400, { error: "Invalid pubkey" });
  var row = getSubscriber.get(pubkey);
  var nowTs = Math.floor(Date.now() / 1000);
  if (!row || row.status !== "active" || !row.expires_at) return sendJSON(res, 200, { isPro: false });
  if (row.expires_at < nowTs) {
    upsertSubscriber.run({ pubkey: pubkey, status: "expired", expires_at: row.expires_at, total_paid_sats: 0 });
    return sendJSON(res, 200, { isPro: false, expired: true });
  }
  return sendJSON(res, 200, {
    isPro: true, expiresAt: row.expires_at,
    daysRemaining: Math.ceil((row.expires_at - nowTs) / 86400)
  });
}

// GET /invoice/:id
async function handleInvoiceCheck(req, res, invoiceId) {
  var invoice = getInvoice.get(invoiceId) || getInvoiceByHash.get(invoiceId);
  if (!invoice) return sendJSON(res, 404, { error: "Invoice not found" });
  if (invoice.status === "paid") {
    var sub = getSubscriber.get(invoice.pubkey);
    return sendJSON(res, 200, { paid: true, pubkey: invoice.pubkey, expiresAt: sub ? sub.expires_at : null });
  }
  try {
    var paid = await checkInvoiceStatus(invoice.payment_hash || invoice.invoice_id);
    if (paid) {
      markInvoicePaid.run(invoice.invoice_id);
      var expiresAt = activateProForPubkey(invoice.pubkey, invoice.amount_sats);
      return sendJSON(res, 200, { paid: true, pubkey: invoice.pubkey, expiresAt: expiresAt });
    }
  } catch(err) {
    console.error("[payment] Invoice check error:", err.message);
  }
  return sendJSON(res, 200, { paid: false, pubkey: invoice.pubkey, amount_sats: invoice.amount_sats });
}

// ======================== ZAP ROUTING ========================

// Fetch LNURL data from a Lightning address
async function fetchLnurlData(lud16) {
  var parts = lud16.split("@");
  if (parts.length !== 2) throw new Error("Invalid Lightning address");
  var res = await fetch("https://" + parts[1] + "/.well-known/lnurlp/" + parts[0], { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("Failed to fetch LNURL data");
  return res.json();
}

// Get a bolt11 invoice from a recipient's LNURL
async function getRecipientInvoice(lnurlData, amountSats) {
  var amountMsats = amountSats * 1000;
  if (amountMsats < (lnurlData.minSendable || 1000) || amountMsats > (lnurlData.maxSendable || 1e12)) {
    throw new Error("Amount out of recipient's range");
  }
  var url = new URL(lnurlData.callback);
  url.searchParams.set("amount", String(amountMsats));
  var res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("Failed to get recipient invoice");
  var data = await res.json();
  if (!data.pr) throw new Error("No invoice in recipient response");
  return data.pr;
}

// POST /zap �� create a zap invoice that routes through Twatter
async function handleZap(req, res) {
  var body;
  try {
    var raw = await readBody(req);
    body = JSON.parse(raw.toString());
  } catch(e) {
    return sendJSON(res, 400, { error: "Invalid JSON body" });
  }

  var senderPubkey = body.sender_pubkey;
  var recipientLud16 = body.recipient_lud16;
  var amountSats = parseInt(body.amount_sats);

  if (!senderPubkey || !recipientLud16 || !amountSats || amountSats < 1) {
    return sendJSON(res, 400, { error: "Missing sender_pubkey, recipient_lud16, or amount_sats" });
  }

  var feeSats = Math.max(1, Math.round(amountSats * ZAP_FEE_PERCENT / 100));
  var payoutSats = amountSats - feeSats;

  if (payoutSats < 1) {
    return sendJSON(res, 400, { error: "Amount too small after fee" });
  }

  try {
    // Create invoice for the full amount (sender pays this to us)
    var invoice = await createLightningInvoice(
      amountSats,
      "Zap " + amountSats + " sats to " + recipientLud16 + " via Twatter"
    );

    var zapId = invoice.payment_hash || crypto.randomBytes(16).toString("hex");

    insertZap.run({
      id: zapId,
      sender_pubkey: senderPubkey,
      recipient_lud16: recipientLud16,
      total_sats: amountSats,
      fee_sats: feeSats,
      payout_sats: payoutSats,
      payment_hash: invoice.payment_hash,
      bolt11_in: invoice.bolt11
    });

    console.log("[zap] Created: " + amountSats + " sats to " + recipientLud16 + " (fee: " + feeSats + ", payout: " + payoutSats + ")");

    return sendJSON(res, 200, {
      zap_id: zapId,
      bolt11: invoice.bolt11,
      amount_sats: amountSats,
      fee_sats: feeSats,
      payout_sats: payoutSats,
      fee_percent: ZAP_FEE_PERCENT
    });
  } catch(err) {
    console.error("[zap] Invoice creation error:", err.message);
    return sendJSON(res, 500, { error: "Failed to create zap invoice" });
  }
}

// GET /zap/:id — check zap status
async function handleZapCheck(req, res, zapId) {
  var zap = getZap.get(zapId) || getZapByHash.get(zapId);
  if (!zap) return sendJSON(res, 404, { error: "Zap not found" });
  return sendJSON(res, 200, {
    zap_id: zap.id,
    status: zap.status,
    total_sats: zap.total_sats,
    fee_sats: zap.fee_sats,
    payout_sats: zap.payout_sats,
    recipient: zap.recipient_lud16
  });
}

// Process paid-in zaps — forward payment to recipient minus fee
async function processZapPayouts() {
  var paidIn = getPaidInZaps.all();
  for (var i = 0; i < paidIn.length; i++) {
    var zap = paidIn[i];
    try {
      var lnurlData = await fetchLnurlData(zap.recipient_lud16);
      var recipientInvoice = await getRecipientInvoice(lnurlData, zap.payout_sats);
      // Pay the recipient via NWC
      await nwcClient.payInvoice({ invoice: recipientInvoice });
      markZapComplete.run(zap.id);
      console.log("[zap] Payout complete: " + zap.payout_sats + " sats to " + zap.recipient_lud16 + " (kept " + zap.fee_sats + " fee)");
    } catch(e) {
      console.error("[zap] Payout failed for " + zap.id + ":", e.message);
      markZapFailed.run(zap.id);
    }
  }
}

// Poll pending zaps for payment, then process payouts
async function pollZaps() {
  // Check if pending zaps have been paid
  var pending = getPendingZaps.all();
  for (var i = 0; i < pending.length; i++) {
    try {
      var paid = await checkInvoiceStatus(pending[i].payment_hash);
      if (paid) {
        markZapPaidIn.run(pending[i].id);
        console.log("[zap] Paid in: " + pending[i].total_sats + " sats from " + pending[i].sender_pubkey.slice(0, 12) + "...");
      }
    } catch(e) {}
  }
  // Process any payouts
  await processZapPayouts();
}
setInterval(pollZaps, 15000);

// GET /zap-info — return fee info for client
function handleZapInfo(req, res) {
  sendJSON(res, 200, {
    fee_percent: ZAP_FEE_PERCENT,
    min_zap_sats: 10
  });
}

// GET /price — return current Pro price and BTC rate
async function handlePrice(req, res) {
  try {
    var btcPrice = await getBtcPriceUsd();
    var proSats = await getProPriceSats();
    return sendJSON(res, 200, {
      btc_usd: btcPrice,
      pro_price_usd: PRO_PRICE_USD,
      pro_price_sats: proSats,
      pro_duration_days: PRO_DURATION_DAYS,
      zap_fee_percent: ZAP_FEE_PERCENT
    });
  } catch(e) {
    return sendJSON(res, 500, { error: "Could not fetch price data" });
  }
}

// Poll pending invoices every 30s
async function pollPendingInvoices() {
  var pending = getPendingInvoices.all();
  for (var i = 0; i < pending.length; i++) {
    try {
      var paid = await checkInvoiceStatus(pending[i].payment_hash || pending[i].invoice_id);
      if (paid) {
        markInvoicePaid.run(pending[i].invoice_id);
        activateProForPubkey(pending[i].pubkey, pending[i].amount_sats);
      }
    } catch(e) {}
  }
}
setInterval(pollPendingInvoices, 30000);

// Expire old subscriptions every 5 min
function expireOldSubscriptions() {
  var nowTs = Math.floor(Date.now() / 1000);
  var result = db.prepare("UPDATE subscribers SET status = 'expired', updated_at = unixepoch() WHERE status = 'active' AND expires_at < ?").run(nowTs);
  if (result.changes > 0) console.log("[payment] Expired " + result.changes + " subscription(s)");
}
setInterval(expireOldSubscriptions, 300000);

// HTTP Server
var server = http.createServer(async function(req, res) {
  var url = new URL(req.url, "http://localhost:" + PORT);
  var method = req.method.toUpperCase();
  var pathname = url.pathname;
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }
  try {
    if (method === "GET" && pathname === "/health") {
      var active = db.prepare("SELECT COUNT(*) as n FROM subscribers WHERE status = 'active'").get();
      var pendingCount = db.prepare("SELECT COUNT(*) as n FROM invoices WHERE status = 'pending' AND created_at > unixepoch() - 3600").get();
      return sendJSON(res, 200, {
        ok: true, provider: "nwc", nwcConnected: !!nwcClient,
        proSubscribers: active.n, pendingInvoices: pendingCount.n,
        proPriceSats: PRO_PRICE_SATS, proDurationDays: PRO_DURATION_DAYS
      });
    }
    var proMatch = pathname.match(/^\/pro\/([^/]+)$/);
    if (method === "GET" && proMatch) return handleProCheck(req, res, proMatch[1]);
    var invMatch = pathname.match(/^\/invoice\/([^/]+)$/);
    if (method === "GET" && invMatch) return await handleInvoiceCheck(req, res, invMatch[1]);
    if (method === "POST" && pathname === "/checkout") return await handleCheckout(req, res);
    if (method === "POST" && pathname === "/zap") return await handleZap(req, res);
    var zapMatch = pathname.match(/^\/zap\/([^/]+)$/);
    if (method === "GET" && zapMatch) return await handleZapCheck(req, res, zapMatch[1]);
    if (method === "GET" && pathname === "/zap-info") return handleZapInfo(req, res);
    if (method === "GET" && pathname === "/price") return await handlePrice(req, res);
    return sendJSON(res, 404, { error: "Not found" });
  } catch(err) {
    console.error("[payment] Unhandled error:", err);
    return sendJSON(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, function() {
  console.log("[payment] Twatter Payment Server v4.0.0 (NWC) on port " + PORT);
  console.log("[payment] NWC: " + (nwcClient ? "connected" : "NOT configured"));
  console.log("[payment] Pro price: $" + PRO_PRICE_USD + " USD / " + PRO_DURATION_DAYS + " days" + (PRO_PRICE_SATS > 0 ? " (override: " + PRO_PRICE_SATS + " sats)" : " (dynamic)"));
  console.log("[payment] Zap fee: " + ZAP_FEE_PERCENT + "%");
  console.log("[payment] DB: " + DB_PATH);
  var count = db.prepare("SELECT COUNT(*) as n FROM subscribers WHERE status = 'active'").get();
  console.log("[payment] Active Pro subscribers: " + count.n);
});

server.on("error", function(err) { console.error("[payment] Server error:", err); process.exit(1); });
process.on("SIGTERM", function() { console.log("[payment] Shutting down..."); if (nwcClient) nwcClient.close(); db.close(); server.close(function() { process.exit(0); }); });
process.on("SIGINT", function() { console.log("[payment] Shutting down..."); if (nwcClient) nwcClient.close(); db.close(); server.close(function() { process.exit(0); }); });
