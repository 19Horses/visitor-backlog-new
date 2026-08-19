import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { S3Client, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import multer from "multer";
import path from "path";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000; // Default to 3000 if not set

const REGION = process.env.AWS_REGION; // Default to us-east-1 if not set
const BUCKET_NAME =process.env.BUCKET_NAME; // Replace with your actual bucket name
const BASE_URL = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/`;

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

app.use(cors());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Telegram's HTML parse mode only treats these three as markup
const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// The three uploads share a base name, so the photo's key follows from the
// form's: data/<name>-<stamp>.json -> images/<name>-<stamp>-dithered.png
const ditheredUrlFor = (dataKey) => {
  const base = dataKey.replace(/^data\//, "").replace(/\.json$/, "");
  return `${BASE_URL}images/${encodeURIComponent(`${base}-dithered.png`)}`;
};

// The uploads run in parallel, so the image may not have landed when the form
// does. Note S3 answers 403 rather than 404 for a missing object here, since
// anonymous callers cannot list the bucket - so this checks for a positive OK
// rather than for a 404.
async function waitForObject(url, attempts = 6, delayMs = 1000) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) return true;
    } catch {
      // network hiccup, treat as not ready yet
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

async function callTelegram(method, payload) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, ...payload }),
      },
    );

    if (!response.ok) {
      console.error(
        `Telegram ${method} failed:`,
        response.status,
        await response.text(),
      );
    }
    return response.ok;
  } catch (err) {
    console.error(`Telegram ${method} failed:`, err);
    return false;
  }
}

// Announces a new visitor log entry. Never throws: an alert failing must not
// fail the upload that triggered it, and the entry is already safely in S3 by
// the time this runs.
async function notifyNewEntry(key, buffer) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  let entry;
  try {
    entry = JSON.parse(buffer.toString("utf8"));
  } catch (err) {
    console.error("Telegram notify: form data was not valid JSON:", err);
    return;
  }

  const field = (value) => escapeHtml(value).trim() || "—";
  const text = [
    "<b>New visitor log entry</b>",
    "",
    `<b>Name:</b> ${field(entry.username)}`,
    `<b>Role:</b> ${field(entry.profession)}`,
    "",
    `<b>Q:</b> ${field(entry.question)}`,
    `<b>A:</b> ${field(entry.answer)}`,
  ].join("\n");

  const photo = ditheredUrlFor(key);
  const hasPhoto = await waitForObject(photo);

  if (hasPhoto) {
    // Telegram caps a photo caption at 1024 characters. The form's own limits
    // keep it far below that, but rather than risk truncating mid-tag and
    // breaking the HTML parse, an oversized one goes as its own message.
    if (text.length <= 1024) {
      await callTelegram("sendPhoto", {
        photo,
        caption: text,
        parse_mode: "HTML",
      });
      return;
    }

    await callTelegram("sendPhoto", { photo });
  }

  await callTelegram("sendMessage", {
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function listFiles(prefix) {
  const command = new ListObjectsV2Command({
    Bucket: BUCKET_NAME,
    Prefix: prefix,
  });

  try {
    const data = await s3.send(command);
    const contents = data.Contents || [];

    return contents
      .filter((item) => !item.Key.endsWith("/"))
      .map((item) => ({
        key: item.Key,
        url: `${BASE_URL}${item.Key}`,
      }));
  } catch (err) {
    console.error("S3 list error:", err);
    throw err;
  }
}

app.get("/api/images", async (req, res) => {
  try {
    const files = await listFiles("images/");
    res.json(files);
  } catch {
    res.status(500).json({ error: "Failed to list images" });
  }
});

app.get("/api/data", async (req, res) => {
  try {
    const files = await listFiles("data/");
    res.json(files);
  } catch {
    res.status(500).json({ error: "Failed to list data files" });
  }
});

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});


app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});

// Configure multer for file handling
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.post("/api/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  const { key, contentType } = req.body;

  if (!file || !key || !contentType) {
    return res.status(400).json({ error: "Missing file, key, or contentType" });
  }

  const params = {
    Bucket: BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: contentType,
  };

  try {
    const command = new PutObjectCommand(params);
    await s3.send(command);

    res.status(200).json({
      message: "Upload successful",
      key,
      url: `${BASE_URL}${key}`,
    });

    // One visitor produces three uploads - the dithered image, the undithered
    // original and the form JSON - so keying on the JSON alerts exactly once
    // per entry, and it is the only one carrying the answers. Deliberately not
    // awaited: the client already has its response.
    if (key.startsWith("data/")) {
      notifyNewEntry(key, file.buffer);
    }
  } catch (err) {
    console.error("S3 Upload Failed:", err);
    res.status(500).json({ error: "Failed to upload to S3" });
  }
});

