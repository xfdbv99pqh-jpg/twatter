// ======================== TWEAKS PANEL ========================
import React from "react";
import { Switch } from "./atoms.jsx";
import { IcSliders, IcColumn, IcGrid, IcReader, IcScrub } from "./icons.jsx";

export function defaultTweaks() {
  return {
    layout: "column",
    accent: "tan",
    density: "default",
    fontPair: "serif",
    showKitchen: true,
    showManifesto: true,
  };
}

export function TweaksPanel({ tweaks, setTweaks }) {
  const setKey = (k, v) => setTweaks(t => ({ ...t, [k]: v }));

  const accents = [
    ["tan", "#c89872", "#a6724a"],
    ["olive", "#9ba872", "#7a874a"],
    ["rose", "#c87a8e", "#a65466"],
    ["indigo", "#8a8fc7", "#6268a6"],
    ["moss", "#7aa872", "#56854e"],
    ["amber", "#e0a64a", "#b87f2e"],
  ];

  const layouts = [
    ["column", "Column", IcColumn],
    ["newspaper", "Newspaper", IcGrid],
    ["reader", "Reader", IcReader],
    ["scrubber", "Scrubber", IcScrub],
  ];

  return (
    <div style={{
      position: "fixed", right: 20, bottom: 20, zIndex: 50,
      background: "var(--surface)", border: "1px solid var(--hairline-2)",
      borderRadius: 12, padding: "16px 18px", width: 280,
      boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
      fontFamily: "var(--sans)"
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <IcSliders size={14} color="var(--accent)" />
          <span className="eyebrow" style={{ color: "var(--accent)" }}>Tweaks</span>
        </div>
      </div>

      <div className="eyebrow" style={{ fontSize: 9, marginBottom: 6 }}>Layout</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 14 }}>
        {layouts.map(([v, l, Icon]) => (
          <button key={v} onClick={() => setKey("layout", v)} className="btn sm" style={{
            display: "flex", alignItems: "center", gap: 6, justifyContent: "center",
            background: tweaks.layout === v ? "var(--surface-3)" : "transparent",
            borderColor: tweaks.layout === v ? "var(--accent)" : "var(--hairline-2)",
            color: tweaks.layout === v ? "var(--accent)" : "var(--fg-dim)",
            textTransform: "none", letterSpacing: 0, fontSize: 11, padding: "7px 6px"
          }}>
            <Icon size={12} /> {l}
          </button>
        ))}
      </div>

      <div className="eyebrow" style={{ fontSize: 9, marginBottom: 6 }}>Accent</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {accents.map(([n, c, d]) => (
          <button key={n} onClick={() => {
            setKey("accent", n);
            document.documentElement.style.setProperty('--accent', c);
            document.documentElement.style.setProperty('--accent-deep', d);
          }} style={{
            width: 24, height: 24, borderRadius: "50%", border: tweaks.accent === n ? "2px solid var(--fg)" : "1px solid var(--hairline-2)",
            background: c, cursor: "pointer", padding: 0
          }} title={n} />
        ))}
      </div>

      <div className="eyebrow" style={{ fontSize: 9, marginBottom: 6 }}>Density</div>
      <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
        {["compact", "default", "comfy"].map(d => (
          <button key={d} onClick={() => {
            setKey("density", d);
            document.documentElement.setAttribute('data-density', d);
          }} className="btn sm" style={{
            flex: 1,
            background: tweaks.density === d ? "var(--surface-3)" : "transparent",
            borderColor: tweaks.density === d ? "var(--accent)" : "var(--hairline-2)",
            color: tweaks.density === d ? "var(--accent)" : "var(--fg-dim)",
            textTransform: "capitalize", letterSpacing: 0, fontSize: 10
          }}>{d}</button>
        ))}
      </div>

      <div className="eyebrow" style={{ fontSize: 9, marginBottom: 6 }}>Body font</div>
      <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
        {[["serif", "Serif", "var(--serif)"], ["sans", "Sans", "var(--sans)"], ["mono", "Mono", "var(--mono)"]].map(([v, l, ff]) => (
          <button key={v} onClick={() => {
            setKey("fontPair", v);
            const styleEl = document.getElementById("tweak-font-style") || (() => { const s = document.createElement("style"); s.id = "tweak-font-style"; document.head.appendChild(s); return s; })();
            styleEl.textContent = v === "sans" ? ".post-body{font-family:var(--sans)!important}" : v === "mono" ? ".post-body{font-family:var(--mono)!important;font-size:14px!important}" : "";
          }} className="btn sm" style={{
            flex: 1,
            background: tweaks.fontPair === v ? "var(--surface-3)" : "transparent",
            borderColor: tweaks.fontPair === v ? "var(--accent)" : "var(--hairline-2)",
            color: tweaks.fontPair === v ? "var(--accent)" : "var(--fg-dim)",
            textTransform: "none", letterSpacing: 0, fontSize: 10, padding: "5px 4px",
            fontFamily: ff
          }}>Aa</button>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0" }}>
        <span style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--fg-dim)" }}>Show kitchen panel</span>
        <Switch on={tweaks.showKitchen} onChange={(v) => setKey("showKitchen", v)} />
      </div>
    </div>
  );
}
