// ================================================================
// TWATTER — Nostr-powered decentralized social media
// ================================================================
// Setup:
//   npm create vite@latest twatter -- --template react
//   cd twatter && npm install nostr-tools
//   Replace src/App.jsx: import Twatter from './twatter'; export default Twatter;
//   npm run dev
// ================================================================

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import * as nip04 from "nostr-tools/nip04";
import * as nip19 from "nostr-tools/nip19";

import "./styles.css";
import { IcHome, IcGlobe, IcMail, IcUser, IcSettings, IcSearch, IcCompose, IcHeart, IcReply, IcZap, IcShare, IcImage, IcLink, IcSend, IcBack, IcClose, IcPlus, IcCheck, IcCopy, IcKey, IcClock, IcDot, IcStar, IcSignal, IcEye, IcEyeOff, IcFollow, IcFollowed, IcSliders, IcAt, IcTag, IcChevron } from "./icons.jsx";
import { Avatar, ProBadge, PostImage, Switch, Dial, PostBody, PostMeta, Tag, DaySeparator } from "./atoms.jsx";
import { FeedKitchen, defaultKitchenState, countDialDiff } from "./feedKitchen.jsx";
import { TweaksPanel, defaultTweaks } from "./tweaks.jsx";

// ======================== CONFIG ========================
const STORAGE_KEY = "twatter-nostr";
const DEFAULT_RELAYS = [
  "wss://relay.twatter.xyz",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://purplepag.es",
];
const FREE_POST_LIMIT = 300;
const PRO_POST_LIMIT = 2000;
const FETCH_LIMIT = 500;
const PAYMENT_SERVER = import.meta.env.VITE_PAYMENT_SERVER || "http://localhost:7779";
const ZAP_PRESETS = [21, 100, 500, 1000, 2100, 5000];

// ======================== HELPERS ========================
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => { const b = new Uint8Array(hex.length / 2); for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.substr(i, 2), 16); return b; };
const now = () => Math.floor(Date.now() / 1000);
const timeAgo = (ts) => { const s = Math.floor(Date.now() / 1000 - ts); if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`; };
const shortPk = (pk) => pk ? `${pk.slice(0, 8)}...${pk.slice(-4)}` : "";
const formatSats = (n) => n >= 1000000 ? `${(n/1000000).toFixed(1)}M` : n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n);

const store = {
  async get(key) { try { if (window.storage?.get) { const r = await window.storage.get(key); return r?.value ?? null; } return localStorage.getItem(key); } catch { return null; } },
  async set(key, val) { try { if (window.storage?.set) await window.storage.set(key, val); else localStorage.setItem(key, val); } catch {} },
  async del(key) { try { if (window.storage?.delete) await window.storage.delete(key); else localStorage.removeItem(key); } catch {} },
};

// ======================== NOSTR HELPERS ========================
function makeEvent(kind, content, tags, sk) { return finalizeEvent({ kind, created_at: now(), tags, content }, sk); }
function makePost(text, sk, imageUrl) { const tags = []; if (imageUrl) tags.push(["image", imageUrl]); return makeEvent(1, text, tags, sk); }
function makeProfile(profile, sk) { return makeEvent(0, JSON.stringify(profile), [], sk); }
function makeContacts(pubkeys, sk) { return makeEvent(3, "", pubkeys.map((pk) => ["p", pk]), sk); }
function makeReaction(eventId, eventPk, sk) { return makeEvent(7, "+", [["e", eventId], ["p", eventPk]], sk); }
async function makeDM(text, recipientPk, sk, imageUrl) { let content = text; if (imageUrl) content = content ? `${content}\n${imageUrl}` : imageUrl; return makeEvent(4, await nip04.encrypt(sk, recipientPk, content), [["p", recipientPk]], sk); }

function parseProfile(event) {
  try {
    const d = JSON.parse(event.content);
    return { name: d.name || "", about: d.about || "", picture: d.picture || "", nip05: d.nip05 || "", lud16: d.lud16 || "", pubkey: event.pubkey, created_at: event.created_at };
  } catch { return null; }
}
function getImageFromEvent(event) { const t = event.tags?.find((t) => t[0] === "image"); if (t) return t[1]; const m = event.content?.match(/https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?\S*)?/i); return m ? m[0] : null; }
function getTextWithoutImageUrl(event) { const img = getImageFromEvent(event); if (!img) return event.content; return event.content.replace(img, "").trim(); }

// ======================== ZAP HELPERS ========================
// Zaps now route through the Twatter payment server (2% fee)
async function createRoutedZap(senderPubkey, recipientLud16, amountSats) {
  const res = await fetch(`${PAYMENT_SERVER}/zap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender_pubkey: senderPubkey, recipient_lud16: recipientLud16, amount_sats: amountSats })
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || "Failed to create zap"); }
  return res.json();
}

