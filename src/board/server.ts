import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Store active missions
const activeMissions = new Map();
const missionLogs: any[] = [];

app.use(express.json());
app.use(express.static(path.join(__dirname, "../../public")));

// API to update mission status (called from main server)
app.post("/api/mission/update", (req, res) => {
  const { threadId, status, step, data } = req.body;

  const mission = {
    threadId,
    status,
    step,
    data,
    timestamp: new Date().toISOString(),
  };

  activeMissions.set(threadId, mission);
  missionLogs.unshift(mission);

  // Keep only last 100 logs
  if (missionLogs.length > 100) {
    missionLogs.pop();
  }

  // Broadcast to all connected clients
  io.emit("mission:update", mission);
  io.emit("stats:update", {
    activeCount: activeMissions.size,
    totalLogs: missionLogs.length,
  });

  res.json({ success: true });
});

// Get all active missions
app.get("/api/missions/active", (req, res) => {
  res.json(Array.from(activeMissions.values()));
});

// Get mission logs
app.get("/api/missions/logs", (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(missionLogs.slice(0, limit));
});

// Clear completed missions
app.post("/api/missions/clear", (req, res) => {
  activeMissions.clear();
  io.emit("missions:cleared");
  res.json({ success: true });
});

// WebSocket connection
io.on("connection", (socket) => {
  console.log("📊 Dashboard client connected");

  // Send initial data
  socket.emit("missions:initial", Array.from(activeMissions.values()));
  socket.emit("logs:initial", missionLogs.slice(0, 50));
  socket.emit("stats:update", {
    activeCount: activeMissions.size,
    totalLogs: missionLogs.length,
  });

  socket.on("disconnect", () => {
    console.log("📊 Dashboard client disconnected");
  });
});

const BOARD_PORT = process.env.BOARD_PORT || 3001;
httpServer.listen(BOARD_PORT, () => {
  console.log(`
  📊 Monitoring Board: http://localhost:${BOARD_PORT}
  `);
});
