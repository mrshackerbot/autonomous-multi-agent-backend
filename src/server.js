import "dotenv/config";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/mission", (req, res) => {
  const { query, threadId } = req.body;

  if (!query || !threadId) {
    return res.status(400).json({ error: "Missing query or threadId" });
  }

  // Simple mock response for testing
  res.json({
    success: true,
    threadId,
    data: [`Mock response for: ${query}`],
  });
});

app.get("/test", (req, res) => {
  res.json({ message: "Server is working!" });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`📝 Test: curl http://localhost:${PORT}/test`);
});
