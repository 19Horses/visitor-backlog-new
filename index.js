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
  if (!file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const key = `${Date.now()}-${file.originalname}`;

  const params = {
    Bucket: BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  };

  try {
    const command = new PutObjectCommand(params);
    await s3.send(command);
    res.status(200).json({
      message: "Upload successful",
      key,
      url: `${BASE_URL}${key}`,
    });
  } catch (error) {
    console.error("Upload failed:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});
