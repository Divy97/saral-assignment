import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// pg terminates the process on an idle-client error unless this is handled.
pool.on("error", (err) => {
  console.error("unexpected pg pool error", err);
});
