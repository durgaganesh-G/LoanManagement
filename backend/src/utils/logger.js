import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: ["req.headers.authorization", "password", "passwordHash", "token", "email", "phone", "dateOfBirth"],
    censor: "[REDACTED]",
  },
});