async function fetchZapInfo() {
  try {
    const res = await fetch(`${PAYMENT_SERVER}/zap-info`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { fee_percent: 2, min_zap_sats: 10 };
    return res.json();
  } catch { return { fee_percent: 2, min_zap_sats: 10 }; }
}

async function fetchPriceInfo() {
  try {
    const res = await fetch(`${PAYMENT_SERVER}/price`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ======================== PRO STATUS ========================
async function checkProStatus(pubkey) {
  try {
    const res = await fetch(`${PAYMENT_SERVER}/pro/${pubkey}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.isPro === true;
  } catch { return false; }
}

// ======================== IMAGE ATTACH ========================
const ImageAttach = ({ image, onImage, onClear }) => {
  const fileRef = useRef(null);
  const [showUrl, setShowUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const handleFile = async (e) => { const file = e.target.files?.[0]; if (!file || !file.type.startsWith("image/") || file.size > 5*1024*1024) return; const reader = new FileReader(); reader.onload = () => onImage(reader.result); reader.readAsDataURL(file); if (fileRef.current) fileRef.current.value = ""; };
  const handleUrl = () => { const url = urlDraft.trim(); if (url && /^https?:\/\//i.test(url)) { onImage(url); setUrlDraft(""); setShowUrl(false); } };
  if (image) return (<div style={{ position: "relative", marginTop: 8, display: "inline-block" }}><img src={image} alt="" style={{ height: 60, borderRadius: 8, border: "1px solid var(--hairline-2)" }}/><button onClick={onClear} style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "var(--red)", border: "none", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}><IcClose/></button></div>);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
      <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }}/>
      <button onClick={() => fileRef.current?.click()} title="Upload image" className="iconbtn"><IcImage/></button>
      <button onClick={() => setShowUrl(!showUrl)} title="Image URL" className="iconbtn" style={{ color: showUrl ? "var(--accent)" : "var(--fg-faint)" }}><IcLink/></button>
      {showUrl && (<div style={{ display: "flex", gap: 4, flex: 1 }}><input className="input mono" placeholder="https://..." value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleUrl()} style={{ padding: "7px 10px", fontSize: 11 }}/><button onClick={handleUrl} className="btn primary sm">ADD</button></div>)}
    </div>
  );
};

// ======================== ZAP MODAL ========================
const ZapModal = ({ targetProfile, targetEvent, sk, pk, relays, onClose }) => {
  const [amount, setAmount] = useState(21);
  const [custom, setCustom] = useState("");
  const [status, setStatus] = useState("idle"); // idle | fetching | invoice | paying | success | error
  const [error, setError] = useState("");
  const [invoiceStr, setInvoiceStr] = useState("");
  const [invoiceCopied, setInvoiceCopied] = useState(false);
  const [zapFee, setZapFee] = useState({ fee_percent: 2, fee_sats: 0, payout_sats: 0 });
  const finalAmount = custom ? parseInt(custom) || 0 : amount;

  const doZap = async () => {
    const lud16 = targetProfile?.lud16;
    if (!lud16) { setError("This user hasn't set up a Lightning address yet."); setStatus("error"); return; }
    if (!finalAmount || finalAmount < 1) { setError("Enter a valid amount."); setStatus("error"); return; }
    try {
      setStatus("fetching");
      setError("");
      setInvoiceStr("");
      setInvoiceCopied(false);
      // Route through payment server
      const zapData = await createRoutedZap(pk, lud16, finalAmount);
      setZapFee({ fee_percent: zapData.fee_percent, fee_sats: zapData.fee_sats, payout_sats: zapData.payout_sats });
      setInvoiceStr(zapData.bolt11);
      setStatus("invoice");
      // Try WebLN auto-pay if available
      if (window.webln) {
        try {
          setStatus("paying");
          await window.webln.enable();
          await window.webln.sendPayment(zapData.bolt11);
          setStatus("success");
          setTimeout(onClose, 1800);
          return;
        } catch (e) {
          setStatus("invoice");
        }
      }
    } catch (e) {
      setError(e.message || "Failed to create zap");
      setStatus("error");
    }
  };

  const copyInvoice = () => {
    navigator.clipboard.writeText(invoiceStr).then(() => { setInvoiceCopied(true); setTimeout(() => setInvoiceCopied(false), 2000); }).catch(() => {});
  };

  const openInWallet = () => {
    window.open(`lightning:${invoiceStr}`, "_blank");
  };

  const statusMsg = { fetching: "Creating zap...", paying: "Waiting for wallet...", success: "⚡ Zapped!", error: "" };
  const feeSats = Math.max(1, Math.round(finalAmount * 2 / 100));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: "var(--surface)", border: "1px solid var(--hairline-2)", borderRadius: 14, padding: 24, width: 340, maxWidth: "90vw" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700, color: "var(--saffron)" }}>⚡ ZAP {targetProfile?.name || shortPk(targetProfile?.pubkey)}</span>
          <button onClick={onClose} className="iconbtn" style={{ color: "var(--fg-mute)" }}><IcClose/></button>
        </div>

        {/* Amount Selection (show when no invoice yet) */}
        {status !== "invoice" && status !== "success" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 12 }}>
              {ZAP_PRESETS.map((n) => (
                <button key={n} className="btn sm" onClick={() => { setAmount(n); setCustom(""); }} style={{ background: amount === n && !custom ? "var(--surface-3)" : "transparent", borderColor: amount === n && !custom ? "var(--saffron)" : "var(--hairline-2)", color: amount === n && !custom ? "var(--saffron)" : "var(--fg-dim)" }}>
                  ⚡ {formatSats(n)}
                </button>
              ))}
            </div>
            <input className="input mono" style={{ marginBottom: 8 }} type="number" placeholder="Custom amount (sats)" value={custom} onChange={(e) => setCustom(e.target.value)} min="1"/>
            {finalAmount > 0 && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)", marginBottom: 14, textAlign: "center" }}>
                {formatSats(finalAmount - feeSats)} to {targetProfile?.name || "recipient"} · {feeSats} sat fee (2%)
              </div>
            )}
          </>
        )}

        {/* Status messages */}
        {(status === "fetching" || status === "paying") && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--saffron)", textAlign: "center", marginBottom: 12, padding: "8px", background: "var(--surface-2)", borderRadius: 8 }}>{statusMsg[status]}</div>
        )}
        {status === "success" && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--green)", textAlign: "center", padding: "16px", background: "var(--surface-2)", borderRadius: 8 }}>⚡ Zapped {formatSats(zapFee.payout_sats)} sats!</div>
        )}
        {status === "error" && <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--red)", marginBottom: 12, lineHeight: 1.6, whiteSpace: "pre-line" }}>{error}</div>}

        {/* Invoice display */}
        {status === "invoice" && invoiceStr && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-faint)", marginBottom: 4, textAlign: "center" }}>Pay {formatSats(finalAmount)} sats with any Lightning wallet</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)", marginBottom: 8, textAlign: "center" }}>{formatSats(zapFee.payout_sats)} to {targetProfile?.name || "recipient"} · {zapFee.fee_sats} sat fee</div>
            <div style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)", borderRadius: 8, padding: 12, wordBreak: "break-all", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", maxHeight: 80, overflowY: "auto", lineHeight: 1.5, cursor: "pointer" }} onClick={copyInvoice} title="Click to copy">
              {invoiceStr}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button onClick={copyInvoice} className="btn" style={{ flex: 1, borderColor: invoiceCopied ? "var(--green)" : "var(--saffron)", color: invoiceCopied ? "var(--green)" : "var(--saffron)" }}>
                {invoiceCopied ? "COPIED!" : "COPY INVOICE"}
              </button>
              <button onClick={openInWallet} className="btn" style={{ flex: 1, borderColor: "var(--saffron)", color: "var(--saffron)" }}>
                OPEN WALLET
              </button>
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-mute)", textAlign: "center", marginTop: 8 }}>Copy and paste into your Lightning wallet, or tap "Open Wallet" to launch your wallet app.</div>
          </div>
        )}

        {/* Main action button */}
        {status !== "success" && status !== "invoice" && (
          <button onClick={doZap} disabled={["fetching","paying"].includes(status)} className="btn primary" style={{ width: "100%", opacity: ["fetching","paying"].includes(status) ? 0.5 : 1 }}>
            {["fetching","paying"].includes(status) ? "..." : `⚡ ZAP ${formatSats(finalAmount)} SATS`}
          </button>
        )}

        {/* Back to amount selection from invoice view */}
        {status === "invoice" && (
          <button onClick={() => { setStatus("idle"); setInvoiceStr(""); setInvoiceCopied(false); }} className="btn ghost" style={{ width: "100%", marginTop: 8 }}>
            CHANGE AMOUNT
          </button>
        )}

        {!targetProfile?.lud16 && status === "idle" && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)", marginTop: 8, textAlign: "center" }}>This user hasn't added a Lightning address to their profile.</div>
        )}
      </div>
    </div>
  );
};

// ======================== PRO UPGRADE MODAL (Lightning) ========================
const ProModal = ({ pk, onClose, onProActivated }) => {
  const [step, setStep] = useState("info"); // info | invoice | checking | success | error
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [priceInfo, setPriceInfo] = useState(null);
  const pollRef = useRef(null);

  // Fetch current price on mount
  useEffect(() => { fetchPriceInfo().then((info) => { if (info) setPriceInfo(info); }); }, []);

  const cleanup = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  const createInvoice = async () => {
    setStep("invoice");
    setError("");
    try {
      const res = await fetch(`${PAYMENT_SERVER}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey: pk }),
      });
      if (!res.ok) throw new Error("Failed to create invoice");
      const data = await res.json();
      if (data.alreadyPro) { setStep("success"); if (onProActivated) onProActivated(); return; }
      setInvoice(data);

      // Try WebLN auto-pay (Alby, etc.)
      if (window.webln) {
        try {
          await window.webln.enable();
          await window.webln.sendPayment(data.bolt11);
          cleanup();
          setStep("success");
          if (onProActivated) onProActivated();
          return;
        } catch {} // User declined or no WebLN — show manual invoice
      }

      // Poll for payment confirmation
      pollRef.current = setInterval(async () => {
        try {
          const check = await fetch(`${PAYMENT_SERVER}/invoice/${data.charge_id || data.payment_hash}`);
          const status = await check.json();
          if (status.paid) {
            cleanup();
            setStep("success");
            if (onProActivated) onProActivated();
          }
        } catch {}
      }, 3000);

      // Stop polling after 10 minutes
      setTimeout(() => { cleanup(); }, 600_000);
    } catch (e) {
      setError("Could not connect to payment server.");
      setStep("error");
    }
  };

  // Cleanup on unmount
  useEffect(() => cleanup, []);

  const copyInvoice = () => {
    if (invoice?.bolt11) {
      navigator.clipboard?.writeText(invoice.bolt11).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={(e) => { if (e.target === e.currentTarget) { cleanup(); onClose(); } }}>
      <div style={{ background: "var(--surface)", border: "1px solid var(--hairline-2)", borderRadius: 14, padding: 28, width: 380, maxWidth: "90vw", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={() => { cleanup(); onClose(); }} className="iconbtn" style={{ color: "var(--fg-mute)" }}><IcClose/></button>
        </div>

        {step === "info" && (
          <>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>⚡</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--fg)", marginBottom: 6 }}>Twatter Pro</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-mute)", lineHeight: 1.8 }}>Support decentralized social media.<br/>Pay with Bitcoin Lightning.</div>
            </div>
            <div style={{ background: "var(--surface-2)", borderRadius: 10, padding: 16, marginBottom: 20 }}>
              {[["⚡", "2,000 character posts (vs 300 free)"], ["🖼", "10GB media storage"], ["📊", "Creator analytics dashboard"], ["⏰", "Scheduled posts"], ["🔒", "Priority relay access"], ["✓", "Pro badge on your profile"]].map(([icon, text]) => (
                <div key={text} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)" }}>
                  <span>{icon}</span><span>{text}</span>
                </div>
              ))}
            </div>
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 24, fontWeight: 700, color: "var(--saffron)" }}>$5</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-mute)" }}> / 30 days</span>
              {priceInfo && <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-mute)", marginTop: 4 }}>≈ {formatSats(priceInfo.pro_price_sats)} sats at current rate</div>}
            </div>
            <button onClick={createInvoice} className="btn primary" style={{ width: "100%", marginBottom: 10 }}>⚡ PAY WITH LIGHTNING</button>
            <div style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)", lineHeight: 1.6 }}>
              If you have the Alby extension, payment is instant.<br/>Otherwise you'll get an invoice to pay from any Lightning wallet.
            </div>
          </>
        )}

        {step === "invoice" && invoice && (
          <>
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700, color: "var(--saffron)", marginBottom: 8 }}>⚡ Lightning Invoice</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-mute)" }}>Scan or copy this invoice to pay</div>
            </div>
            <div style={{ background: "#fff", borderRadius: 10, padding: 16, marginBottom: 16, textAlign: "center" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#333", wordBreak: "break-all", lineHeight: 1.5, maxHeight: 120, overflowY: "auto" }}>
                {invoice.bolt11}
              </div>
            </div>
            <button onClick={copyInvoice} className="btn" style={{ width: "100%", borderColor: "var(--accent)", color: "var(--accent)", marginBottom: 10 }}>
              {copied ? "COPIED!" : "COPY INVOICE"}
            </button>
            <div style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 11, color: "var(--saffron)", padding: 8 }}>
              <span className="pulse">Waiting for payment...</span>
            </div>
            <div style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)", marginTop: 4 }}>
              Pay {formatSats(invoice.amount_sats)} sats from any Lightning wallet.<br/>This page will update automatically.
            </div>
          </>
        )}

        {step === "invoice" && !invoice && (
          <div style={{ textAlign: "center", padding: 40, fontFamily: "var(--mono)", fontSize: 12, color: "var(--saffron)" }}>
            Creating Lightning invoice...
          </div>
        )}

        {step === "success" && (
          <div style={{ textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>⚡</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--accent)", marginBottom: 8 }}>You're Pro!</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-mute)", lineHeight: 1.8 }}>Payment confirmed. Welcome to Twatter Pro.<br/>Enjoy your upgraded experience.</div>
            <button onClick={() => { cleanup(); onClose(); }} className="btn primary" style={{ marginTop: 20 }}>LET'S GO</button>
          </div>
        )}

        {step === "error" && (
          <div style={{ textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>😕</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--red)", marginBottom: 12 }}>{error}</div>
            <button onClick={() => setStep("info")} className="btn" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>TRY AGAIN</button>
          </div>
        )}

        {step !== "info" && step !== "success" && (
          <button onClick={() => { cleanup(); onClose(); }} className="btn ghost" style={{ width: "100%", marginTop: 8 }}>Cancel</button>
        )}
      </div>
    </div>
  );
};

