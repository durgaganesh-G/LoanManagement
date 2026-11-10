import { login, register } from "../services/authService.js";
import { asyncRoute, parseOrThrow } from "../utils/errors.js";
import { loginSchema, registerSchema } from "../validators/schemas.js";

export const registerUser = asyncRoute(async (req, res) => res.status(201).json(await register(parseOrThrow(registerSchema, req.body))));
export const loginUser = asyncRoute(async (req, res) => res.json(await login(parseOrThrow(loginSchema, req.body))));
