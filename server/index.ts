import { createServer } from "node:http";
import { createHandler } from "./app.js";
import { openDb } from "./db.js";

const port = Number(process.env["PORT"] ?? "3001");
const dbPath = process.env["DB_PATH"] ?? "./data/leaderboard.db";

const db = openDb(dbPath);
const server = createServer(createHandler(db));

server.listen(port, () => {
  console.log(`leaderboard api listening on :${port} (db: ${dbPath})`);
});
