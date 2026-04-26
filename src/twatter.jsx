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
import { IcHome, IcGlobe, IcMail, IcUser, IcSettings, IcSearch, IcCompose, IcHeart, IcReply, IcZap, IcShare, IcImage, IcLink, IcSend, IcBack, IcClose, IcPlus, IcCheck, IcCopy, IcKey, IcClock, IcDot, IcStar, IcSignal, IcEye, IcEyeOff, IcFollow, IcFollowed, IcSliders, IcAt, IcTag } from "./icons.jsx";
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
      <div style={{ background: "var(--surface)", border: "1px solid var(--hairline-2)", borderRadius: 14, padding: 24, width: 320, maxWidth: "90vw" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700, color: "var(--saffron)" }}>⚡ ZAP {targetProfile?.name || shortPk(targetProfile?.pubkey)}</span>
          <button onClick={onClose} className="iconbtn" style={{ color: "var(--fg-mute)" }}><IcClose/></button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 12 }}>
          {ZAP_PRESETS.map((n) => (
            <button key={n} className="btn sm" onClick={() => { setAmount(n); setCustom(""); }} style={{ background: amount === n && !custom ? "var(--surface-3)" : "transparent", borderColor: amount === n && !custom ? "var(--saffron)" : "var(--hairline-2)", color: amount === n && !custom ? "var(--saffron)" : "var(--fg-dim)" }}>
              ⚡ {formatSats(n)}
            </button>
          ))}
        </div>
        <input className="input mono" style={{ marginBottom: 14 }} type="number" placeholder="Custom amount (sats)" value={custom} onChange={(e) => setCustom(e.target.value)} min="1"/>
        {status !== "idle" && status !== "error" && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: status === "success" ? "var(--green)" : "var(--saffron)", textAlign: "center", marginBottom: 12, padding: "8px", background: "var(--surface-2)", borderRadius: 8 }}>{statusMsg[status]}</div>
        )}
        {status === "error" && <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--red)", marginBottom: 12, lineHeight: 1.6, whiteSpace: "pre-line" }}>{error}</div>}
        {status !== "success" && (
          <button onClick={doZap} disabled={["fetching","invoice","paying"].includes(status)} className="btn primary" style={{ width: "100%", opacity: ["fetching","invoice","paying"].includes(status) ? 0.5 : 1 }}>
            {["fetching","invoice","paying"].includes(status) ? "..." : `⚡ ZAP ${formatSats(finalAmount)} SATS`}
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
              <span style={{ fontFamily: "var(--mono)", fontSize: 24, fontWeight: 700, color: "var(--saffron)" }}>21,000 sats</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-mute)" }}> / 30 days</span>
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
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", display: "grid", gridTemplateColumns: tweaks.showKitchen && view === "feed" ? "220px 1fr 280px" : "220px 1fr", gridTemplateRows: "1fr" }}>
      {/* Modals */}
      {zapModal && <ZapModal targetProfile={zapModal.profile} targetEvent={zapModal.event} sk={sk} pk={pk} relays={relays} onClose={() => setZapModal(null)}/>}
      {showProModal && <ProModal pk={pk} onClose={() => setShowProModal(false)} onProActivated={() => setIsPro(true)}/>}

      {/* LEFT SIDEBAR */}
      <div style={{ background: "var(--surface)", borderRight: "1px solid var(--hairline)", display: "flex", flexDirection: "column", height: "100vh", overflowY: "auto", padding: "20px 16px" }}>
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
      <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", height: "100vh" }}>
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
              <input className="input" placeholder="Search by name..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingRight: 36 }}/>
              <IcSearch size={14} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "var(--fg-mute)", pointerEvents: "none" }}/>
            </div>
            {search && Object.values(profiles).filter((p) => p.name?.toLowerCase().includes(search.toLowerCase()) || p.nip05?.toLowerCase().includes(search.toLowerCase())).slice(0, 20).map((p) => (
              <div key={p.pubkey} onClick={() => openProfile(p.pubkey)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--hairline)", cursor: "pointer" }}>
                <Avatar profile={p} size={40} isPro={proProfiles.has(p.pubkey)}/>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="post-name">{p.name || shortPk(p.pubkey)}</span>
                    {proProfiles.has(p.pubkey) && <ProBadge/>}
                  </div>
                  <div className="post-handle">@{p.nip05 || shortPk(p.pubkey)}</div>
                </div>
              </div>
            ))}
            <div className="section-title" style={{ marginTop: 24 }}>Global Feed <span className="line"/></div>
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
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)", marginTop: 2 }}>21,000 sats / 30 days · Pay with Lightning</div>
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

            <div className="section-title" style={{ marginTop: 24 }}>Danger Zone <span className="line"/></div>
            <button onClick={logout} className="btn" style={{ borderColor: "var(--red)", color: "var(--red)", marginTop: 8 }}>LOG OUT & CLEAR DATA</button>
            <div className="eyebrow" style={{ color: "var(--red)", marginTop: 6 }}>Save your keys before logging out!</div>
          </div>
        )}
      </div>

      {/* RIGHT PANEL - KITCHEN */}
      {tweaks.showKitchen && view === "feed" && <FeedKitchen state={kitchen} setState={setKitchen} relays={relays}/>}

      {/* TWEAKS PANEL (floating) */}
      {showTweaks && <TweaksPanel tweaks={tweaks} setTweaks={setTweaks}/>}
    </div>
  );
}
