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

// ======================== CONFIG ========================
const STORAGE_KEY = "twatter-nostr";
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.snort.social",
];
const FREE_POST_LIMIT = 300;
const PRO_POST_LIMIT = 2000;
const FETCH_LIMIT = 100;
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

// ======================== ZAP HELPERS (NIP-57) ========================
async function fetchLnurlData(lud16) {
  const [user, domain] = lud16.split("@");
  if (!user || !domain) throw new Error("Invalid Lightning address");
  const res = await fetch(`https://${domain}/.well-known/lnurlp/${user}`);
  if (!res.ok) throw new Error("Failed to fetch Lightning address info");
  return res.json();
}

async function createZapInvoice(lnurlData, amountSats, zapRequestEvent) {
  const amountMsats = amountSats * 1000;
  if (amountMsats < (lnurlData.minSendable || 1000) || amountMsats > (lnurlData.maxSendable || 1e12)) throw new Error("Amount out of range");
  const url = new URL(lnurlData.callback);
  url.searchParams.set("amount", String(amountMsats));
  if (lnurlData.allowsNostr && zapRequestEvent) url.searchParams.set("nostr", JSON.stringify(zapRequestEvent));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Failed to get Lightning invoice");
  const data = await res.json();
  if (!data.pr) throw new Error("No invoice in response");
  return data.pr;
}

async function payWithWebLN(invoice) {
  if (!window.webln) throw new Error("No Lightning wallet found.\nInstall the Alby browser extension\nto send Lightning payments.");
  await window.webln.enable();
  return window.webln.sendPayment(invoice);
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

// ======================== STYLING ========================
const font = `'Newsreader', 'Georgia', serif`;
const mono = `'JetBrains Mono', 'SF Mono', monospace`;
const sectionTitle = { fontFamily: mono, fontSize: 11, color: "#5a5550", textTransform: "uppercase", letterSpacing: "1.5px", padding: "16px 0 8px" };
const inputStyle = { width: "100%", background: "#111110", border: "1px solid #1e1e1e", borderRadius: 8, padding: "10px 14px", color: "#e8e4df", fontFamily: font, fontSize: 14, outline: "none", boxSizing: "border-box" };
const btnBase = { background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center" };

// ======================== ICONS ========================
const HeartIcon = ({ filled }) => (<svg width="16" height="16" viewBox="0 0 24 24" fill={filled?"#c4956a":"none"} stroke={filled?"#c4956a":"currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>);
const ReplyIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>);
const SearchIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>);
const ImageIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>);
const LinkIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>);
const SendIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>);
const BackIcon = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>);
const XIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>);
const KeyIcon = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>);
const CopyIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>);
const ZapIcon = ({ filled }) => (<svg width="15" height="15" viewBox="0 0 24 24" fill={filled?"#f5c842":"none"} stroke={filled?"#f5c842":"currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>);
const StarIcon = () => (<svg width="12" height="12" viewBox="0 0 24 24" fill="#c4956a" stroke="#c4956a" strokeWidth="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>);
const CircleIcon = ({ color }) => (<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill={color}/></svg>);

// ======================== SMALL COMPONENTS ========================
const PostImage = ({ src }) => { const [err, setErr] = useState(false); if (!src || err) return null; return (<div style={{ marginTop: 10, borderRadius: 10, overflow: "hidden", border: "1px solid #1e1e1e" }}><img src={src} alt="" onError={() => setErr(true)} style={{ width: "100%", display: "block", maxHeight: 400, objectFit: "cover" }}/></div>); };

const ProBadge = () => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 3, background: "#1e1a12", border: "1px solid #3a2f10", borderRadius: 4, padding: "1px 6px", fontFamily: mono, fontSize: 9, color: "#c4956a", letterSpacing: "0.5px" }}>
    <StarIcon /> PRO
  </span>
);

const Avatar = ({ profile, size = 38, onClick, isPro }) => {
  const s = { width: size, height: size, borderRadius: "50%", background: "#1e1a16", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: size * 0.35, fontWeight: 700, color: "#c4956a", flexShrink: 0, border: isPro ? "2px solid #c4956a" : "1px solid #2a2520", cursor: onClick ? "pointer" : "default", overflow: "hidden" };
  if (profile?.picture) return <div style={s} onClick={onClick}><img src={profile.picture} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { e.target.style.display = "none"; }}/></div>;
  return <div style={s} onClick={onClick}>{(profile?.name || "?").slice(0, 2).toUpperCase()}</div>;
};

const ImageAttach = ({ image, onImage, onClear }) => {
  const fileRef = useRef(null);
  const [showUrl, setShowUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const handleFile = async (e) => { const file = e.target.files?.[0]; if (!file || !file.type.startsWith("image/") || file.size > 5*1024*1024) return; const reader = new FileReader(); reader.onload = () => onImage(reader.result); reader.readAsDataURL(file); if (fileRef.current) fileRef.current.value = ""; };
  const handleUrl = () => { const url = urlDraft.trim(); if (url && /^https?:\/\//i.test(url)) { onImage(url); setUrlDraft(""); setShowUrl(false); } };
  if (image) return (<div style={{ position: "relative", marginTop: 8, display: "inline-block" }}><img src={image} alt="" style={{ height: 60, borderRadius: 8, border: "1px solid #2a2520" }}/><button onClick={onClear} style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "#d44", border: "none", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}><XIcon/></button></div>);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
      <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }}/>
      <button onClick={() => fileRef.current?.click()} title="Upload image" style={{ ...btnBase, color: "#5a5550" }}><ImageIcon/></button>
      <button onClick={() => setShowUrl(!showUrl)} title="Image URL" style={{ ...btnBase, color: showUrl ? "#c4956a" : "#5a5550" }}><LinkIcon/></button>
      {showUrl && (<div style={{ display: "flex", gap: 4, flex: 1 }}><input style={{ ...inputStyle, padding: "4px 8px", fontSize: 11, fontFamily: mono, borderRadius: 6 }} placeholder="https://..." value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleUrl()}/><button onClick={handleUrl} style={{ background: "#c4956a", border: "none", borderRadius: 6, padding: "4px 10px", fontFamily: mono, fontSize: 10, fontWeight: 700, color: "#0a0a0a", cursor: "pointer" }}>ADD</button></div>)}
    </div>
  );
};

