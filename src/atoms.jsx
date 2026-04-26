// ======================== ATOMS ========================
import React, { useState, useRef } from "react";
import { IcStar } from "./icons.jsx";

export function Avatar({ profile, size = 38, showRing = false, isPro = false, onClick }) {
  if (!profile) return null;
  const hue = profile.avatarHue || ((profile.name || "").charCodeAt(0) * 7) % 360 || 30;
  const bg = `oklch(0.35 0.06 ${hue})`;
  const fg = `oklch(0.85 0.08 ${hue})`;
  const initials = (profile.name || profile.display_name || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
  const hasPic = profile.picture && typeof profile.picture === "string";

  return (
    <div className="avatar" onClick={onClick} style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.36, cursor: onClick ? "pointer" : "default" }}>
      {hasPic ? (
        <img src={profile.picture} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { e.target.style.display = "none"; }} />
      ) : initials}
      {(showRing || isPro) && <span className="ring" style={{ borderColor: isPro ? "var(--accent)" : "var(--hairline-2)" }} />}
    </div>
  );
}

export function ProBadge() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".1em", fontWeight: 700 }}>
      <IcStar size={9} filled /> PRO
    </span>
  );
}

export function PostImage({ src }) {
  const [err, setErr] = useState(false);
  if (!src || err) return null;
  return (
    <div style={{ marginTop: 10, borderRadius: 10, overflow: "hidden", border: "1px solid var(--hairline-2)" }}>
      <img src={src} alt="" onError={() => setErr(true)} style={{ width: "100%", display: "block", maxHeight: 400, objectFit: "cover" }} />
    </div>
  );
}

export function Switch({ on, onChange }) {
  return <div className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

export function Dial({ value, max = 1, label, valueLabel, onChange, size = 72 }) {
  const angle = -135 + (value / max) * 270;
  const dragRef = useRef(null);
  const onMouseDown = () => {
    const el = dragRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const move = (ev) => {
      const a = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
      let norm = a; if (norm < -135) norm += 360; if (norm > 225) norm -= 360;
      const clamped = Math.max(-135, Math.min(135, norm));
      const v = (clamped + 135) / 270;
      onChange && onChange(v * max);
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div className="dial" ref={dragRef} onMouseDown={onMouseDown} style={{ width: size, height: size }}>
        <div className="dial-needle" style={{ transform: `translate(-50%, -100%) rotate(${angle}deg)` }} />
        <div className="dial-dot" />
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const a = -135 + t * 270;
          return <div key={i} style={{ position: "absolute", left: "50%", top: "50%", width: 1, height: 4, background: "var(--hairline-2)", transform: `translate(-50%, -${size / 2 - 2}px) rotate(${a}deg)`, transformOrigin: "50% 100%" }} />;
        })}
      </div>
      <div className="dial-label">{label}</div>
      <div className="dial-val">{valueLabel}</div>
    </div>
  );
}

export function PostBody({ text, density = "default" }) {
  return <div className={`post-body ${density}`}>{text}</div>;
}

export function PostMeta({ profile, ts, isPro, onProfile, timeAgo }) {
  const name = profile?.name || profile?.display_name || "anon";
  const handle = profile?.nip05 || "";
  return (
    <div className="post-meta">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="post-name" style={{ cursor: "pointer" }} onClick={onProfile}>{name}</span>
        {isPro && <ProBadge />}
        <span className="post-time">{ts ? `· ${timeAgo(ts)}` : ""}</span>
      </div>
      {handle && <div className="post-handle">@{handle}</div>}
    </div>
  );
}

export function Tag({ children }) {
  return <span className="tag">{children}</span>;
}

export function DaySeparator({ ts }) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const label = isToday ? "TODAY" : isYesterday ? "YESTERDAY" : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "22px 0 10px" }}>
      <div className="eyebrow" style={{ color: "var(--accent)", whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ flex: 1, height: 1, background: "var(--hairline)" }} />
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)" }}>{d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
    </div>
  );
}
