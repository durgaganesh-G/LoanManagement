import { createContext, useContext, useMemo, useState } from "react";
import { api } from "../api/client";

const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("bnk-user") || "null"); } catch { return null; }
  });
  async function login(credentials) {
    const { data } = await api.post("/auth/login", credentials);
    localStorage.setItem("bnk-token", data.token);
    localStorage.setItem("bnk-user", JSON.stringify(data.user));
    setUser(data.user);
  }
  async function register(credentials) {
    const { data } = await api.post("/auth/register", credentials);
    localStorage.setItem("bnk-token", data.token);
    localStorage.setItem("bnk-user", JSON.stringify(data.user));
    setUser(data.user);
  }
  function logout() {
    localStorage.removeItem("bnk-token");
    localStorage.removeItem("bnk-user");
    setUser(null);
  }
  const value = useMemo(() => ({ user, login, register, logout }), [user]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
