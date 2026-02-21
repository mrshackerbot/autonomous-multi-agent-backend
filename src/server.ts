import "dotenv/config";
import express from "express";
import {
  getGraphApp,
  sqlTool,
  scraperTool,
  codeTool,
  fileTool,
  memoryStore,
} from "./index.js";
import pino from "pino";
import { ChatOllama } from "@langchain/ollama";
import axios from "axios";
import { config } from "./config.js";
import { securityMiddleware, apiKeyAuth } from "./middleware/security.js";
import { errorHandler, AppError } from "./middleware/errorHandler.js";
import { checkpointManager } from "./utils/checkpointManager.js";

const logger = pino({
  level: config.logging.level,
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

const app = express();
const BOARD_URL = `http://localhost:${config.server.boardPort}`;

// Apply middleware
app.use(express.json());
app.use(securityMiddleware);

// Request logging
app.use((req, res, next) => {
  logger.info(
    {
      method: req.method,
      url: req.url,
      ip: req.ip,
      apiKey: req.headers["x-api-key"] ? "present" : "none",
    },
    "Request",
  );
  next();
});

// Send update to monitoring board
async function sendBoardUpdate(
  threadId: string,
  status: string,
  step?: string,
  data?: any,
) {
  try {
    await axios.post(`${BOARD_URL}/api/mission/update`, {
      threadId,
      status,
      step,
      data,
    });
  } catch (error) {
    // Board might not be running, ignore
  }
}

// Health check (no auth required)
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    environment: config.server.environment,
  });
});

// Protected routes (require API key in production)
app.use("/api", apiKeyAuth);

// --- TOOL ENDPOINTS ---
app.post("/api/tool/sql", async (req, res, next) => {
  try {
    const { query } = req.body;
    if (!query) throw new AppError("Missing query", 400);
    const result = await sqlTool.invoke(query);
    res.json({ success: true, result });
  } catch (error: any) {
    next(new AppError(error.message, 500));
  }
});

app.post("/api/tool/scrape", async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) throw new AppError("Missing URL", 400);
    const result = await scraperTool.invoke(url);
    res.json({ success: true, result });
  } catch (error: any) {
    next(new AppError(error.message, 500));
  }
});

app.post("/api/tool/code", async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) throw new AppError("Missing code", 400);
    const result = await codeTool.invoke(code);
    res.json({ success: true, result });
  } catch (error: any) {
    next(new AppError(error.message, 500));
  }
});

app.post("/api/tool/file", async (req, res, next) => {
  try {
    const { operation, path, content } = req.body;
    if (!operation || !path)
      throw new AppError("Missing operation or path", 400);
    const result = await fileTool.invoke({ operation, path, content });
    res.json({ success: true, result });
  } catch (error: any) {
    next(new AppError(error.message, 500));
  }
});

app.post("/api/memory/add", async (req, res, next) => {
  try {
    const { text, metadata } = req.body;
    if (!text) throw new AppError("Missing text", 400);
    const result = await memoryStore.addMemory(text, metadata);
    res.json({ success: true, result });
  } catch (error: any) {
    next(new AppError(error.message, 500));
  }
});

app.post("/api/memory/recall", async (req, res, next) => {
  try {
    const { query, k } = req.body;
    if (!query) throw new AppError("Missing query", 400);
    const result = await memoryStore.recall(query, k || 5);
    res.json({ success: true, result });
  } catch (error: any) {
    next(new AppError(error.message, 500));
  }
});

// --- MISSION ENDPOINT ---
app.post("/api/mission", async (req, res, next) => {
  const { query, threadId, tools } = req.body;
  const missionId = threadId || `mission-${Date.now()}`;

  logger.info({ missionId, query }, "🎯 Mission received");

  if (!query) {
    return next(new AppError("Missing query", 400));
  }

  try {
    const graph = await getGraphApp();

    const initialState = {
      input: query,
      output: "",
      steps: [],
      research: "",
      plan: null,
      critiqueResult: null,
      iteration: 0,
      memories: [],
      tools: tools || [],
      threadId: missionId,
      timestamp: new Date().toISOString(),
    };

    const config = {
      configurable: {
        thread_id: missionId,
      },
    };

    await sendBoardUpdate(missionId, "started", "Mission started");
    const result = await graph.invoke(initialState, config);
    await sendBoardUpdate(missionId, "completed", "Mission complete");

    res.json({
      success: true,
      threadId: missionId,
      output: result.output || result.research || "No output generated",
      steps: result.steps || [],
      critique: result.critiqueResult,
    });
  } catch (error: any) {
    await sendBoardUpdate(missionId, "error", error.message);
    next(new AppError(error.message, 500));
  }
});

// --- CHECKPOINTING ENDPOINTS ---
app.get("/api/missions", async (req, res, next) => {
  try {
    const missions = await checkpointManager.listMissions();
    res.json(missions);
  } catch (error: any) {
    logger.error({ error: error.message }, "Failed to list missions");
    next(new AppError(error.message, 500));
  }
});

app.get("/api/missions/:threadId", async (req, res, next) => {
  try {
    const graph = await getGraphApp();
    const config = { configurable: { thread_id: req.params.threadId } };
    const state = await graph.getState(config);
    res.json(state);
  } catch (error: any) {
    next(new AppError(error.message, 500));
  }
});

app.post("/api/missions/:threadId/resume", async (req, res, next) => {
  try {
    const graph = await getGraphApp();
    const config = { configurable: { thread_id: req.params.threadId } };
    const result = await graph.invoke(null, config);
    res.json({ success: true, result });
  } catch (error: any) {
    next(new AppError(error.message, 500));
  }
});

app.delete("/api/missions/:threadId", async (req, res, next) => {
  try {
    const graph = await getGraphApp();
    const checkpointer = (graph as any).checkpointer;
    await checkpointer.deleteThread(req.params.threadId);
    res.json({ success: true });
  } catch (error: any) {
    next(new AppError(error.message, 500));
  }
});

// Test endpoint (no auth)
app.post("/api/test", async (req, res, next) => {
  try {
    const { query } = req.body;
    const testModel = new ChatOllama({
      model: config.ollama.models.fast,
      temperature: 0,
    });

    const response = await testModel.invoke(query || "Say hello");
    res.json({
      success: true,
      response: response.content,
    });
  } catch (error: any) {
    next(new AppError(error.message, 500));
  }
});

// Error handling middleware (must be last)
app.use(errorHandler);

// Start server
app.listen(config.server.port, () => {
  logger.info(`🚀 Server running on http://localhost:${config.server.port}`);
  logger.info(`🌍 Environment: ${config.server.environment}`);

  console.log(`
  📝 Available Endpoints:
  
  GET  /health                  - Health check
  POST /api/test                - Test model
  POST /api/mission             - Run mission
  GET  /api/missions            - List missions
  POST /api/missions/:id/resume - Resume mission
  
  Tools:
  POST /api/tool/sql           - SQL query
  POST /api/tool/scrape        - Web scrape
  POST /api/tool/code          - Run code
  POST /api/tool/file          - File operations
  POST /api/memory/add         - Add to memory
  POST /api/memory/recall      - Recall from memory
  
  ${
    config.server.environment === "development"
      ? "⚠️  Development mode - no API key required"
      : "🔒 Production mode - API key required"
  }
  `);
});
