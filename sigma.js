// watch_dynmap_simple.js
// Simple Puppeteer watcher for dynmap_world.json responses.
// Also supports a one-off "compress-now" mode used by CI/tests.

const puppeteer = require("puppeteer");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");

const START_URL = "https://map.ccnetmc.com/nationsmap/";
const WATCH_SUBSTRING = "dynmap_world.json";
const RAW_CACHE_TTL = 60;
const PROCESSED_CACHE_TTL = 3 * 24 * 60 * 60;
const PROCESS_INTERVAL_MS = 500;
const OUTPUT_DIR = path.resolve(process.cwd(), "processed_dynmap");

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function readableTs(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}-${String(d.getSeconds()).padStart(2, "0")}`;
}

function todayName(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "");
}

function extractPlayers(json, capturedAt) {
  if (!json) return [];
  const players = json.players || [];
  const out = [];

  function parseName(rawName) {
    if (!rawName) return { name: "unknown", rank: null };
    let name = stripHtml(rawName).trim();
    let rank = null;

    const rankMatch = name.match(/\[(.*?)\]/);
    if (rankMatch) {
      rank = rankMatch[1].trim();
      name = name.replace(/\[.*?\]/g, "").trim();
    }

    name = name.replace(/~/g, "").trim();
    return { name, rank };
  }

  if (Array.isArray(players)) {
    for (const p of players) {
      if (p && p.world === "world") {
        const { name, rank } = parseName(p.name || p.player || "unknown");
        out.push({
          player: name,
          rank,
          x: Number(p.x),
          z: Number(p.z),
          originalTimestamp: capturedAt
        });
      }
    }
  } else if (typeof players === "object") {
    for (const k of Object.keys(players)) {
      const p = players[k];
      if (p && p.world === "world") {
        const { name, rank } = parseName(p.name || k);
        out.push({
          player: name,
          rank,
          x: Number(p.x),
          z: Number(p.z),
          originalTimestamp: capturedAt
        });
      }
    }
  }

  return out;
}

function saveFinal(data, label, ts) {
  const filename = `players_${label}_${readableTs(ts)}.json`;
  const full = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(full, JSON.stringify(data, null, 2), "utf8");
  console.log("Saved:", full);
}

function readJsonArray(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function compressNow() {
  const sourceFiles = fs
    .readdirSync(OUTPUT_DIR)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => name !== "index.json")
    .filter((name) => !name.endsWith("_compressed.json"));

  const data = sourceFiles.flatMap((name) => readJsonArray(path.join(OUTPUT_DIR, name)));
  const outputName = `${todayName()}_compressed.json`;
  const outputPath = path.join(OUTPUT_DIR, outputName);
  const payload = {
    meta: {
      createdAt: new Date().toISOString(),
      originalFileCount: sourceFiles.length,
      sourceFiles
    },
    data
  };

  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");

  const indexPath = path.join(OUTPUT_DIR, "index.json");
  let index = { files: [] };
  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    } catch {
      index = { files: [] };
    }
  }

  index.files = Array.isArray(index.files) ? index.files : [];
  if (!index.files.includes(outputName)) {
    index.files.push(outputName);
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
  console.log(`Compressed ${sourceFiles.length} files into ${outputName}`);
}

const rawCache = new NodeCache({ stdTTL: RAW_CACHE_TTL, checkperiod: 1, useClones: false });
const processedCache = new NodeCache({ stdTTL: PROCESSED_CACHE_TTL, checkperiod: 60, useClones: false });

rawCache.on("expired", (key, value) => {
  try {
    const { url, json, capturedAt } = value;

    let extracted = processedCache.get(url);
    if (!extracted) {
      extracted = extractPlayers(json, capturedAt);
      processedCache.set(url, extracted);
    }

    const m = url.match(/[_?&]_=?(?:_2=)?(\d{9,})/);
    const label = m ? m[1] : String(capturedAt);
    saveFinal(extracted, label, capturedAt);
  } catch (e) {
    console.error("Error on raw cache expired:", e.message);
  }
});

let processingInterval = null;
function startWorker() {
  if (processingInterval) return;
  processingInterval = setInterval(() => {
    const keys = rawCache.keys();
    for (const key of keys) {
      const entry = rawCache.get(key);
      if (!entry) continue;
      try {
        extractPlayers(entry.json, entry.capturedAt);
      } catch {
        // Keep the watcher alive even if one payload is malformed.
      }
    }
  }, PROCESS_INTERVAL_MS);
}

async function runWatcher() {
  console.log("Launching watcher...");
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!url || !url.includes(WATCH_SUBSTRING)) return;

      let text;
      try {
        text = await response.text();
      } catch {
        return;
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }

      const capturedAt = Date.now();
      rawCache.set(url, { url, json, capturedAt });
      startWorker();
    } catch {
      // Ignore individual response errors to keep the watcher alive.
    }
  });

  await page.goto(START_URL, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});

  console.log("Watcher running; listening for network responses containing:", WATCH_SUBSTRING);
  console.log("Output directory:", OUTPUT_DIR);
}

async function main() {
  if (process.argv[2] === "compress-now") {
    compressNow();
    return;
  }

  await runWatcher();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