// ================================================================
// MAIN COMPONENT
// ================================================================
export default function Twatter() {
  // --- Auth ---
  const [sk, setSk] = useState(null);
  const [pk, setPk] = useState(null);
  const [setupDone, setSetupDone] = useState(false);
  const [importKey, setImportKey] = useState("");

  // --- Pro ---
  const [isPro, setIsPro] = useState(false);
  const [proProfiles, setProProfiles] = useState(new Set()); // other Pro users
  const [showProModal, setShowProModal] = useState(false);
  const POST_LIMIT = isPro ? PRO_POST_LIMIT : FREE_POST_LIMIT;

  // --- Relay ---
  const poolRef = useRef(null);
  const subsRef = useRef([]);
  const [relays, setRelays] = useState(DEFAULT_RELAYS);
  const [relayStatus, setRelayStatus] = useState("disconnected");
  const [newRelay, setNewRelay] = useState("");

  // --- Data ---
  const [profiles, setProfiles] = useState({});
  const [posts, setPosts] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [reactions, setReactions] = useState({});
  const [myReactions, setMyReactions] = useState(new Set());
  const [zaps, setZaps] = useState({}); // {eventId: {count, sats}}
  const [dmMessages, setDmMessages] = useState({});
  const [activeChat, setActiveChat] = useState(null);

  // --- UI ---
  const [view, setView] = useState("feed");
  const [profileId, setProfileId] = useState(null);
  const [draft, setDraft] = useState("");
  const [draftImage, setDraftImage] = useState(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [replyTo, setReplyTo] = useState(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [dmDraft, setDmDraft] = useState("");
  const [dmImage, setDmImage] = useState(null);
  const [newDmPk, setNewDmPk] = useState("");
  const [zapModal, setZapModal] = useState(null); // {profile, event} or null
  const chatEndRef = useRef(null);

  // --- Kitchen & Tweaks ---
  const [kitchen, setKitchen] = useState(defaultKitchenState());
  const [tweaks, setTweaks] = useState(defaultTweaks());
  const [showTweaks, setShowTweaks] = useState(false);
  const [showMobileKitchen, setShowMobileKitchen] = useState(false);

  // --- Search ---
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef(null);

  // --- Legal ---
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);

  // ======================== LOAD KEYS ========================
  useEffect(() => {
    (async () => {
      const saved = await store.get(STORAGE_KEY);
      if (saved) {
        try {
          const data = JSON.parse(saved);
          if (data.sk && data.pk) {
            const skBytes = fromHex(data.sk);
            setSk(skBytes); setPk(data.pk);
            if (data.relays?.length) setRelays(data.relays);
            setSetupDone(true);
            // Check Pro status
            checkProStatus(data.pk).then(setIsPro);
          }
        } catch {}
      }
      setLoading(false);
    })();
  }, []);

  useEffect(() => { if (sk && pk) store.set(STORAGE_KEY, JSON.stringify({ sk: toHex(sk), pk, relays })); }, [sk, pk, relays]);

  // ======================== CONNECT ========================
  const connectAndSubscribe = useCallback(() => {
    if (!pk || !sk) return;
    subsRef.current.forEach((s) => { try { s.close(); } catch {} });
    subsRef.current = [];
    if (!poolRef.current) poolRef.current = new SimplePool();
    const pool = poolRef.current;
    setRelayStatus("connecting");
    const seenPosts = new Set(), seenProfiles = new Set(), seenDMs = new Set();

    const handlePost = (event) => {
      if (seenPosts.has(event.id)) return; seenPosts.add(event.id);
      setPosts((prev) => { if (prev.some((p) => p.id === event.id)) return prev; return [...prev, event].sort((a, b) => b.created_at - a.created_at).slice(0, 1000); });
      if (!seenProfiles.has(event.pubkey)) fetchProfile(event.pubkey);
    };
    const handleProfile = (event) => {
      const profile = parseProfile(event); if (!profile) return;
      setProfiles((prev) => { const ex = prev[event.pubkey]; if (ex && ex.created_at >= event.created_at) return prev; return { ...prev, [event.pubkey]: profile }; });
      seenProfiles.add(event.pubkey);
    };
    const handleContacts = (event) => { if (event.pubkey !== pk) return; setContacts(event.tags.filter((t) => t[0] === "p").map((t) => t[1])); };
    const handleReaction = (event) => {
      const eTag = event.tags.find((t) => t[0] === "e"); if (!eTag) return;
      setReactions((prev) => { const s = new Set(prev[eTag[1]] || []); s.add(event.pubkey); return { ...prev, [eTag[1]]: s }; });
      if (event.pubkey === pk) setMyReactions((prev) => new Set([...prev, eTag[1]]));
    };
    const handleZap = (event) => {
      // NIP-57 zap receipt (kind 9735)
      const eTag = event.tags.find((t) => t[0] === "e"); if (!eTag) return;
      const bolt11Tag = event.tags.find((t) => t[0] === "bolt11");
      let sats = 0;
      if (bolt11Tag) { try { const amtTag = event.tags.find((t) => t[0] === "amount"); if (amtTag) sats = Math.floor(parseInt(amtTag[1]) / 1000); } catch {} }
      setZaps((prev) => { const cur = prev[eTag[1]] || { count: 0, sats: 0 }; return { ...prev, [eTag[1]]: { count: cur.count + 1, sats: cur.sats + sats } }; });
    };
    const handleDM = async (event) => {
      if (seenDMs.has(event.id)) return; seenDMs.add(event.id);
      const pTag = event.tags.find((t) => t[0] === "p"); if (!pTag) return;
      const isFromMe = event.pubkey === pk;
      const otherPk = isFromMe ? pTag[1] : event.pubkey;
      try {
        const decrypted = await nip04.decrypt(sk, otherPk, event.content);
        const urlMatch = decrypted.match(/https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?\S*)?/i);
        const image = urlMatch ? urlMatch[0] : null;
        const text = image ? decrypted.replace(image, "").trim() : decrypted;
        const msg = { id: event.id, from: event.pubkey, to: pTag[1], text, ts: event.created_at, image };
        setDmMessages((prev) => { const ex = prev[otherPk] || []; if (ex.some((m) => m.id === event.id)) return prev; return { ...prev, [otherPk]: [...ex, msg].sort((a, b) => a.ts - b.ts) }; });
        if (!seenProfiles.has(otherPk)) fetchProfile(otherPk);
      } catch {}
    };
    const fetchProfile = (pubkey) => {
      if (seenProfiles.has(pubkey)) return; seenProfiles.add(pubkey);
      pool.querySync(relays, { kinds: [0], authors: [pubkey], limit: 1 }).then((evs) => { if (evs[0]) handleProfile(evs[0]); }).catch(() => {});
    };

    // Initial fetch
    pool.querySync(relays, { kinds: [0], authors: [pk], limit: 1 }).then((evs) => { evs.forEach(handleProfile); setRelayStatus("connected"); }).catch(() => setRelayStatus("connected"));
    pool.querySync(relays, { kinds: [3], authors: [pk], limit: 1 }).then((evs) => { if (evs[0]) handleContacts(evs[0]); }).catch(() => {});

    // Subscriptions
    const s1 = pool.subscribeMany(relays, [{ kinds: [1], limit: FETCH_LIMIT }], { onevent: handlePost });
    const s2 = pool.subscribeMany(relays, [{ kinds: [0], limit: 200 }], { onevent: handleProfile });
    const s3 = pool.subscribeMany(relays, [{ kinds: [7], limit: 500 }], { onevent: handleReaction });
    const s4 = pool.subscribeMany(relays, [{ kinds: [9735], limit: 200 }], { onevent: handleZap });
    const s5 = pool.subscribeMany(relays, [{ kinds: [4], "#p": [pk], limit: 200 }], { onevent: handleDM });
    const s6 = pool.subscribeMany(relays, [{ kinds: [4], authors: [pk], limit: 200 }], { onevent: handleDM });
    const s7 = pool.subscribeMany(relays, [{ kinds: [3], authors: [pk], limit: 1 }], { onevent: handleContacts });
    subsRef.current = [s1, s2, s3, s4, s5, s6, s7];
  }, [pk, sk, relays]);

  useEffect(() => { if (setupDone && pk && sk) connectAndSubscribe(); return () => { subsRef.current.forEach((s) => { try { s.close(); } catch {} }); }; }, [setupDone, connectAndSubscribe]);
  useEffect(() => { if (activeChat && chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: "smooth" }); }, [activeChat, dmMessages]);

  // ======================== ACTIONS ========================
  const publish = async (event) => { if (!poolRef.current) return; try { await Promise.any(poolRef.current.publish(relays, event)); } catch {} };

  const createPost = async () => {
    if ((!draft.trim() && !draftImage) || draft.length > POST_LIMIT || !sk) return;
    let text = draft.trim();
    if (draftImage && /^https?:\/\//i.test(draftImage)) text = text ? `${text}\n${draftImage}` : draftImage;
    const event = makePost(text, sk, draftImage);
    await publish(event);
    setPosts((prev) => [event, ...prev].sort((a, b) => b.created_at - a.created_at));
    setDraft(""); setDraftImage(null);
  };
  const toggleLike = async (postEvent) => { if (!sk || myReactions.has(postEvent.id)) return; const event = makeReaction(postEvent.id, postEvent.pubkey, sk); await publish(event); setReactions((prev) => { const s = new Set(prev[postEvent.id] || []); s.add(pk); return { ...prev, [postEvent.id]: s }; }); setMyReactions((prev) => new Set([...prev, postEvent.id])); };
  const addReply = async (parentEvent) => { if (!replyDraft.trim() || !sk) return; const event = makeEvent(1, replyDraft.trim(), [["e", parentEvent.id], ["p", parentEvent.pubkey]], sk); await publish(event); setPosts((prev) => [event, ...prev].sort((a, b) => b.created_at - a.created_at)); setReplyDraft(""); setReplyTo(null); };
  const toggleFollow = async (targetPk) => { if (!sk) return; const newC = contacts.includes(targetPk) ? contacts.filter((c) => c !== targetPk) : [...contacts, targetPk]; await publish(makeContacts(newC, sk)); setContacts(newC); };
  const updateProfile = async (profileData) => { if (!sk) return; await publish(makeProfile(profileData, sk)); setProfiles((prev) => ({ ...prev, [pk]: { ...profileData, pubkey: pk, created_at: now() } })); };
  const sendDM = async () => { if ((!dmDraft.trim() && !dmImage) || !activeChat || !sk) return; const event = await makeDM(dmDraft.trim(), activeChat, sk, dmImage); await publish(event); setDmMessages((prev) => ({ ...prev, [activeChat]: [...(prev[activeChat] || []), { id: event.id, from: pk, to: activeChat, text: dmDraft.trim(), ts: event.created_at, image: dmImage }].sort((a, b) => a.ts - b.ts) })); setDmDraft(""); setDmImage(null); };
  const openProfile = (pubkey) => { setProfileId(pubkey); setView("profile"); };
  const copyToClipboard = (text) => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); };
  const startNewDM = () => { let target = newDmPk.trim(); try { if (target.startsWith("npub")) { const d = nip19.decode(target); if (d.type === "npub") target = d.data; } } catch {} if (target && /^[0-9a-f]{64}$/i.test(target)) { setActiveChat(target); setNewDmPk(""); if (poolRef.current && !profiles[target]) poolRef.current.querySync(relays, { kinds: [0], authors: [target], limit: 1 }).then((evs) => { if (evs[0]) { const p = parseProfile(evs[0]); if (p) setProfiles((prev) => ({ ...prev, [target]: p })); } }).catch(() => {}); } };
  const generateKeys = () => { const newSk = generateSecretKey(); const newPk = getPublicKey(newSk); setSk(newSk); setPk(newPk); setSetupDone(true); };
  const importKeys = () => { let key = importKey.trim(); try { if (key.startsWith("nsec")) { const d = nip19.decode(key); if (d.type === "nsec") key = toHex(d.data); } if (/^[0-9a-f]{64}$/i.test(key)) { const skBytes = fromHex(key); const newPk = getPublicKey(skBytes); setSk(skBytes); setPk(newPk); setSetupDone(true); setImportKey(""); checkProStatus(newPk).then(setIsPro); } } catch {} };
  const logout = async () => { subsRef.current.forEach((s) => { try { s.close(); } catch {} }); subsRef.current = []; if (poolRef.current) { try { poolRef.current.close(relays); } catch {} poolRef.current = null; } setSk(null); setPk(null); setSetupDone(false); setPosts([]); setProfiles({}); setContacts([]); setReactions({}); setMyReactions(new Set()); setZaps({}); setDmMessages({}); setView("feed"); setIsPro(false); await store.del(STORAGE_KEY); };

  // ======================== SEARCH ========================
  const doSearch = useCallback((query) => {
    if (!query.trim()) { setSearchResults([]); setSearching(false); return; }
    const pool = poolRef.current;
    if (!pool) return;

    // Check if it's an npub or hex pubkey — direct lookup
    let directPk = null;
    try {
      const q = query.trim();
      if (q.startsWith("npub")) { const d = nip19.decode(q); if (d.type === "npub") directPk = d.data; }
      else if (/^[0-9a-f]{64}$/i.test(q)) directPk = q;
    } catch {}

    if (directPk) {
      setSearching(true);
      pool.querySync(relays, { kinds: [0], authors: [directPk], limit: 1 }).then((evs) => {
        if (evs[0]) {
          const p = parseProfile(evs[0]);
          if (p) {
            setProfiles((prev) => ({ ...prev, [directPk]: p }));
            setSearchResults([p]);
          }
        } else { setSearchResults([]); }
        setSearching(false);
      }).catch(() => setSearching(false));
      return;
    }

    // Local search first — filter cached profiles
    const q = query.toLowerCase();
    const local = Object.values(profiles).filter((p) =>
      p.name?.toLowerCase().includes(q) || p.nip05?.toLowerCase().includes(q) || p.about?.toLowerCase().includes(q)
    ).slice(0, 30);
    setSearchResults(local);

    // Then query relays for more profiles (fetch a batch and filter client-side)
    setSearching(true);
    pool.querySync(relays, { kinds: [0], limit: 500 }).then((evs) => {
      const found = new Map();
      // Add local results first
      local.forEach((p) => found.set(p.pubkey, p));
      // Parse and filter relay results
      evs.forEach((ev) => {
        if (found.has(ev.pubkey)) return;
        const p = parseProfile(ev);
        if (p && (p.name?.toLowerCase().includes(q) || p.nip05?.toLowerCase().includes(q) || p.about?.toLowerCase().includes(q))) {
          found.set(p.pubkey, p);
          setProfiles((prev) => {
            const ex = prev[ev.pubkey];
            if (ex && ex.created_at >= ev.created_at) return prev;
            return { ...prev, [ev.pubkey]: p };
          });
        }
      });
      setSearchResults(Array.from(found.values()).slice(0, 30));
      setSearching(false);
    }).catch(() => setSearching(false));
  }, [relays, profiles]);

  // Debounced search trigger
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!search.trim()) { setSearchResults([]); setSearching(false); return; }
    // Immediate local filter
    const q = search.toLowerCase();
    const local = Object.values(profiles).filter((p) =>
      p.name?.toLowerCase().includes(q) || p.nip05?.toLowerCase().includes(q)
    ).slice(0, 20);
    setSearchResults(local);
    // Debounced relay query
    searchTimerRef.current = setTimeout(() => doSearch(search), 400);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [search, doSearch]);

  // ======================== DERIVED DATA ========================
  const myProfile = profiles[pk] || {};
  const feedPosts = useMemo(() => posts.filter((p) => contacts.includes(p.pubkey) || p.pubkey === pk), [posts, contacts, pk]);
  const explorePosts = useMemo(() => posts.filter((p) => !p.tags?.some((t) => t[0] === "e")).slice(0, 300), [posts]);
  const getProfilePosts = useCallback((pubkey) => posts.filter((p) => p.pubkey === pubkey), [posts]);
  const getReplies = useCallback((postId) => posts.filter((p) => p.tags?.some((t) => t[0] === "e" && t[1] === postId)), [posts]);
  const dmConversations = useMemo(() => Object.entries(dmMessages).map(([pubkey, msgs]) => ({ pubkey, messages: msgs, lastMessage: msgs[msgs.length - 1], profile: profiles[pubkey] })).sort((a, b) => (b.lastMessage?.ts || 0) - (a.lastMessage?.ts || 0)), [dmMessages, profiles]);

  // ======================== POST COMPONENT ========================
  const Post = ({ event }) => {
    const profile = profiles[event.pubkey];
    const liked = myReactions.has(event.id);
    const likeCount = reactions[event.id]?.size || 0;
    const replies = getReplies(event.id);
    const image = getImageFromEvent(event);
    const text = getTextWithoutImageUrl(event);
    const isReply = event.tags?.some((t) => t[0] === "e");
    const zapData = zaps[event.id];
    const authorIsPro = proProfiles.has(event.pubkey) || (event.pubkey === pk && isPro);
    if (isReply) return null;
    return (
      <div className="post">
        <div className="post-header">
          <Avatar profile={profile} size={40} isPro={authorIsPro} onClick={() => openProfile(event.pubkey)}/>
          <PostMeta profile={profile} ts={event.created_at} isPro={authorIsPro} onProfile={() => openProfile(event.pubkey)} timeAgo={timeAgo}/>
        </div>
        {text && <PostBody text={text} density={tweaks.density}/>}
        <PostImage src={image}/>
        <div className="post-actions">
          <button onClick={() => toggleLike(event)} className="iconbtn" style={{ color: liked ? "var(--accent)" : "var(--fg-faint)" }}><IcHeart filled={liked} size={16}/> {likeCount ? <span style={{ fontSize: 11, marginLeft: 4 }}>{likeCount}</span> : ""}</button>
          <button onClick={() => { setReplyTo(replyTo === event.id ? null : event.id); setReplyDraft(""); }} className="iconbtn" style={{ color: replyTo === event.id ? "var(--accent)" : "var(--fg-faint)" }}><IcReply size={16}/> {replies.length ? <span style={{ fontSize: 11, marginLeft: 4 }}>{replies.length}</span> : ""}</button>
          <button onClick={() => setZapModal({ profile, event })} className="iconbtn" style={{ color: zapData ? "var(--saffron)" : "var(--fg-faint)" }}>
            <IcZap filled={!!zapData} size={16}/>
            {zapData && <span style={{ fontSize: 11, marginLeft: 4 }}>{formatSats(zapData.sats)} <span style={{ color: "var(--fg-mute)" }}>({zapData.count})</span></span>}
          </button>
        </div>
        {replies.map((r) => { const rp = profiles[r.pubkey]; return (<div key={r.id} className="thread-line"><div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><Avatar profile={rp} size={28} onClick={() => openProfile(r.pubkey)}/><span className="post-name" style={{ cursor: "pointer" }} onClick={() => openProfile(r.pubkey)}>{rp?.name || shortPk(r.pubkey)}</span><span className="post-time">{timeAgo(r.created_at)}</span></div><PostBody text={r.content} density={tweaks.density}/></div>); })}
        {replyTo === event.id && (<div style={{ marginTop: 8, marginLeft: 40 }}><input className="input" placeholder="Reply..." value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addReply(event)} autoFocus/></div>)}
      </div>
    );
  };

  // ======================== RENDER ========================
  if (loading) return <div style={{ fontFamily: "var(--mono)", color: "var(--fg-mute)", display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg)" }}>Loading...</div>;

  if (!setupDone) return (
    <div style={{ fontFamily: "var(--serif)", minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", maxWidth: 480, margin: "0 auto", padding: "0 20px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <div style={{ fontSize: 36, fontWeight: 700, fontFamily: "var(--mono)", marginBottom: 8 }}>twat<span style={{ color: "var(--accent)" }}>ter</span></div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-mute)", lineHeight: 1.8 }}>Decentralized. No servers. No algorithms.<br/>Your keys, your identity, your data.</div>
      </div>
      <button onClick={generateKeys} className="btn primary" style={{ width: "100%", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px" }}><IcKey size={16}/> GENERATE NEW IDENTITY</button>
      <div style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-mute)", margin: "20px 0 16px" }}>— or import existing Nostr key —</div>
      <input className="input" style={{ marginBottom: 10, fontFamily: "var(--mono)" }} placeholder="nsec1... or hex private key" value={importKey} onChange={(e) => setImportKey(e.target.value)}/>
      <button onClick={importKeys} className="btn" style={{ width: "100%", borderColor: importKey.trim() ? "var(--accent)" : "var(--hairline-2)", color: importKey.trim() ? "var(--accent)" : "var(--fg-dim)" }}>IMPORT KEY</button>
    </div>
  );

  return (
    <div className="app-grid" style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", display: "grid", gridTemplateColumns: tweaks.showKitchen && view === "feed" ? "220px 1fr 280px" : "220px 1fr", gridTemplateRows: "1fr" }}>
      {/* Modals */}
      {zapModal && <ZapModal targetProfile={zapModal.profile} targetEvent={zapModal.event} sk={sk} pk={pk} relays={relays} onClose={() => setZapModal(null)}/>}
      {showProModal && <ProModal pk={pk} onClose={() => setShowProModal(false)} onProActivated={() => setIsPro(true)}/>}

      {/* LEFT SIDEBAR */}
      <div className="desktop-sidebar" style={{ background: "var(--surface)", borderRight: "1px solid var(--hairline)", display: "flex", flexDirection: "column", height: "100vh", overflowY: "auto", padding: "20px 16px" }}>
        <div style={{ marginBottom: 32, cursor: "pointer" }} onClick={() => { setView("feed"); setProfileId(null); setActiveChat(null); }}>
          <div style={{ fontFamily: "var(--serif)", fontSize: 22, fontWeight: 700, marginBottom: 4, letterSpacing: "-0.5px" }}>twat<span style={{ color: "var(--accent)" }}>ter</span></div>
          <div className="eyebrow" style={{ fontSize: 8 }}>NO ALGORITHM · EST.2026</div>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 32 }}>
          {[["feed", <IcHome size={16}/>, "Feed"], ["explore", <IcGlobe size={16}/>, "Explore"], ["dms", <IcMail size={16}/>, "Messages"], ["profile", <IcUser size={16}/>, "Profile"], ["settings", <IcSettings size={16}/>, "Settings"]].map(([v, icon, label]) => {
            const isActive = v === "profile" ? (view === "profile" && profileId === pk) : view === v;
            return (<button key={v} onClick={() => { if (v === "profile") { setProfileId(pk); setView("profile"); } else if (v === "dms") { setView("dms"); setActiveChat(null); } else setView(v); }} className="btn ghost" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: isActive ? "var(--surface-2)" : "transparent", borderColor: isActive ? "var(--accent)" : "var(--hairline-2)", color: isActive ? "var(--accent)" : "var(--fg-dim)", width: "100%", justifyContent: "flex-start" }}>{icon} <span style={{ fontSize: 13 }}>{label}</span></button>);
          })}
        </nav>

        <button onClick={createPost} className="btn primary" style={{ width: "100%", marginBottom: 32, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px" }}><IcCompose size={16}/> Compose</button>

        <div style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)", borderRadius: 10, padding: 12, marginBottom: 16, fontSize: 12 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Relays</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <IcDot color={relayStatus === "connected" ? "var(--green)" : relayStatus === "connecting" ? "var(--saffron)" : "var(--red)"} size={6} />
            <span style={{ color: "var(--fg-dim)" }}>{relayStatus === "connected" ? `${relays.length} relays` : "connecting..."}</span>
          </div>
          <div style={{ color: "var(--fg-faint)", fontSize: 10 }}>{posts.length} posts seen</div>
        </div>

        {!isPro && (
          <button onClick={() => setShowProModal(true)} className="btn" style={{ width: "100%", borderColor: "var(--accent)", color: "var(--accent)", marginBottom: 16 }}>⭐ UPGRADE PRO</button>
        )}

        <div style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid var(--hairline)", fontSize: 11 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>YOU</div>
          <Avatar profile={myProfile} size={36} onClick={() => { setProfileId(pk); setView("profile"); }} isPro={isPro}/>
          <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>{myProfile?.name || shortPk(pk)}</div>
          {isPro && <ProBadge/>}
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="main-content" style={{ overflowY: "auto", display: "flex", flexDirection: "column", height: "100vh" }}>
        {/* Feed View */}
        {view === "feed" && (
          <div style={{ flex: 1, padding: "16px 20px" }}>
            <div style={{ marginBottom: 24, paddingBottom: 12, borderBottom: "1px solid var(--hairline)" }}>
              <div className="section-title" style={{ marginBottom: 12 }}>Following <span className="line"/></div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className="chip saffron">LIVE</div>
                <span className="eyebrow">Strictly chronological · no algorithm</span>
              </div>
            </div>

            <div style={{ background: "var(--surface)", border: "1px solid var(--hairline-2)", borderRadius: 10, padding: 14, marginBottom: 20 }}>
              <textarea className="input" placeholder="What's on your mind?" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ resize: "none", minHeight: 80, marginBottom: 10 }}/>
              <ImageAttach image={draftImage} onImage={setDraftImage} onClear={() => setDraftImage(null)}/>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
                <span className="eyebrow" style={{ color: draft.length > POST_LIMIT * 0.9 ? "var(--red)" : "var(--fg-mute)" }}>{draft.length}/{POST_LIMIT}{!isPro && <span style={{ color: "var(--fg-mute)" }}> · <span style={{ cursor: "pointer", color: "var(--accent)" }} onClick={() => setShowProModal(true)}>Pro = {PRO_POST_LIMIT}</span></span>}</span>
                <button onClick={createPost} className="btn primary sm" disabled={!(draft.trim() || draftImage) || draft.length > POST_LIMIT}>POST</button>
              </div>
            </div>

            {feedPosts.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--fg-mute)", fontSize: 13, lineHeight: 1.8 }}>Your feed is empty.<br/>Follow people from Explore to see their posts.<br/>No algorithms. Just time.</div>
            ) : (
              feedPosts.map((e, i) => (
                <div key={e.id}>
                  {i > 0 && feedPosts[i - 1].created_at !== e.created_at && Math.floor(feedPosts[i - 1].created_at / 86400) !== Math.floor(e.created_at / 86400) && <DaySeparator ts={e.created_at}/>}
                  <Post event={e}/>
                </div>
              ))
            )}
          </div>
        )}

        {/* Explore View */}
        {view === "explore" && (
          <div style={{ flex: 1, padding: "16px 20px" }}>
            <div style={{ marginBottom: 20, position: "relative" }}>
              <input className="input" placeholder="Search by name, npub, or nip-05..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingRight: 36 }}/>
              <IcSearch size={14} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "var(--fg-mute)", pointerEvents: "none" }}/>
            </div>
            {search && (
              <>
                {searching && <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-mute)", padding: "8px 0" }}>Searching relays...</div>}
                {searchResults.length === 0 && !searching && <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-mute)", padding: "8px 0" }}>No profiles found.</div>}
                {searchResults.map((p) => (
                  <div key={p.pubkey} onClick={() => { openProfile(p.pubkey); setSearch(""); }} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--hairline)", cursor: "pointer" }}>
                    <Avatar profile={p} size={40} isPro={proProfiles.has(p.pubkey)}/>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="post-name">{p.name || shortPk(p.pubkey)}</span>
                        {proProfiles.has(p.pubkey) && <ProBadge/>}
                      </div>
                      <div className="post-handle">@{p.nip05 || shortPk(p.pubkey)}</div>
                      {p.about && <div style={{ fontSize: 12, color: "var(--fg-mute)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.about.slice(0, 80)}{p.about.length > 80 ? "..." : ""}</div>}
                    </div>
                  </div>
                ))}
              </>
            )}
            <div className="section-title" style={{ marginTop: 24 }}>Global Feed <span style={{ marginLeft: 6, color: "var(--fg-mute)" }}>({explorePosts.length})</span> <span className="line"/></div>
            {explorePosts.map((e, i) => (
              <div key={e.id}>
                {i > 0 && explorePosts[i - 1].created_at !== e.created_at && Math.floor(explorePosts[i - 1].created_at / 86400) !== Math.floor(e.created_at / 86400) && <DaySeparator ts={e.created_at}/>}
                <Post event={e}/>
              </div>
            ))}
          </div>
        )}

        {/* Messages List */}
        {view === "dms" && !activeChat && (
          <div style={{ flex: 1, padding: "16px 20px", display: "flex", flexDirection: "column" }}>
            <div className="section-title" style={{ marginBottom: 12 }}>Direct Messages <span className="line"/></div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input className="input" placeholder="npub1... or hex pubkey" value={newDmPk} onChange={(e) => setNewDmPk(e.target.value)} onKeyDown={(e) => e.key === "Enter" && startNewDM()}/>
              <button onClick={startNewDM} className="btn primary sm">NEW</button>
            </div>
            {dmConversations.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--fg-mute)", fontSize: 13, lineHeight: 1.8 }}>No messages yet.<br/>Paste someone's npub above to start a conversation.</div>
            ) : (
              dmConversations.map((c) => (
                <div key={c.pubkey} onClick={() => setActiveChat(c.pubkey)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", borderBottom: "1px solid var(--hairline)", cursor: "pointer" }}>
                  <Avatar profile={c.profile} size={44}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="post-name">{c.profile?.name || shortPk(c.pubkey)}</div>
                    <div className="post-handle" style={{ marginTop: 2 }}>{c.lastMessage?.image && !c.lastMessage?.text ? "sent an image" : c.lastMessage?.text || ""}</div>
                  </div>
                  {c.lastMessage && <span className="eyebrow" style={{ flexShrink: 0 }}>{timeAgo(c.lastMessage.ts)}</span>}
                </div>
              ))
            )}
          </div>
        )}

        {/* Messages Chat */}
        {view === "dms" && activeChat && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "16px 20px", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 12, borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
              <button onClick={() => setActiveChat(null)} className="iconbtn"><IcBack size={16}/></button>
              <Avatar profile={profiles[activeChat]} size={36} onClick={() => openProfile(activeChat)}/>
              <div>
                <div className="post-name" style={{ cursor: "pointer" }} onClick={() => openProfile(activeChat)}>{profiles[activeChat]?.name || shortPk(activeChat)}</div>
                <div className="post-handle">{shortPk(activeChat)}</div>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {(dmMessages[activeChat] || []).map((msg) => { const isMe = msg.from === pk; return (<div key={msg.id} style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start", marginBottom: 12 }}><div style={{ maxWidth: "75%", background: isMe ? "var(--surface-3)" : "var(--surface)", border: `1px solid ${isMe?"var(--accent)":"var(--hairline-2)"}`, borderRadius: 14, borderTopRightRadius: isMe ? 4 : 14, borderTopLeftRadius: isMe ? 14 : 4, padding: msg.text ? "10px 14px" : "4px", overflow: "hidden" }}>{msg.image && <img src={msg.image} alt="" style={{ maxWidth: "100%", maxHeight: 250, borderRadius: msg.text ? "8px 8px 0 0" : 10, display: "block", marginBottom: msg.text ? 6 : 0 }}/>}{msg.text && <div style={{ fontSize: 14, lineHeight: 1.5, color: "var(--fg)", wordBreak: "break-word" }}>{msg.text}</div>}</div><span className="eyebrow" style={{ marginTop: 3 }}>{timeAgo(msg.ts)}</span></div>); })}
              <div ref={chatEndRef}/>
            </div>
            <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              <ImageAttach image={dmImage} onImage={setDmImage} onClear={() => setDmImage(null)}/>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <input className="input" placeholder="Message..." value={dmDraft} onChange={(e) => setDmDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendDM())} style={{ flex: 1 }}/>
                <button onClick={sendDM} className="btn primary sm" style={{ padding: "10px", width: "40px", height: "40px" }}><IcSend size={14}/></button>
              </div>
            </div>
          </div>
        )}

        {/* Profile View */}
        {view === "profile" && (() => {
          const p = profiles[profileId] || {};
          const isMe = profileId === pk;
          const isFollowing = contacts.includes(profileId);
          const pPosts = getProfilePosts(profileId);
          const profileIsPro = proProfiles.has(profileId) || (profileId === pk && isPro);
          return (
            <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>
              <div style={{ paddingBottom: 16, borderBottom: "1px solid var(--hairline)", textAlign: "center", marginBottom: 24 }}>
                <Avatar profile={p} size={72} isPro={profileIsPro}/>
                <div style={{ fontSize: 22, fontWeight: 700, marginTop: 12, color: "var(--fg)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>{p.name || shortPk(profileId)}{profileIsPro && <ProBadge/>}</div>
                <div className="post-handle" style={{ marginTop: 4 }}>@{p.nip05 || shortPk(profileId)}</div>
                {p.about && <div style={{ fontSize: 14, color: "var(--fg-dim)", marginTop: 10, maxWidth: 400, margin: "10px auto 0", lineHeight: 1.5 }}>{p.about}</div>}
                {p.lud16 && <div className="chip saffron" style={{ marginTop: 10, justifyContent: "center", width: "fit-content", margin: "10px auto 0" }}>⚡ {p.lud16}</div>}
                <div style={{ display: "flex", justifyContent: "center", gap: 32, marginTop: 16 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 700, color: "var(--fg)" }}>{pPosts.length}</div>
                    <div className="eyebrow">Posts</div>
                  </div>
                </div>
                <div onClick={() => copyToClipboard(nip19.npubEncode(profileId))} className="chip" style={{ marginTop: 12, cursor: "pointer", justifyContent: "center", width: "fit-content", margin: "12px auto 0" }}>
                  {nip19.npubEncode(profileId).slice(0, 20)}... <IcCopy size={10}/>{copied && <span style={{ color: "var(--accent)", marginLeft: 4 }}>copied!</span>}
                </div>
                {!isMe && (
                  <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
                    <button onClick={() => toggleFollow(profileId)} className="btn" style={{ borderColor: isFollowing ? "var(--accent)" : "var(--hairline-2)", color: isFollowing ? "var(--accent)" : "var(--fg-dim)" }}>{isFollowing ? "FOLLOWING" : "FOLLOW"}</button>
                    <button onClick={() => { setActiveChat(profileId); setView("dms"); }} className="btn" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>MESSAGE</button>
                    {p.lud16 && <button onClick={() => setZapModal({ profile: p, event: null })} className="btn" style={{ borderColor: "var(--saffron)", color: "var(--saffron)" }}>⚡ ZAP</button>}
                  </div>
                )}
                {isMe && !isPro && <button onClick={() => setShowProModal(true)} className="btn" style={{ marginTop: 14, borderColor: "var(--accent)", color: "var(--accent)" }}>⭐ UPGRADE</button>}
              </div>
              <div className="section-title">{isMe ? "Your" : `${p.name || "Their"}`} Posts <span className="line"/></div>
              {pPosts.length === 0 ? <div style={{ textAlign: "center", padding: "40px", color: "var(--fg-mute)", fontSize: 13 }}>No posts yet.</div> : pPosts.map((e, i) => (
                <div key={e.id}>
                  {i > 0 && pPosts[i - 1].created_at !== e.created_at && Math.floor(pPosts[i - 1].created_at / 86400) !== Math.floor(e.created_at / 86400) && <DaySeparator ts={e.created_at}/>}
                  <Post event={e}/>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Settings View */}
        {view === "settings" && (
          <div style={{ flex: 1, padding: "16px 20px", overflowY: "auto" }}>
            {isPro ? (
              <div style={{ background: "var(--surface-2)", border: "1px solid var(--accent)", borderRadius: 10, padding: "16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>⭐</span>
                <div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>Twatter Pro — Active</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)", marginTop: 2 }}>2,000 char posts · Priority relay · Creator tools</div>
                </div>
              </div>
            ) : (
              <div onClick={() => setShowProModal(true)} style={{ background: "var(--surface)", border: "1px dashed var(--accent)", borderRadius: 10, padding: "16px", marginBottom: 20, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>⭐</span>
                <div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>Upgrade to Twatter Pro</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)", marginTop: 2 }}>$5 / 30 days · Pay with Lightning</div>
                </div>
              </div>
            )}

            <div className="section-title">Identity <span className="line"/></div>
            {[["Display Name", myProfile.name||"", (v) => updateProfile({...myProfile,name:v})], ["About", myProfile.about||"", (v) => updateProfile({...myProfile,about:v})], ["Picture URL", myProfile.picture||"", (v) => updateProfile({...myProfile,picture:v})], ["NIP-05", myProfile.nip05||"", (v) => updateProfile({...myProfile,nip05:v})], ["⚡ Lightning", myProfile.lud16||"", (v) => updateProfile({...myProfile,lud16:v})]].map(([label,val,onBlur]) => (
              <div key={label} style={{ marginBottom: 12 }}>
                <label className="eyebrow" style={{ marginBottom: 6 }}>{label}</label>
                <input className="input" defaultValue={val} onBlur={(e) => { if (e.target.value !== val) onBlur(e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} placeholder={label.includes("⚡") ? "you@getalby.com" : ""}/>
              </div>
            ))}

            <div className="section-title" style={{ marginTop: 24 }}>Keys <span className="line"/></div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>PUBLIC</div>
            <div onClick={() => copyToClipboard(nip19.npubEncode(pk))} className="chip accent" style={{ cursor: "pointer", marginBottom: 12, wordBreak: "break-all" }}>{nip19.npubEncode(pk).slice(0, 30)}... <IcCopy size={10}/></div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>PRIVATE (keep secret!)</div>
            <div onClick={() => copyToClipboard(nip19.nsecEncode(sk))} className="chip" style={{ cursor: "pointer", color: "var(--red)", borderColor: "var(--red)", marginBottom: 16, wordBreak: "break-all" }}>{nip19.nsecEncode(sk).slice(0, 30)}... <IcCopy size={10}/></div>

            <div className="section-title">Relays <span className="line"/></div>
            {relays.map((r) => (<div key={r} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--hairline)", fontSize: 12 }}>
              <span style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>{r}</span>
              <button onClick={() => { if (relays.length > 1) setRelays((prev) => prev.filter((x) => x !== r)); }} className="btn sm ghost">remove</button>
            </div>))}
            <div style={{ display: "flex", gap: 8, marginTop: 12, marginBottom: 12 }}>
              <input className="input" placeholder="wss://relay.example.com" value={newRelay} onChange={(e) => setNewRelay(e.target.value)} style={{ flex: 1 }}/>
              <button onClick={() => { const r = newRelay.trim(); if (r.startsWith("wss://") && !relays.includes(r)) { setRelays((prev) => [...prev, r]); setNewRelay(""); } }} className="btn primary sm">ADD</button>
            </div>
            <button onClick={connectAndSubscribe} className="btn" style={{ width: "100%", borderColor: "var(--accent)", color: "var(--accent)" }}>RECONNECT TO RELAYS</button>

            <div className="section-title" style={{ marginTop: 24 }}>Legal <span className="line"/></div>

            {/* Terms of Service */}
            <button onClick={() => setShowTerms(!showTerms)} className="btn ghost" style={{ width: "100%", justifyContent: "space-between", display: "flex", padding: "12px", marginBottom: 4 }}>
              <span>Terms of Service</span>
              <IcChevron size={14} style={{ transform: showTerms ? "rotate(180deg)" : "rotate(0deg)", transition: "transform .2s" }}/>
            </button>
            {showTerms && (
              <div style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)", borderRadius: 10, padding: "16px 18px", marginBottom: 12, fontSize: 13, lineHeight: 1.7, color: "var(--fg-dim)" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, color: "var(--fg)", marginBottom: 12, letterSpacing: ".04em" }}>TWATTER TERMS OF SERVICE</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)", marginBottom: 16 }}>Last updated: April 2026</div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>1. WHAT TWATTER IS</div>
                  <div>Twatter is an open-source client for the Nostr protocol. It provides an interface for reading and publishing notes on Nostr relays. Twatter does not own, operate, or control the Nostr network itself. Your posts are published to decentralized relays and cannot be deleted by Twatter.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>2. YOUR KEYS, YOUR RESPONSIBILITY</div>
                  <div>Your identity on Nostr is your cryptographic key pair. Twatter generates and stores your private key locally on your device. We never transmit, collect, or have access to your private key. If you lose your private key, your account cannot be recovered by anyone — including us. Back up your keys.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>3. NO ALGORITHM</div>
                  <div>Twatter displays content in strictly chronological order. We do not use algorithms to rank, promote, suppress, or curate content. What you see is determined solely by who you follow and the relays you connect to.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>4. USER CONDUCT</div>
                  <div>You are solely responsible for the content you publish. You agree not to use Twatter to publish content that is illegal under applicable law, including but not limited to: child sexual abuse material, credible threats of violence, or content that violates intellectual property rights. Twatter reserves the right to block access to our relay for users who violate these terms.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>5. PRO SUBSCRIPTIONS & PAYMENTS</div>
                  <div>Twatter Pro is an optional paid tier priced at $5 USD per 30 days (converted to Bitcoin sats at current market rate). Payments are made via the Bitcoin Lightning Network. All payments are final and non-refundable — this is inherent to Lightning transactions. Pro status is tied to your public key and lasts for the stated duration. Twatter is not a financial service and does not hold or custody funds.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>6. ZAPS (LIGHTNING TIPS)</div>
                  <div>Zaps are voluntary Lightning payments between users. Zaps sent through Twatter are routed through our payment server, which applies a 2% service fee. The remaining amount is forwarded to the recipient's Lightning address. The fee is clearly displayed before you confirm any zap. Twatter does not custody user funds — payments are processed and forwarded immediately.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>7. CONTENT & LIABILITY</div>
                  <div>Content on Twatter comes from the Nostr network and is generated entirely by users. Twatter does not endorse, verify, or take responsibility for any user-generated content. The service is provided "as is" without warranties of any kind. Twatter is not liable for any damages arising from your use of the service, the Nostr protocol, or Lightning Network transactions.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>8. RELAY SERVICES</div>
                  <div>Twatter operates an optional relay (relay.twatter.xyz). We reserve the right to limit, restrict, or remove access to our relay at any time. You are free to use any Nostr relay. Removing you from our relay does not affect your ability to use Nostr through other relays.</div>
                </div>

                <div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>9. CHANGES</div>
                  <div>We may update these terms. Continued use of Twatter after changes constitutes acceptance. Major changes will be communicated through the app.</div>
                </div>
              </div>
            )}

            {/* Privacy Policy */}
            <button onClick={() => setShowPrivacy(!showPrivacy)} className="btn ghost" style={{ width: "100%", justifyContent: "space-between", display: "flex", padding: "12px", marginBottom: 4 }}>
              <span>Privacy Policy</span>
              <IcChevron size={14} style={{ transform: showPrivacy ? "rotate(180deg)" : "rotate(0deg)", transition: "transform .2s" }}/>
            </button>
            {showPrivacy && (
              <div style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)", borderRadius: 10, padding: "16px 18px", marginBottom: 12, fontSize: 13, lineHeight: 1.7, color: "var(--fg-dim)" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, color: "var(--fg)", marginBottom: 12, letterSpacing: ".04em" }}>TWATTER PRIVACY POLICY</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)", marginBottom: 16 }}>Last updated: April 2026</div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>WHAT WE COLLECT</div>
                  <div>Almost nothing. Twatter is designed to minimize data collection. Here is what we do and do not have access to:</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>YOUR PRIVATE KEY</div>
                  <div>Stored only on your device (browser localStorage or Electron app storage). Never transmitted to our servers. We cannot access, recover, or reset it.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>YOUR PUBLIC KEY</div>
                  <div>This is public by design in the Nostr protocol. It is broadcast to relays when you publish content. Our payment server stores your public key if you purchase Twatter Pro, solely to verify your subscription status.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>YOUR POSTS & PROFILE</div>
                  <div>Published to Nostr relays you connect to. This is public data on a decentralized network. Twatter does not control this data after publication. You cannot fully delete posts once published to third-party relays — this is a property of the Nostr protocol, not a Twatter limitation.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>DIRECT MESSAGES</div>
                  <div>DMs are encrypted using NIP-04 (shared secret encryption between sender and recipient). Relay operators can see that a DM was sent and between which public keys, but cannot read the message content. Twatter decrypts messages locally on your device only.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>PAYMENT DATA</div>
                  <div>If you purchase Twatter Pro, our payment server stores: your public key, the Lightning invoice, payment status, and timestamp. We do not store Lightning wallet addresses, balances, or transaction history beyond the Pro purchase. Zaps between users do not touch our servers.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>ANALYTICS & TRACKING</div>
                  <div>Twatter does not use analytics, tracking pixels, cookies, fingerprinting, or any third-party tracking services. We do not track what you read, who you follow, or how you use the app.</div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>THIRD-PARTY RELAYS</div>
                  <div>Twatter connects to Nostr relays operated by third parties (e.g., relay.damus.io, nos.lol). These relay operators have their own privacy practices. Twatter is not responsible for data handling by third-party relay operators. You can add or remove relays at any time in Settings.</div>
                </div>

                <div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginBottom: 6 }}>CONTACT</div>
                  <div>For privacy questions, reach us on Nostr or at the contact address listed on our relay.</div>
                </div>
              </div>
            )}

            <div className="section-title" style={{ marginTop: 24 }}>Danger Zone <span className="line"/></div>
            <button onClick={logout} className="btn" style={{ borderColor: "var(--red)", color: "var(--red)", marginTop: 8 }}>LOG OUT & CLEAR DATA</button>
            <div className="eyebrow" style={{ color: "var(--red)", marginTop: 6 }}>Save your keys before logging out!</div>
          </div>
        )}
      </div>

      {/* RIGHT PANEL - KITCHEN (desktop) */}
      {tweaks.showKitchen && view === "feed" && <div className="desktop-kitchen"><FeedKitchen state={kitchen} setState={setKitchen} relays={relays}/></div>}

      {/* TWEAKS PANEL (floating) */}
      {showTweaks && <TweaksPanel tweaks={tweaks} setTweaks={setTweaks}/>}

      {/* MOBILE BOTTOM NAV */}
      <nav className="bottom-nav">
        <div className="bottom-nav-inner">
          {[["feed", <IcHome size={18}/>, "Feed"], ["explore", <IcGlobe size={18}/>, "Explore"], ["dms", <IcMail size={18}/>, "Messages"], ["profile", <IcUser size={18}/>, "Profile"]].map(([v, icon, label]) => {
            const isActive = v === "profile" ? (view === "profile" && profileId === pk) : view === v;
            return (
              <button key={v} className={`bottom-nav-btn${isActive ? " active" : ""}`} onClick={() => { setShowMobileKitchen(false); if (v === "profile") { setProfileId(pk); setView("profile"); } else if (v === "dms") { setView("dms"); setActiveChat(null); } else setView(v); }}>
                {icon}
                <span>{label}</span>
              </button>
            );
          })}
          {view === "feed" && (
            <button className={`bottom-nav-btn${showMobileKitchen ? " active" : ""}`} onClick={() => setShowMobileKitchen(!showMobileKitchen)}>
              <IcSliders size={18}/>
              <span>Kitchen</span>
            </button>
          )}
        </div>
      </nav>

      {/* MOBILE KITCHEN DRAWER */}
      <div className={`kitchen-drawer-overlay${showMobileKitchen ? " open" : ""}`} onClick={() => setShowMobileKitchen(false)}/>
      <div className={`kitchen-drawer${showMobileKitchen ? " open" : ""}`}>
        <div className="kitchen-drawer-handle" onClick={() => setShowMobileKitchen(false)}/>
        <div style={{ padding: "0 16px 24px" }}>
          <FeedKitchen state={kitchen} setState={setKitchen} relays={relays}/>
        </div>
      </div>
    </div>
  );
}