// ======================== ZAP MODAL ========================
const ZapModal = ({ targetProfile, targetEvent, sk, pk, relays, onClose }) => {
  const [amount, setAmount] = useState(21);
  const [custom, setCustom] = useState("");
  const [status, setStatus] = useState("idle"); // idle | fetching | invoice | paying | success | error
  const [error, setError] = useState("");
  const finalAmount = custom ? parseInt(custom) || 0 : amount;

  const doZap = async () => {
    const lud16 = targetProfile?.lud16;
    if (!lud16) { setError("This user hasn't set up a Lightning address yet."); setStatus("error"); return; }
    if (!finalAmount || finalAmount < 1) { setError("Enter a valid amount."); setStatus("error"); return; }
    try {
      setStatus("fetching");
      setError("");
      const lnurlData = await fetchLnurlData(lud16);
      setStatus("invoice");
      // Build NIP-57 zap request
      const zapTags = [["relays", ...relays], ["amount", String(finalAmount * 1000)], ["p", targetProfile.pubkey]];
      if (targetEvent) zapTags.push(["e", targetEvent.id]);
      const zapRequest = makeEvent(9734, "", zapTags, sk);
      const invoice = await createZapInvoice(lnurlData, finalAmount, lnurlData.allowsNostr ? zapRequest : null);
      setStatus("paying");
      await payWithWebLN(invoice);
      setStatus("success");
      setTimeout(onClose, 1800);
    } catch (e) {
      setError(e.message || "Payment failed");
      setStatus("error");
    }
  };

  const statusMsg = { fetching: "Getting Lightning info...", invoice: "Generating invoice...", paying: "Waiting for payment...", success: "⚡ Zapped!", error: "" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: "#111110", border: "1px solid #2a2520", borderRadius: 14, padding: 24, width: 320, maxWidth: "90vw" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: "#f5c842" }}>⚡ ZAP {targetProfile?.name || shortPk(targetProfile?.pubkey)}</span>
          <button onClick={onClose} style={{ ...btnBase, color: "#6b6460" }}><XIcon/></button>
        </div>
        {/* Preset amounts */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 12 }}>
          {ZAP_PRESETS.map((n) => (
            <button key={n} onClick={() => { setAmount(n); setCustom(""); }} style={{ background: amount === n && !custom ? "#1e1a12" : "#0f0f0e", border: `1px solid ${amount === n && !custom ? "#f5c842" : "#1e1e1e"}`, borderRadius: 8, padding: "8px 4px", fontFamily: mono, fontSize: 12, color: amount === n && !custom ? "#f5c842" : "#a09880", cursor: "pointer" }}>
              ⚡ {formatSats(n)}
            </button>
          ))}
        </div>
        {/* Custom amount */}
        <input style={{ ...inputStyle, fontFamily: mono, fontSize: 13, marginBottom: 14, background: "#0f0f0e" }} type="number" placeholder="Custom amount (sats)" value={custom} onChange={(e) => setCustom(e.target.value)} min="1"/>
        {/* Status / error */}
        {status !== "idle" && status !== "error" && (
          <div style={{ fontFamily: mono, fontSize: 12, color: status === "success" ? "#4a9" : "#f5c842", textAlign: "center", marginBottom: 12, padding: "8px", background: "#0f0f0e", borderRadius: 8 }}>{statusMsg[status]}</div>
        )}
        {status === "error" && <div style={{ fontFamily: mono, fontSize: 11, color: "#d44", marginBottom: 12, lineHeight: 1.6, whiteSpace: "pre-line" }}>{error}</div>}
        {/* Pay button */}
        {status !== "success" && (
          <button onClick={doZap} disabled={["fetching","invoice","paying"].includes(status)} style={{ width: "100%", background: ["fetching","invoice","paying"].includes(status) ? "#2a2520" : "#f5c842", color: ["fetching","invoice","paying"].includes(status) ? "#5a5550" : "#0a0a0a", border: "none", padding: "12px", borderRadius: 10, fontFamily: mono, fontSize: 13, fontWeight: 700, cursor: ["fetching","invoice","paying"].includes(status) ? "default" : "pointer" }}>
            {["fetching","invoice","paying"].includes(status) ? "..." : `⚡ ZAP ${formatSats(finalAmount)} SATS`}
          </button>
        )}
        {!targetProfile?.lud16 && status === "idle" && (
          <div style={{ fontFamily: mono, fontSize: 10, color: "#5a5550", marginTop: 8, textAlign: "center" }}>This user hasn't added a Lightning address to their profile.</div>
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
  const pollRef = useRef(null);

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
      <div style={{ background: "#111110", border: "1px solid #2a2520", borderRadius: 14, padding: 28, width: 380, maxWidth: "90vw", maxHeight: "90vh", overflowY: "auto" }}>
        {/* Close button */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={() => { cleanup(); onClose(); }} style={{ ...btnBase, color: "#6b6460" }}><XIcon/></button>
        </div>

        {step === "info" && (
          <>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>⚡</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#f5f0eb", marginBottom: 6 }}>Twatter Pro</div>
              <div style={{ fontFamily: mono, fontSize: 11, color: "#6b6460", lineHeight: 1.8 }}>Support decentralized social media.<br/>Pay with Bitcoin Lightning.</div>
            </div>
            <div style={{ background: "#0f0f0e", borderRadius: 10, padding: 16, marginBottom: 20 }}>
              {[["⚡", "2,000 character posts (vs 300 free)"], ["🖼", "10GB media storage"], ["📊", "Creator analytics dashboard"], ["⏰", "Scheduled posts"], ["🔒", "Priority relay access"], ["✓", "Pro badge on your profile"]].map(([icon, text]) => (
                <div key={text} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", fontFamily: mono, fontSize: 12, color: "#d4d0cb" }}>
                  <span>{icon}</span><span>{text}</span>
                </div>
              ))}
            </div>
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <span style={{ fontFamily: mono, fontSize: 24, fontWeight: 700, color: "#f5c842" }}>21,000 sats</span>
              <span style={{ fontFamily: mono, fontSize: 12, color: "#6b6460" }}> / 30 days</span>
            </div>
            <button onClick={createInvoice} style={{ width: "100%", background: "#f5c842", color: "#0a0a0a", border: "none", padding: "13px", borderRadius: 10, fontFamily: mono, fontSize: 13, fontWeight: 700, cursor: "pointer", marginBottom: 10 }}>
              ⚡ PAY WITH LIGHTNING
            </button>
            <div style={{ textAlign: "center", fontFamily: mono, fontSize: 10, color: "#4a4540", lineHeight: 1.6 }}>
              If you have the Alby extension, payment is instant.<br/>Otherwise you'll get an invoice to pay from any Lightning wallet.
            </div>
          </>
        )}

        {step === "invoice" && invoice && (
          <>
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <div style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: "#f5c842", marginBottom: 8 }}>⚡ Lightning Invoice</div>
              <div style={{ fontFamily: mono, fontSize: 11, color: "#6b6460" }}>Scan or copy this invoice to pay</div>
            </div>
            {/* QR-style display of the invoice (text representation) */}
            <div style={{ background: "#fff", borderRadius: 10, padding: 16, marginBottom: 16, textAlign: "center" }}>
              <div style={{ fontFamily: mono, fontSize: 10, color: "#333", wordBreak: "break-all", lineHeight: 1.5, maxHeight: 120, overflowY: "auto" }}>
                {invoice.bolt11}
              </div>
            </div>
            <button onClick={copyInvoice} style={{ width: "100%", background: "#1e1a16", color: "#f5c842", border: "1px solid #3a3010", padding: "11px", borderRadius: 10, fontFamily: mono, fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 10 }}>
              {copied ? "COPIED!" : "COPY INVOICE"}
            </button>
            <div style={{ textAlign: "center", fontFamily: mono, fontSize: 11, color: "#f5c842", padding: 8 }}>
              <span style={{ display: "inline-block", animation: "pulse 1.5s infinite" }}>Waiting for payment...</span>
            </div>
            <div style={{ textAlign: "center", fontFamily: mono, fontSize: 10, color: "#4a4540", marginTop: 4 }}>
              Pay {formatSats(invoice.amount_sats)} sats from any Lightning wallet.<br/>This page will update automatically.
            </div>
          </>
        )}

        {step === "invoice" && !invoice && (
          <div style={{ textAlign: "center", padding: 40, fontFamily: mono, fontSize: 12, color: "#f5c842" }}>
            Creating Lightning invoice...
          </div>
        )}

        {step === "success" && (
          <div style={{ textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>⚡</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#f5c842", marginBottom: 8 }}>You're Pro!</div>
            <div style={{ fontFamily: mono, fontSize: 12, color: "#6b6460", lineHeight: 1.8 }}>Payment confirmed. Welcome to Twatter Pro.<br/>Enjoy your upgraded experience.</div>
            <button onClick={() => { cleanup(); onClose(); }} style={{ marginTop: 20, background: "#f5c842", color: "#0a0a0a", border: "none", padding: "12px 32px", borderRadius: 10, fontFamily: mono, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>LET'S GO</button>
          </div>
        )}

        {step === "error" && (
          <div style={{ textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>😕</div>
            <div style={{ fontFamily: mono, fontSize: 12, color: "#d44", marginBottom: 12 }}>{error}</div>
            <button onClick={() => setStep("info")} style={{ background: "#1e1a16", color: "#c4956a", border: "1px solid #2a2520", padding: "10px 24px", borderRadius: 10, fontFamily: mono, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>TRY AGAIN</button>
          </div>
        )}

        {step !== "info" && step !== "success" && (
          <button onClick={() => { cleanup(); onClose(); }} style={{ width: "100%", background: "none", border: "none", fontFamily: mono, fontSize: 12, color: "#5a5550", cursor: "pointer", padding: "6px", marginTop: 8 }}>Cancel</button>
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
      setPosts((prev) => { if (prev.some((p) => p.id === event.id)) return prev; return [...prev, event].sort((a, b) => b.created_at - a.created_at).slice(0, 500); });
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

  // ======================== DERIVED DATA ========================
  const myProfile = profiles[pk] || {};
  const feedPosts = useMemo(() => posts.filter((p) => contacts.includes(p.pubkey) || p.pubkey === pk), [posts, contacts, pk]);
  const explorePosts = useMemo(() => [...posts].slice(0, 200), [posts]);
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
      <div style={{ padding: "18px 0", borderBottom: "1px solid #141414" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <Avatar profile={profile} size={38} isPro={authorIsPro} onClick={() => openProfile(event.pubkey)}/>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 15, color: "#f0ece7", cursor: "pointer" }} onClick={() => openProfile(event.pubkey)}>{profile?.name || shortPk(event.pubkey)}</span>
              {authorIsPro && <ProBadge/>}
            </div>
            <div style={{ fontFamily: mono, fontSize: 12, color: "#6b6460" }}>{profile?.nip05 || shortPk(event.pubkey)}</div>
          </div>
          <span style={{ fontFamily: mono, fontSize: 11, color: "#4a4540", marginLeft: "auto" }}>{timeAgo(event.created_at)}</span>
        </div>
        {text && <div style={{ fontSize: 15, lineHeight: 1.65, color: "#d4d0cb", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text}</div>}
        <PostImage src={image}/>
        <div style={{ display: "flex", gap: 20, marginTop: 12, alignItems: "center" }}>
          <button onClick={() => toggleLike(event)} style={{ ...btnBase, fontFamily: mono, fontSize: 12, color: liked ? "#c4956a" : "#5a5550", gap: 5 }}><HeartIcon filled={liked}/> {likeCount || ""}</button>
          <button onClick={() => { setReplyTo(replyTo === event.id ? null : event.id); setReplyDraft(""); }} style={{ ...btnBase, fontFamily: mono, fontSize: 12, color: replyTo === event.id ? "#c4956a" : "#5a5550", gap: 5 }}><ReplyIcon/> {replies.length || ""}</button>
          <button onClick={() => setZapModal({ profile, event })} style={{ ...btnBase, fontFamily: mono, fontSize: 12, color: zapData ? "#f5c842" : "#5a5550", gap: 4 }}>
            <ZapIcon filled={!!zapData}/>
            {zapData ? <span style={{ fontSize: 11 }}>{formatSats(zapData.sats)} <span style={{ color: "#4a4540" }}>({zapData.count})</span></span> : ""}
          </button>
        </div>
        {replies.map((r) => { const rp = profiles[r.pubkey]; return (<div key={r.id} style={{ marginLeft: 48, padding: "10px 0 4px", borderLeft: "2px solid #1e1a16", paddingLeft: 14 }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Avatar profile={rp} size={26} onClick={() => openProfile(r.pubkey)}/><span style={{ fontWeight: 600, fontSize: 13, color: "#f0ece7", cursor: "pointer" }} onClick={() => openProfile(r.pubkey)}>{rp?.name || shortPk(r.pubkey)}</span><span style={{ fontFamily: mono, fontSize: 10, color: "#4a4540", marginLeft: "auto" }}>{timeAgo(r.created_at)}</span></div><div style={{ fontSize: 13, lineHeight: 1.55, color: "#d4d0cb", marginTop: 4, marginLeft: 34 }}>{r.content}</div></div>); })}
        {replyTo === event.id && (<div style={{ marginTop: 8, marginLeft: 48 }}><input style={{ ...inputStyle, padding: "10px 12px", fontSize: 13, borderRadius: 8, background: "#0f0f0e" }} placeholder="Reply..." value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addReply(event)} autoFocus/></div>)}
      </div>
    );
  };

  // ======================== RENDER ========================
  if (loading) return <div style={{ fontFamily: mono, color: "#5a5550", display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0a0a0a" }}>Loading...</div>;

  if (!setupDone) return (
    <div style={{ fontFamily: font, minHeight: "100vh", background: "#0a0a0a", color: "#e8e4df", maxWidth: 480, margin: "0 auto", padding: "0 20px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet"/>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <div style={{ fontSize: 36, fontWeight: 700, fontFamily: mono, marginBottom: 8 }}>twat<span style={{ color: "#c4956a" }}>ter</span></div>
        <div style={{ fontFamily: mono, fontSize: 12, color: "#6b6460", lineHeight: 1.8 }}>Decentralized. No servers. No algorithms.<br/>Your keys, your identity, your data.</div>
      </div>
      <button onClick={generateKeys} style={{ width: "100%", background: "#c4956a", color: "#0a0a0a", border: "none", padding: "14px", borderRadius: 10, fontFamily: mono, fontSize: 14, fontWeight: 700, cursor: "pointer", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><KeyIcon/> GENERATE NEW IDENTITY</button>
      <div style={{ textAlign: "center", fontFamily: mono, fontSize: 11, color: "#4a4540", margin: "20px 0 16px" }}>— or import existing Nostr key —</div>
      <input style={{ ...inputStyle, marginBottom: 10, fontFamily: mono, fontSize: 12 }} placeholder="nsec1... or hex private key" value={importKey} onChange={(e) => setImportKey(e.target.value)}/>
      <button onClick={importKeys} style={{ width: "100%", background: importKey.trim() ? "#1e1a16" : "#111110", color: importKey.trim() ? "#c4956a" : "#4a4540", border: "1px solid #2a2520", padding: "12px", borderRadius: 10, fontFamily: mono, fontSize: 13, fontWeight: 600, cursor: importKey.trim() ? "pointer" : "default" }}>IMPORT KEY</button>
    </div>
  );

  return (
    <div style={{ fontFamily: font, minHeight: "100vh", background: "#0a0a0a", color: "#e8e4df", maxWidth: 620, margin: "0 auto", padding: "0 16px" }}>
      <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet"/>

      {/* Modals */}
      {zapModal && <ZapModal targetProfile={zapModal.profile} targetEvent={zapModal.event} sk={sk} pk={pk} relays={relays} onClose={() => setZapModal(null)}/>}
      {showProModal && <ProModal pk={pk} onClose={() => setShowProModal(false)} onProActivated={() => setIsPro(true)}/>}

      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 0 16px", borderBottom: "1px solid #1e1e1e", position: "sticky", top: 0, background: "#0a0a0a", zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", cursor: "pointer", gap: 8 }} onClick={() => { setView("feed"); setProfileId(null); setActiveChat(null); }}>
          <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px", color: "#f5f0eb", fontFamily: mono }}>twat<span style={{ color: "#c4956a" }}>ter</span></span>
          <CircleIcon color={relayStatus === "connected" ? "#4a9" : relayStatus === "connecting" ? "#ca4" : "#a44"}/>
        </div>
        <div style={{ display: "flex", gap: 3 }}>
          {[["feed","Feed"],["explore","Explore"],["dms","DMs"],["you","You"],["settings","⚙"]].map(([v,label]) => {
            const isActive = v === "you" ? (view === "profile" && profileId === pk) : v === "settings" ? view === "settings" : view === v;
            return (<button key={v} onClick={() => { if (v === "you") { setProfileId(pk); setView("profile"); } else if (v === "dms") { setView("dms"); setActiveChat(null); } else setView(v); }} style={{ background: isActive ? "#1a1714" : "transparent", color: isActive ? "#e8e4df" : "#6b6460", border: "none", padding: "6px 11px", borderRadius: 6, cursor: "pointer", fontFamily: mono, fontSize: 11, fontWeight: isActive ? 600 : 400 }}>{label}</button>);
          })}
          {!isPro && <button onClick={() => setShowProModal(true)} style={{ background: "linear-gradient(135deg,#2a1f0a,#1e1a12)", color: "#c4956a", border: "1px solid #3a2f10", padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontFamily: mono, fontSize: 10, fontWeight: 700 }}>⭐ PRO</button>}
        </div>
      </header>

      {/* Feed */}
      {view === "feed" && (
        <div>
          <div style={{ padding: "20px 0", borderBottom: "1px solid #1e1e1e" }}>
            <textarea style={{ ...inputStyle, borderRadius: 10, padding: "14px 16px", fontSize: 15, lineHeight: 1.55, resize: "none", fontFamily: font }} rows={3} placeholder="What's on your mind?" value={draft} onChange={(e) => setDraft(e.target.value)}/>
            <ImageAttach image={draftImage} onImage={setDraftImage} onClear={() => setDraftImage(null)}/>
            <div style={{ overflow: "hidden", marginTop: 4 }}>
              <span style={{ fontFamily: mono, fontSize: 11, color: draft.length > POST_LIMIT * 0.9 ? "#d44" : "#5a5550", float: "left", lineHeight: "32px" }}>{draft.length}/{POST_LIMIT}{!isPro && <span style={{ color: "#4a4540" }}> · <span style={{ cursor: "pointer", color: "#c4956a" }} onClick={() => setShowProModal(true)}>Pro = {PRO_POST_LIMIT}</span></span>}</span>
              <button onClick={createPost} style={{ background: (draft.trim() || draftImage) && draft.length <= POST_LIMIT ? "#c4956a" : "#2a2520", color: (draft.trim() || draftImage) && draft.length <= POST_LIMIT ? "#0a0a0a" : "#5a5550", border: "none", padding: "8px 22px", borderRadius: 8, fontFamily: mono, fontSize: 12, fontWeight: 700, cursor: (draft.trim() || draftImage) && draft.length <= POST_LIMIT ? "pointer" : "default", marginTop: 6, float: "right" }}>POST</button>
            </div>
          </div>
          <div style={sectionTitle}>Your Timeline — Chronological</div>
          {feedPosts.length === 0 ? <div style={{ textAlign: "center", padding: "60px 20px", color: "#4a4540", fontFamily: mono, fontSize: 13, lineHeight: 1.8 }}>Your feed is empty.<br/>Follow people from Explore to see their posts.<br/>No algorithms. Just time.</div> : feedPosts.map((e) => <Post key={e.id} event={e}/>)}
        </div>
      )}

      {/* Explore */}
      {view === "explore" && (
        <div>
          <div style={{ padding: "16px 0", position: "relative" }}>
            <input style={{ ...inputStyle, borderRadius: 10, padding: "12px 16px", fontFamily: mono, fontSize: 13 }} placeholder="Search by name..." value={search} onChange={(e) => setSearch(e.target.value)}/>
            <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-40%)", color: "#5a5550" }}><SearchIcon/></span>
          </div>
          {search && Object.values(profiles).filter((p) => p.name?.toLowerCase().includes(search.toLowerCase()) || p.nip05?.toLowerCase().includes(search.toLowerCase())).slice(0, 20).map((p) => (
            <div key={p.pubkey} onClick={() => openProfile(p.pubkey)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid #141414", cursor: "pointer" }}>
              <Avatar profile={p} size={38} isPro={proProfiles.has(p.pubkey)}/>
              <div><div style={{ fontWeight: 600, fontSize: 15, color: "#f0ece7", display: "flex", alignItems: "center", gap: 6 }}>{p.name || shortPk(p.pubkey)}{proProfiles.has(p.pubkey) && <ProBadge/>}</div><div style={{ fontFamily: mono, fontSize: 12, color: "#6b6460" }}>{p.nip05 || shortPk(p.pubkey)}</div></div>
            </div>
          ))}
          <div style={sectionTitle}>Global Feed — Chronological</div>
          {explorePosts.map((e) => <Post key={e.id} event={e}/>)}
        </div>
      )}

      {/* DMs - List */}
      {view === "dms" && !activeChat && (
        <div>
          <div style={sectionTitle}>Messages</div>
          <div style={{ display: "flex", gap: 8, padding: "8px 0 16px", borderBottom: "1px solid #1e1e1e" }}>
            <input style={{ ...inputStyle, flex: 1, fontFamily: mono, fontSize: 12, borderRadius: 8 }} placeholder="npub1... or hex pubkey" value={newDmPk} onChange={(e) => setNewDmPk(e.target.value)} onKeyDown={(e) => e.key === "Enter" && startNewDM()}/>
            <button onClick={startNewDM} style={{ background: newDmPk.trim() ? "#c4956a" : "#2a2520", color: newDmPk.trim() ? "#0a0a0a" : "#5a5550", border: "none", padding: "8px 16px", borderRadius: 8, fontFamily: mono, fontSize: 12, fontWeight: 700, cursor: newDmPk.trim() ? "pointer" : "default" }}>NEW</button>
          </div>
          {dmConversations.length === 0 ? <div style={{ textAlign: "center", padding: "60px 20px", color: "#4a4540", fontFamily: mono, fontSize: 13, lineHeight: 1.8 }}>No messages yet.<br/>Paste someone's npub above to start a conversation.</div> : dmConversations.map((c) => (
            <div key={c.pubkey} onClick={() => setActiveChat(c.pubkey)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", borderBottom: "1px solid #141414", cursor: "pointer" }}>
              <Avatar profile={c.profile} size={44}/>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 14, color: "#f0ece7", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.profile?.name || shortPk(c.pubkey)}</div><div style={{ fontFamily: mono, fontSize: 12, color: "#6b6460", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{c.lastMessage?.image && !c.lastMessage?.text ? "sent an image" : c.lastMessage?.text || ""}</div></div>
              {c.lastMessage && <span style={{ fontFamily: mono, fontSize: 10, color: "#4a4540", flexShrink: 0 }}>{timeAgo(c.lastMessage.ts)}</span>}
            </div>
          ))}
        </div>
      )}

      {/* DMs - Chat */}
      {view === "dms" && activeChat && (
        <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 80px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 0 12px", borderBottom: "1px solid #1e1e1e", flexShrink: 0 }}>
            <button onClick={() => setActiveChat(null)} style={{ ...btnBase, color: "#6b6460" }}><BackIcon/></button>
            <Avatar profile={profiles[activeChat]} size={34} onClick={() => openProfile(activeChat)}/>
            <div><div style={{ fontWeight: 600, fontSize: 14, color: "#f0ece7", cursor: "pointer" }} onClick={() => openProfile(activeChat)}>{profiles[activeChat]?.name || shortPk(activeChat)}</div><div style={{ fontFamily: mono, fontSize: 10, color: "#6b6460" }}>{shortPk(activeChat)}</div></div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 0" }}>
            {(dmMessages[activeChat] || []).map((msg) => { const isMe = msg.from === pk; return (<div key={msg.id} style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start", marginBottom: 12 }}><div style={{ maxWidth: "75%", background: isMe ? "#1e1a16" : "#111110", border: `1px solid ${isMe?"#2a2520":"#1e1e1e"}`, borderRadius: 14, borderTopRightRadius: isMe ? 4 : 14, borderTopLeftRadius: isMe ? 14 : 4, padding: msg.text ? "10px 14px" : "4px", overflow: "hidden" }}>{msg.image && <img src={msg.image} alt="" style={{ maxWidth: "100%", maxHeight: 250, borderRadius: msg.text ? "8px 8px 0 0" : 10, display: "block", marginBottom: msg.text ? 6 : 0 }}/>}{msg.text && <div style={{ fontSize: 14, lineHeight: 1.5, color: "#d4d0cb", wordBreak: "break-word" }}>{msg.text}</div>}</div><span style={{ fontFamily: mono, fontSize: 9, color: "#4a4540", marginTop: 3, padding: "0 4px" }}>{timeAgo(msg.ts)}</span></div>); })}
            <div ref={chatEndRef}/>
          </div>
          <div style={{ borderTop: "1px solid #1e1e1e", padding: "12px 0", flexShrink: 0 }}>
            <ImageAttach image={dmImage} onImage={setDmImage} onClear={() => setDmImage(null)}/>
            <div style={{ display: "flex", gap: 8, marginTop: dmImage ? 8 : 0, alignItems: "flex-end" }}>
              <input style={{ ...inputStyle, flex: 1, borderRadius: 10, padding: "12px 14px" }} placeholder="Message..." value={dmDraft} onChange={(e) => setDmDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendDM())}/>
              <button onClick={sendDM} style={{ background: (dmDraft.trim() || dmImage) ? "#c4956a" : "#2a2520", border: "none", width: 40, height: 40, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", cursor: (dmDraft.trim() || dmImage) ? "pointer" : "default", flexShrink: 0 }}><SendIcon/></button>
            </div>
          </div>
        </div>
      )}

      {/* Profile */}
      {view === "profile" && (() => {
        const p = profiles[profileId] || {};
        const isMe = profileId === pk;
        const isFollowing = contacts.includes(profileId);
        const pPosts = getProfilePosts(profileId);
        const profileIsPro = proProfiles.has(profileId) || (profileId === pk && isPro);
        return (
          <div>
            <div style={{ padding: "24px 0", borderBottom: "1px solid #1e1e1e", textAlign: "center" }}>
              <Avatar profile={p} size={72} isPro={profileIsPro}/>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 12, color: "#f5f0eb", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>{p.name || shortPk(profileId)}{profileIsPro && <ProBadge/>}</div>
              <div style={{ fontFamily: mono, fontSize: 12, color: "#6b6460", marginTop: 2 }}>{p.nip05 || shortPk(profileId)}</div>
              {p.about && <div style={{ fontSize: 14, color: "#a09890", marginTop: 10, maxWidth: 400, margin: "10px auto 0", lineHeight: 1.5 }}>{p.about}</div>}
              {p.lud16 && <div style={{ fontFamily: mono, fontSize: 11, color: "#f5c842", marginTop: 6 }}>⚡ {p.lud16}</div>}
              <div style={{ display: "flex", justifyContent: "center", gap: 32, marginTop: 16 }}>
                <div style={{ textAlign: "center" }}><div style={{ fontFamily: mono, fontSize: 18, fontWeight: 700, color: "#e8e4df" }}>{pPosts.length}</div><div style={{ fontFamily: mono, fontSize: 10, color: "#6b6460", textTransform: "uppercase", letterSpacing: "1px" }}>Posts</div></div>
              </div>
              <div onClick={() => copyToClipboard(nip19.npubEncode(profileId))} style={{ fontFamily: mono, fontSize: 10, color: "#4a4540", marginTop: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
                {nip19.npubEncode(profileId).slice(0, 20)}... <CopyIcon/>{copied && <span style={{ color: "#c4956a", marginLeft: 4 }}>copied!</span>}
              </div>
              {!isMe && (
                <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16 }}>
                  <button onClick={() => toggleFollow(profileId)} style={{ background: isFollowing ? "transparent" : "#c4956a", color: isFollowing ? "#c4956a" : "#0a0a0a", border: isFollowing ? "1px solid #c4956a" : "none", padding: "8px 28px", borderRadius: 8, fontFamily: mono, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{isFollowing ? "FOLLOWING" : "FOLLOW"}</button>
                  <button onClick={() => { setActiveChat(profileId); setView("dms"); }} style={{ background: "transparent", color: "#c4956a", border: "1px solid #c4956a", padding: "8px 20px", borderRadius: 8, fontFamily: mono, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>MESSAGE</button>
                  {p.lud16 && <button onClick={() => setZapModal({ profile: p, event: null })} style={{ background: "#1e1a0a", color: "#f5c842", border: "1px solid #3a3010", padding: "8px 16px", borderRadius: 8, fontFamily: mono, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>⚡ ZAP</button>}
                </div>
              )}
              {isMe && !isPro && <button onClick={() => setShowProModal(true)} style={{ marginTop: 14, background: "linear-gradient(135deg,#2a1f0a,#1e1a12)", color: "#c4956a", border: "1px solid #3a2f10", padding: "8px 24px", borderRadius: 8, fontFamily: mono, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>⭐ Upgrade to Pro</button>}
            </div>
            <div style={sectionTitle}>{isMe ? "Your" : `${p.name || "Their"}'s`} Posts</div>
            {pPosts.length === 0 ? <div style={{ textAlign: "center", padding: "40px", color: "#4a4540", fontFamily: mono, fontSize: 13 }}>No posts yet.</div> : pPosts.map((e) => <Post key={e.id} event={e}/>)}
          </div>
        );
      })()}

      {/* Settings */}
      {view === "settings" && (
        <div>
          {/* Pro status banner */}
          {isPro ? (
            <div style={{ background: "linear-gradient(135deg,#1e1a12,#2a2010)", border: "1px solid #3a2f10", borderRadius: 10, padding: "14px 16px", marginTop: 16, marginBottom: 4, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>⭐</span>
              <div><div style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, color: "#c4956a" }}>Twatter Pro — Active</div><div style={{ fontFamily: mono, fontSize: 10, color: "#7a6840", marginTop: 2 }}>2,000 char posts · Priority relay · Creator tools</div></div>
            </div>
          ) : (
            <div onClick={() => setShowProModal(true)} style={{ background: "#111110", border: "1px dashed #2a2520", borderRadius: 10, padding: "14px 16px", marginTop: 16, marginBottom: 4, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>⭐</span>
              <div><div style={{ fontFamily: mono, fontSize: 12, fontWeight: 700, color: "#c4956a" }}>Upgrade to Twatter Pro — ⚡ 21k sats</div><div style={{ fontFamily: mono, fontSize: 10, color: "#5a5550", marginTop: 2 }}>Longer posts · More storage · Priority relay access · Pay with Lightning</div></div>
            </div>
          )}

          <div style={{ ...sectionTitle, paddingTop: 24 }}>Your Identity</div>
          <div style={{ padding: "16px 0", borderBottom: "1px solid #1a1a1a" }}>
            {[["Display Name", myProfile.name||"", (v) => updateProfile({...myProfile,name:v})], ["About", myProfile.about||"", (v) => updateProfile({...myProfile,about:v})], ["Picture URL", myProfile.picture||"", (v) => updateProfile({...myProfile,picture:v})], ["NIP-05", myProfile.nip05||"", (v) => updateProfile({...myProfile,nip05:v})], ["⚡ Lightning Address", myProfile.lud16||"", (v) => updateProfile({...myProfile,lud16:v})]].map(([label,val,onBlur]) => (
              <div key={label}>
                <div style={{ fontFamily: mono, fontSize: 11, color: label.includes("⚡") ? "#f5c842" : "#6b6460", textTransform: "uppercase", letterSpacing: "1px", marginBottom: 8 }}>{label}</div>
                <input style={{ ...inputStyle, marginBottom: 12 }} defaultValue={val} onBlur={(e) => { if (e.target.value !== val) onBlur(e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} placeholder={label.includes("⚡") ? "you@getalby.com" : ""}/>
              </div>
            ))}
            <div style={{ fontFamily: mono, fontSize: 10, color: "#4a4540", lineHeight: 1.8 }}>⚡ Your Lightning address lets others tip you directly with Bitcoin.<br/>Get one free at <span style={{ color: "#c4956a" }}>getalby.com</span></div>
          </div>

          <div style={{ ...sectionTitle, marginTop: 24 }}>Your Keys</div>
          <div style={{ padding: "16px 0", borderBottom: "1px solid #1a1a1a" }}>
            <div style={{ fontFamily: mono, fontSize: 11, color: "#6b6460", marginBottom: 6 }}>PUBLIC KEY (share this)</div>
            <div onClick={() => copyToClipboard(nip19.npubEncode(pk))} style={{ fontFamily: mono, fontSize: 11, color: "#c4956a", cursor: "pointer", padding: "8px 12px", background: "#111110", borderRadius: 6, border: "1px solid #1e1e1e", wordBreak: "break-all", display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>{nip19.npubEncode(pk)} <CopyIcon/></div>
            <div style={{ fontFamily: mono, fontSize: 11, color: "#6b6460", marginBottom: 6 }}>PRIVATE KEY (keep secret!)</div>
            <div onClick={() => copyToClipboard(nip19.nsecEncode(sk))} style={{ fontFamily: mono, fontSize: 11, color: "#d44", cursor: "pointer", padding: "8px 12px", background: "#1a1010", borderRadius: 6, border: "1px solid #2a1515", wordBreak: "break-all", display: "flex", alignItems: "center", gap: 6 }}>{nip19.nsecEncode(sk)} <CopyIcon/></div>
          </div>

          <div style={{ ...sectionTitle, marginTop: 24 }}>Relays</div>
          <div style={{ padding: "16px 0", borderBottom: "1px solid #1a1a1a" }}>
            {relays.map((r) => (<div key={r} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #141414" }}><span style={{ fontFamily: mono, fontSize: 12, color: "#d4d0cb" }}>{r}</span><button onClick={() => { if (relays.length > 1) setRelays((prev) => prev.filter((x) => x !== r)); }} style={{ ...btnBase, color: "#5a3030", fontFamily: mono, fontSize: 11 }}>remove</button></div>))}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <input style={{ ...inputStyle, flex: 1, fontFamily: mono, fontSize: 12, borderRadius: 8 }} placeholder="wss://relay.example.com" value={newRelay} onChange={(e) => setNewRelay(e.target.value)}/>
              <button onClick={() => { const r = newRelay.trim(); if (r.startsWith("wss://") && !relays.includes(r)) { setRelays((prev) => [...prev, r]); setNewRelay(""); } }} style={{ background: "#1e1a16", color: "#c4956a", border: "1px solid #2a2520", padding: "8px 16px", borderRadius: 8, fontFamily: mono, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>ADD</button>
            </div>
            <button onClick={connectAndSubscribe} style={{ width: "100%", background: "#1e1a16", color: "#c4956a", border: "1px solid #2a2520", padding: "10px", borderRadius: 8, fontFamily: mono, fontSize: 12, fontWeight: 600, cursor: "pointer", marginTop: 12 }}>RECONNECT TO RELAYS</button>
          </div>

          <div style={{ ...sectionTitle, marginTop: 24 }}>Danger Zone</div>
          <div style={{ padding: "16px 0" }}>
            <button onClick={logout} style={{ background: "#2a1515", color: "#d44", border: "1px solid #3a2020", padding: "8px 20px", borderRadius: 8, fontFamily: mono, fontSize: 12, cursor: "pointer" }}>LOG OUT & CLEAR DATA</button>
            <div style={{ fontFamily: mono, fontSize: 10, color: "#5a3030", marginTop: 6 }}>Save your private key before logging out!</div>
          </div>
        </div>
      )}

      <div style={{ padding: "40px 0 24px", textAlign: "center", fontFamily: mono, fontSize: 10, color: "#3a3530", letterSpacing: "1px" }}>
        TWATTER — POWERED BY NOSTR — TIME IS THE ONLY ALGORITHM
      </div>
    </div>
  );
}
