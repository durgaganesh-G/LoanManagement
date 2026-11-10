import axios from "axios";

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || "http://localhost:4000/api", timeout: 30000 });
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("bnk-token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export const errorMessage = (error) => {
  const response = error?.response?.data;
  if (response?.code === "VALIDATION_ERROR" && Array.isArray(response.details)) {
    const issues = response.details.map((issue) => {
      const field = Array.isArray(issue.path) ? issue.path.join(".") : "";
      return `${field ? `${field}: ` : ""}${issue.message}`;
    }).filter(Boolean);
    if (issues.length) return issues.join("; ");
  }
  return response?.message || "Unable to complete this request. Please try again.";
};
