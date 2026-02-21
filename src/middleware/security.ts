import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import { config } from "../config.js";

// Rate limiter
export const rateLimiter = rateLimit({
  windowMs: config.security.rateWindow,
  max: config.security.rateLimit,
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// API key authentication
export const apiKeyAuth = (req: any, res: any, next: any) => {
  // Skip in development
  if (config.server.environment === "development") {
    return next();
  }

  const apiKey = req.headers["x-api-key"];

  if (!apiKey || !config.security.apiKeys.includes(apiKey)) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }

  next();
};

// CORS configuration
export const corsOptions = {
  origin:
    config.server.environment === "development"
      ? "*"
      : process.env.ALLOWED_ORIGINS?.split(",") || [],
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "x-api-key"],
};

export const securityMiddleware = [helmet(), cors(corsOptions), rateLimiter];
