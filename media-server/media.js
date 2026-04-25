// ================================================================
// TWATTER MEDIA SERVER — Image hosting for Nostr posts & DMs
// ================================================================
// Upload: POST /upload (multipart form, field: "file")
// Serve:  GET /<hash>.webp
// ================================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Busboy = require("busboy");

let sharp;
try { sharp = require("sharp"); } catch { sharp = null; }

// ======================== CONFIG ========================
const PORT = parseInt(process.env.PORT || "7778");
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || String(10 * 1024 * 1024)); // 10MB
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"]);
const MAX_DIMENSION = 2048; // Max width/height after resize

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ======================== SERVER ========================
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ---- UPLOAD ----
  if (req.method === "POST" && req.url === "/upload") {
    return handleUpload(req, res);
  }

  // ---- SERVE IMAGE ----
  if (req.method === "GET" && req.url !== "/" && req.url !== "/health") {
    return handleServe(req, res);
  }

  // ---- HEALTH ----
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    const files = fs.readdirSync(UPLOAD_DIR).length;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", name: "Twatter Media Server", files, maxSize: MAX_FILE_SIZE }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

function handleUpload(req, res) {
  let fileSize = 0;
  let fileType = null;
  let chunks = [];
  let finished = false;

  const busboy = Busboy({
    headers: req.headers,
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  });

  busboy.on("file", (fieldname, stream, info) => {
    fileType = info.mimeType;
    if (!ALLOWED_TYPES.has(fileType)) {
      finished = true;
      stream.resume();
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unsupported file type. Allowed: jpeg, png, gif, webp, svg" }));
      return;
    }

    stream.on("data", (chunk) => {
      fileSize += chunk.length;
      if (fileSize > MAX_FILE_SIZE) {
        stream.destroy();
        if (!finished) {
          finished = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `File too large. Max: ${MAX_FILE_SIZE / 1024 / 1024}MB` }));
        }
        return;
      }
      chunks.push(chunk);
    });

    stream.on("end", async () => {
      if (finished) return;
      finished = true;

      try {
        let buffer = Buffer.concat(chunks);
        const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
        let ext = "webp";
        let contentType = "image/webp";

        // Process with sharp if available (resize + convert to webp)
        if (sharp && fileType !== "image/svg+xml" && fileType !== "image/gif") {
          try {
            const metadata = await sharp(buffer).metadata();
            let pipeline = sharp(buffer);
            if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
              pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true });
            }
            buffer = await pipeline.webp({ quality: 85 }).toBuffer();
          } catch (e) {
            console.warn("Sharp processing failed, saving original:", e.message);
            ext = fileType.split("/")[1] || "bin";
            contentType = fileType;
          }
        } else if (fileType === "image/gif") {
          ext = "gif";
          contentType = "image/gif";
        } else if (fileType === "image/svg+xml") {
          ext = "svg";
          contentType = "image/svg+xml";
        }

        const filename = `${hash}.${ext}`;
        const filepath = path.join(UPLOAD_DIR, filename);
        fs.writeFileSync(filepath, buffer);

        const url = `${BASE_URL}/${filename}`;
        console.log(`[upload] ${filename} (${(buffer.length / 1024).toFixed(1)}KB) from ${req.socket.remoteAddress}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          url,
          hash,
          size: buffer.length,
          type: contentType,
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to process upload" }));
      }
    });
  });

  busboy.on("error", () => {
    if (!finished) {
      finished = true;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Upload failed" }));
    }
  });

  req.pipe(busboy);
}

function handleServe(req, res) {
  const filename = path.basename(req.url.split("?")[0]);
  // Sanitize: only allow alphanumeric + dot + known extensions
  if (!/^[a-f0-9]+\.(webp|jpg|jpeg|png|gif|svg)$/i.test(filename)) {
    res.writeHead(400);
    res.end("Invalid filename");
    return;
  }

  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const types = { ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".svg": "image/svg+xml" };
  const contentType = types[ext] || "application/octet-stream";
  const stat = fs.statSync(filepath);

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": "public, max-age=31536000, immutable",
    "ETag": `"${filename}"`,
  });

  fs.createReadStream(filepath).pipe(res);
}

// ======================== START ========================
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║       TWATTER MEDIA SERVER v1.0.0        ║
  ║──────────────────────────────────────────║
  ║  Upload:   POST ${BASE_URL}/upload
  ║  Serve:    GET  ${BASE_URL}/<hash>.webp
  ║  Storage:  ${UPLOAD_DIR.padEnd(30)}║
  ║  Max size: ${(MAX_FILE_SIZE / 1024 / 1024)}MB${" ".repeat(28)}║
  ╚══════════════════════════════════════════╝
  `);
  if (!sharp) console.log("  ⚠ sharp not installed — images won't be resized/optimized\n    Run: npm install sharp\n");
});

process.on("SIGINT", () => { console.log("\nShutting down..."); process.exit(0); });
