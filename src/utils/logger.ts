import pino from "pino";

// Create a base logger
const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination({
    dest: "./logs/app.log",
    sync: false, // Asynchronous logging for better performance
  }),
);

// For development, also pretty-print to console
if (process.env.NODE_ENV !== "production") {
  const prettyStream = pino.transport({
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  });

  // Create a child logger that also outputs to console
  global.logger = pino(
    {
      level: process.env.LOG_LEVEL || "debug",
    },
    pino.multistream([
      { stream: prettyStream },
      { stream: pino.destination("./logs/app.log") },
    ]),
  );
} else {
  global.logger = logger;
}

// Add request context helper
export const createContextLogger = (context: {
  threadId?: string;
  requestId?: string;
}) => {
  return logger.child(context);
};

// Export a default logger instance
export default logger;

// Declare global logger type
declare global {
  var logger: pino.Logger;
}
