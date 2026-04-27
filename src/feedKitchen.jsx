// ======================== FEED KITCHEN ========================
import React, { useState } from "react";
import { Switch } from "./atoms.jsx";
import { IcClock, IcClose, IcSlash, IcDot } from "./icons.jsx";

export function defaultKitchenState() {
  return {
    source: "following",
    order: "newest",
    timeHours: 24 * 7,
    volume: 0.6,
    showReplies: false,
    showImages: true,
    showReposts: true,
    showLinks: true,
    mutes: [],
    disabledRelays: [],
  };
}

export function countDialDiff(k) {
  const d = defaultKitchenState();
  let n = 0;
  for (const key of ["source", "order", "timeHours", "showReplies", "showImages", "showReposts"]) {
    if (k[key] !== d[key]) n++;
  }
  if (k.mutes.length) n++;
  if (k.disabledRelays.length) n++;
  return n;
}

export function FeedKitchen({ state, setState, relays }) {
  const setKey = (k, v) => setState(s => ({ ...s, [k]: v }));

  const timeLabel = () => {
    const h = state.timeHours;
    if (h <= 1) return "LAST HOUR";
    if (h <= 6) return `${Math.round(h)}H`;
    if (h <= 24) return "24H";
    if (h <= 24 * 7) return `${Math.round(h / 24)}D`;
    return "ALL TIME";
  };

  const volumeLabel = () => {
    const v = state.volume;
    if (v < 0.33) return "QUIET";
    if (v < 0.66) return "STEADY";
    return "LOUD";
  };

  const addMute = (word) => {
    const w = word.trim().toLowerCase();
    if (!w || state.mutes.includes(w)) return;
    setKey("mutes", [...state.mutes, w]);
  };
  const removeMute = (word) => setKey("mutes", state.mutes.filter(m => m !== word));
  const [muteDraft, setMuteDraft] = useState("");

  const toggleRelay = (url) => {
    setKey("disabledRelays",
      state.disabledRelays.includes(url)
        ? state.disabledRelays.filter(r => r !== url)
        : [...state.disabledRelays, url]
    );
  };

  return (
    <div style={{ padding: "18px 18px 24px", background: "var(--surface)", borderLeft: "1px solid var(--hairline)", height: "100%", overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div>
          <div className="eyebrow" style={{ color: "var(--accent)" }}>Feed Kitchen</div>
          <div style={{ fontFamily: "var(--serif)", fontSize: 22, color: "var(--fg)", marginTop: 4, letterSpacing: "-.01em", fontStyle: "italic", fontWeight: 500 }}>you are the algorithm</div>
        </div>
      </div>
      <p style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--fg-faint)", marginTop: 10, lineHeight: 1.55 }}>
        twatter doesn't rank your feed. these are the dials <em style={{ fontFamily: "var(--serif)", fontStyle: "italic", color: "var(--fg-dim)" }}>you</em> turn instead of an algorithm turning them for you.
      </p>

      {/* Source */}
      <div className="section-title" style={{ marginTop: 22 }}>Source <span className="line" /></div>
      <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
        {[["following", "Following"], ["global", "Global"], ["lists", "Lists"]].map(([v, l]) => (
          <button key={v} onClick={() => setKey("source", v)} className="btn sm" style={{
            flex: 1,
            background: state.source === v ? "var(--surface-3)" : "transparent",
            borderColor: state.source === v ? "var(--accent)" : "var(--hairline-2)",
            color: state.source === v ? "var(--accent)" : "var(--fg-dim)"
          }}>{l}</button>
        ))}
      </div>

      {/* Sort direction */}
      <div className="section-title" style={{ marginTop: 18 }}>Order <span className="line" /></div>
      <div style={{ display: "flex", gap: 6 }}>
        {[["newest", "Newest", "↓"], ["oldest", "Oldest", "↑"]].map(([v, l, arrow]) => (
          <button key={v} onClick={() => setKey("order", v)} className="btn sm" style={{
            flex: 1,
            background: state.order === v ? "var(--surface-3)" : "transparent",
            borderColor: state.order === v ? "var(--accent)" : "var(--hairline-2)",
            color: state.order === v ? "var(--accent)" : "var(--fg-dim)",
            textTransform: "none", letterSpacing: 0, fontSize: 10
          }}>{arrow} {l}</button>
        ))}
      </div>

      {/* Sliders */}
      <div className="section-title" style={{ marginTop: 22 }}>Dials <span className="line" /></div>
      <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".1em", color: "var(--fg-faint)", textTransform: "uppercase" }}>Time</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>{timeLabel()}</span>
          </div>
          <input type="range" className="kitchen-slider" min="0" max="1000" value={Math.round(Math.log(state.timeHours + 1) / Math.log(168 + 1) * 1000)} onChange={(e) => { const v = e.target.value / 1000; setKey("timeHours", Math.round(Math.exp(v * Math.log(168 + 1)) - 1)); }} />
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".1em", color: "var(--fg-faint)", textTransform: "uppercase" }}>Volume</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>{volumeLabel()}</span>
          </div>
          <input type="range" className="kitchen-slider" min="0" max="1000" value={Math.round(state.volume * 1000)} onChange={(e) => setKey("volume", e.target.value / 1000)} />
        </div>
      </div>

      {/* Toggles */}
      <div className="section-title" style={{ marginTop: 22 }}>Show <span className="line" /></div>
      {[["showReplies", "Replies"], ["showImages", "Images"], ["showReposts", "Reposts"], ["showLinks", "Link previews"]].map(([k, l]) => (
        <div key={k} className="kv">
          <span className="kv-k" style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg-dim)" }}>{l}</span>
          <Switch on={state[k]} onChange={(v) => setKey(k, v)} />
        </div>
      ))}

      {/* Mute words */}
      <div className="section-title" style={{ marginTop: 18 }}>Mute words <span className="line" /></div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="input mono"
          placeholder="word or @handle"
          value={muteDraft}
          onChange={(e) => setMuteDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { addMute(muteDraft); setMuteDraft(""); } }}
          style={{ flex: 1, padding: "7px 10px", fontSize: 11 }}
        />
        <button className="btn sm primary" onClick={() => { addMute(muteDraft); setMuteDraft(""); }}>Mute</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
        {state.mutes.length === 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-mute)" }}>nothing muted</span>}
        {state.mutes.map(m => (
          <span key={m} className="chip" style={{ cursor: "pointer" }} onClick={() => removeMute(m)}>
            <IcSlash size={10} stroke={2} /> {m} <IcClose size={9} />
          </span>
        ))}
      </div>

      {/* Relays */}
      <div className="section-title" style={{ marginTop: 22 }}>Relays <span className="line" /></div>
      {relays.map(r => {
        const url = typeof r === "string" ? r : r.url;
        const status = typeof r === "string" ? "connected" : r.status;
        const off = state.disabledRelays.includes(url);
        const color = status === "connected" ? "var(--green)" : status === "connecting" ? "var(--saffron)" : "var(--red)";
        return (
          <div key={url} className="kv" onClick={() => toggleRelay(url)} style={{ cursor: "pointer", opacity: off ? 0.4 : 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <IcDot color={color} size={6} />
              <span className="kv-v" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{url.replace("wss://", "")}</span>
            </div>
          </div>
        );
      })}

      {/* Footer: reset */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--hairline)" }}>
        <button className="btn ghost sm" style={{ width: "100%" }} onClick={() => setState(defaultKitchenState())}>Reset to defaults</button>
      </div>

      {/* The manifesto */}
      <div style={{ marginTop: 24, padding: "14px 14px", background: "var(--surface-2)", border: "1px solid var(--hairline)", borderRadius: 10 }}>
        <div className="eyebrow" style={{ color: "var(--fg-faint)" }}>What twatter is NOT doing</div>
        <ul style={{ listStyle: "none", padding: 0, marginTop: 10, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", lineHeight: 2, letterSpacing: ".02em" }}>
          <li>× ranking posts by engagement</li>
          <li>× injecting "you might like"</li>
          <li>× reordering replies</li>
          <li>× boosting sponsored posts</li>
          <li>× tracking what you scroll</li>
          <li>× A/B testing on you</li>
        </ul>
      </div>
    </div>
  );
}
