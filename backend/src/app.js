import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import routes from "./routes/index.js";
import { logger } from "./utils/logger.js";
import { AppError } from "./utils/errors.js";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
const frontendOrigins = new Set(
  (process.env.FRONTEND_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
function isDevelopmentLoopbackOrigin(origin) {
  if (process.env.NODE_ENV !== "development") return false;
  try {
    const url = new URL(origin);
    return url.origin === origin &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch {
    return false;
  }
}
app.use(cors({
  origin: (origin, callback) => callback(null,
    !origin || frontendOrigins.has(origin) || isDevelopmentLoopbackOrigin(origin)),
}));
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({
  logger,
  autoLogging: false,
  redact: ["req.headers.authorization", "req.body.password", "req.body.email"],
}));
app.get("/", (_req, res) => res.json({
  service: "Loan Origination & Eligibility Assistant API",
  status: "ok",
  api: "/api",
  health: "/api/health",
}));
app.use("/api", rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.API_RATE_LIMIT_PER_MINUTE || 120),
  standardHeaders: true,
  legacyHeaders: false,
}));
app.use("/api", routes);
app.use((req, _res, next) => next(new AppError(404, "NOT_FOUND", `No route for ${req.method} ${req.path}`)));
app.use((error, _req, res, _next) => {
  const status = error instanceof AppError ? error.status : error.name === "MulterError" ? 400 : 500;
  const code = error instanceof AppError ? error.code : error.name === "MulterError" ? "UPLOAD_ERROR" : "INTERNAL_ERROR";
  if (status >= 500) logger.error({ err: error, code }, "Request failed");
  res.status(status).json({
    code,
    message: status >= 500 && !(error instanceof AppError) ? "An unexpected error occurred" : error.message,
    details: error instanceof AppError ? error.details : null,
  });
});

export default app;
