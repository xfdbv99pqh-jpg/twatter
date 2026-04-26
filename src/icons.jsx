// ======================== ICONS ========================
import React from "react";

const mkIcon = (paths, extra = {}) => ({ size = 18, stroke = 1.75, color = "currentColor", style, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={extra.fill || "none"} stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={style} {...rest}>
    {paths}
  </svg>
);

export const IcHome = mkIcon(<><path d="M3 11.5 12 4l9 7.5" /><path d="M5 10.5V20h14v-9.5" /></>);
export const IcGlobe = mkIcon(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>);
export const IcMail = mkIcon(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>);
export const IcUser = mkIcon(<><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6" /></>);
export const IcSettings = mkIcon(<><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>);
export const IcSearch = mkIcon(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>);
export const IcCompose = mkIcon(<><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" /></>);
export const IcHeart = ({ filled, ...p }) => mkIcon(<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />, { fill: filled ? "currentColor" : "none" })(p);
export const IcReply = mkIcon(<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);
export const IcZap = ({ filled, ...p }) => mkIcon(<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />, { fill: filled ? "currentColor" : "none" })(p);
export const IcRepost = mkIcon(<><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>);
export const IcShare = mkIcon(<><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" /><path d="m16 6-4-4-4 4" /><path d="M12 2v13" /></>);
export const IcImage = mkIcon(<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" /><path d="m21 15-5-5L5 21" /></>);
export const IcLink = mkIcon(<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>);
export const IcSend = mkIcon(<><path d="M22 2 11 13" /><path d="m22 2-7 20-4-9-9-4 20-7z" /></>);
export const IcBack = mkIcon(<><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>);
export const IcClose = mkIcon(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
export const IcPlus = mkIcon(<><path d="M12 5v14" /><path d="M5 12h14" /></>);
export const IcCheck = mkIcon(<path d="m20 6-11 11-5-5" />);
export const IcCopy = mkIcon(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
export const IcKey = mkIcon(<><circle cx="8" cy="16" r="4" /><path d="m10.85 13.15 9.4-9.4" /><path d="m17 7 3-3" /></>);
export const IcClock = mkIcon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IcFilter = mkIcon(<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />);
export const IcTag = mkIcon(<><path d="M20.59 13.41 13 21l-8-8V5h8l8 8.41z" /><circle cx="9" cy="9" r="1" fill="currentColor" /></>);
export const IcSlash = mkIcon(<><circle cx="12" cy="12" r="9" /><path d="m4.93 4.93 14.14 14.14" /></>);
export const IcEye = mkIcon(<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></>);
export const IcEyeOff = mkIcon(<><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.3 21.3 0 0 1 5.06-6.06" /><path d="M9.9 4.24A10.7 10.7 0 0 1 12 4c7 0 11 8 11 8a21 21 0 0 1-3.22 4.27" /><path d="m1 1 22 22" /><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88" /></>);
export const IcFollow = mkIcon(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M20 8v6M17 11h6" /></>);
export const IcFollowed = mkIcon(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="m17 11 2 2 4-4" /></>);
export const IcStar = ({ filled, ...p }) => mkIcon(<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />, { fill: filled ? "currentColor" : "none" })(p);
export const IcGrid = mkIcon(<><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>);
export const IcColumn = mkIcon(<><rect x="3" y="3" width="18" height="18" /><path d="M12 3v18" /></>);
export const IcReader = mkIcon(<><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></>);
export const IcScrub = mkIcon(<><path d="M3 12h18" /><circle cx="9" cy="12" r="2" fill="currentColor" /></>);
export const IcSignal = mkIcon(<><path d="M2 20h3M8 16h3M14 12h3M20 8h3" /><path d="M2 20a18 18 0 0 1 22-12" /></>);
export const IcDot = ({ color = "currentColor", size = 8, style, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 8 8" style={style} {...p}><circle cx="4" cy="4" r="4" fill={color} /></svg>
);
export const IcChevron = mkIcon(<path d="m9 18 6-6-6-6" />);
export const IcAt = mkIcon(<><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>);
export const IcSliders = mkIcon(<><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></>);
