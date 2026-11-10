export class AppError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function parseOrThrow(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Request validation failed", parsed.error.issues);
  }
  return parsed.data;
}
