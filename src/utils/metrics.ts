import promClient from "prom-client";
import { Request, Response, NextFunction } from "express";

// Initialize Prometheus registry
const register = new promClient.Registry();

// Add default metrics (CPU, memory, etc.)
promClient.collectDefaultMetrics({ register });

// Custom metrics
export const httpRequestDurationMicroseconds = new promClient.Histogram({
  name: "http_request_duration_ms",
  help: "Duration of HTTP requests in ms",
  labelNames: ["method", "route", "status_code"],
  buckets: [50, 100, 200, 300, 400, 500, 1000, 2000, 5000],
});

export const activeMissionsGauge = new promClient.Gauge({
  name: "active_missions_total",
  help: "Number of currently active missions",
});

export const missionsTotalCounter = new promClient.Counter({
  name: "missions_total",
  help: "Total number of missions processed",
  labelNames: ["status"], // success, error, retry
});

export const modelUsageCounter = new promClient.Counter({
  name: "model_usage_total",
  help: "Total number of model invocations",
  labelNames: ["model", "node"], // model name and graph node
});

export const toolUsageCounter = new promClient.Counter({
  name: "tool_usage_total",
  help: "Total number of tool invocations",
  labelNames: ["tool", "agent"],
});

export const nodeExecutionDuration = new promClient.Histogram({
  name: "node_execution_duration_ms",
  help: "Duration of LangGraph node execution in ms",
  labelNames: ["node"],
  buckets: [100, 250, 500, 1000, 2500, 5000, 10000],
});

export const graphExecutionDuration = new promClient.Histogram({
  name: "graph_execution_duration_ms",
  help: "Total duration of graph execution in ms",
  buckets: [500, 1000, 2500, 5000, 10000, 30000, 60000],
});

export const checkpointOperationsCounter = new promClient.Counter({
  name: "checkpoint_operations_total",
  help: "Total number of checkpoint operations",
  labelNames: ["operation"], // read, write, delete
});

export const ollamaHealthGauge = new promClient.Gauge({
  name: "ollama_health_status",
  help: "Health status of Ollama (1 = healthy, 0 = unhealthy)",
});

// Register all metrics
register.registerMetric(httpRequestDurationMicroseconds);
register.registerMetric(activeMissionsGauge);
register.registerMetric(missionsTotalCounter);
register.registerMetric(modelUsageCounter);
register.registerMetric(toolUsageCounter);
register.registerMetric(nodeExecutionDuration);
register.registerMetric(graphExecutionDuration);
register.registerMetric(checkpointOperationsCounter);
register.registerMetric(ollamaHealthGauge);

// Metrics middleware for Express
export const metricsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const start = Date.now();

  // Record when response finishes
  res.on("finish", () => {
    const duration = Date.now() - start;
    httpRequestDurationMicroseconds
      .labels(
        req.method,
        req.route?.path || req.path,
        res.statusCode.toString(),
      )
      .observe(duration);
  });

  next();
};

// Endpoint to expose metrics
export const metricsEndpoint = async (req: Request, res: Response) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
};

export default register;
