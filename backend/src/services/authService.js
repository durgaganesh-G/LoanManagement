import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../data-access/prisma.js";
import { AppError } from "../utils/errors.js";

function tokenFor(user) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) {
    throw new AppError(500, "CONFIGURATION_ERROR", "JWT_SECRET must contain at least 24 characters");
  }
  return jwt.sign({ sub: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: "8h" });
}

export async function register({ name, email, password }) {
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) throw new AppError(409, "EMAIL_EXISTS", "An account with this email already exists");
  const user = await prisma.user.create({
    data: { name, email, passwordHash: await bcrypt.hash(password, 12) },
  });
  return { token: tokenFor(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

export async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  return { token: tokenFor(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}
