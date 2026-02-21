import pino from "pino";

const logger = pino({
  level: "error",
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

export class AppError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (err: any, req: any, res: any, next: any) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
    });
  }

  // Default error
  res.status(500).json({
    success: false,
    error: "Internal server error",
  });
};
