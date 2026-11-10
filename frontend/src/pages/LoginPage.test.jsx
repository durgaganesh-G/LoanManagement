import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import LoginPage from "./LoginPage";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: { post: vi.fn() },
  errorMessage: (error) => {
    const response = error?.response?.data;
    if (response?.code === "VALIDATION_ERROR" && Array.isArray(response.details)) {
      return response.details.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    }
    return response?.message || "Unable to complete this request. Please try again.";
  },
}));

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
  });
  it("shows a shared sign-in page and demo accounts for all roles", () => {
    render(<AuthProvider><BrowserRouter><LoginPage /></BrowserRouter></AuthProvider>);
    expect(screen.getByText(/Applicants, officers, and auditors all use the same sign-in/)).toBeInTheDocument();
    expect(screen.getByText(/officer@bnk.local/)).toBeInTheDocument();
    expect(screen.getByText(/auditor@bnk.local/)).toBeInTheDocument();
    expect(screen.getByText(/asha.applicant@demo.local or ravi.applicant@demo.local/)).toBeInTheDocument();
  });
  it("submits credentials to the backend and displays errors", async () => {
    api.post.mockRejectedValueOnce({ response: { data: { message: "Invalid credentials" } } });
    render(<AuthProvider><BrowserRouter><LoginPage /></BrowserRouter></AuthProvider>);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "invalid@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid credentials"));
    expect(api.post).toHaveBeenCalledWith("/auth/login", { email: "invalid@example.test", password: "wrong-password" });
  });
  it("creates an applicant account from the sign-up form", async () => {
    api.post.mockResolvedValueOnce({ data: { token: "test-token", user: { id: "new-user", name: "New Applicant", role: "APPLICANT" } } });
    render(<AuthProvider><BrowserRouter><LoginPage /></BrowserRouter></AuthProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Create account" }));
    expect(document.querySelector(".auth-shell")).toHaveClass("signup-active");
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "New Applicant" } });
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "StrongPassword123!" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "StrongPassword123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Create account/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/auth/register", {
      name: "New Applicant",
      email: "new@example.test",
      password: "StrongPassword123!",
    }));
    expect(localStorage.setItem).toHaveBeenCalledWith("bnk-token", "test-token");
  });
  it("shows field-specific validation errors returned by the backend", async () => {
    api.post.mockRejectedValueOnce({ response: { data: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: [{ path: ["name"], message: "Too small: expected string to have >=1 characters" }],
    } } });
    render(<AuthProvider><BrowserRouter><LoginPage /></BrowserRouter></AuthProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Create account" }));
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "StrongPassword123!" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "StrongPassword123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Create account/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("name: Too small"));
  });
  it("requires matching passwords before sign-up", async () => {
    render(<AuthProvider><BrowserRouter><LoginPage /></BrowserRouter></AuthProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Create account" }));
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "New Applicant" } });
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "StrongPassword123!" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "DifferentPassword!" } });
    fireEvent.click(screen.getByRole("button", { name: /Create account/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match."));
    expect(api.post).not.toHaveBeenCalled();
  });
});
