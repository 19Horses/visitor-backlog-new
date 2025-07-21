import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

dotenv.config();

const app = express();
const PORT = 4000;

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

app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});
