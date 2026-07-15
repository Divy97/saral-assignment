import "dotenv/config";
import express from "express";
import { pool } from "../db/pool.js";

const app = express();

// health check endpoint
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "up" });
  } catch (err) {
    console.error("health check failed", err);
    res.status(503).json({ status: "error", db: "down" });
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`[local] listening on :${port}`);
});
