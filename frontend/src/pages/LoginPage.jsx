import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { errorMessage } from "../api/client";

export default function LoginPage() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ name: "", email: "", password: "", confirmPassword: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const isSignup = mode === "signup";

  function changeMode(nextMode) {
    setMode(nextMode);
    setError("");
    setShowPassword(false);
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (isSignup && form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      if (isSignup) {
        await register({ name: form.name.trim(), email: form.email.trim().toLowerCase(), password: form.password });
      } else {
        await login({ email: form.email.trim().toLowerCase(), password: form.password });
      }
      navigate("/");
    } catch (issue) {
      setError(errorMessage(issue));
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-page">
    <section className={`auth-shell${isSignup ? " signup-active" : ""}`}>
      <aside className="auth-showcase">
        <div className="brand auth-brand" aria-label="Loan Origination and Eligibility Assistant"><span className="brand-mark">L</span><span>Loan Origination<small>ELIGIBILITY ASSISTANT</small></span></div>
        <div className="showcase-copy">
          <p className="showcase-kicker"><span /> CLEARER LOAN JOURNEYS</p>
          <h1>Make your next<br />step feel simpler.</h1>
          <p className="showcase-description">A thoughtful workspace for loan applications, document review, and eligibility decisions.</p>
          <div className="showcase-art" aria-hidden="true">
            <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
            <div className="art-card art-card-main"><span className="art-icon">↗</span><span className="art-line line-long" /><span className="art-line line-short" /><span className="art-status"><i /> Application workspace</span></div>
            <div className="art-card art-card-small"><span className="art-check">✓</span><span><b>On track</b><small>Progress, made clear</small></span></div>
            <div className="art-sparkle sparkle-one">✦</div><div className="art-sparkle sparkle-two">✦</div>
          </div>
        </div>
        <div className="showcase-footer"><span>Secure workspace</span><span>·</span><span>Role-based access</span><span>·</span><span>Built for clarity</span></div>
      </aside>

      <section className="auth-panel">
        <nav className="auth-nav" aria-label="Account access">
          <span className="auth-nav-note">{isSignup ? "New to the assistant?" : "Already have an account?"}</span>
          <div className="auth-tabs" role="tablist" aria-label="Sign in or create an account">
            <button type="button" role="tab" aria-selected={!isSignup} className={!isSignup ? "active" : ""} onClick={() => changeMode("login")}>Sign in</button>
            <button type="button" role="tab" aria-selected={isSignup} className={isSignup ? "active" : ""} onClick={() => changeMode("signup")}>Create account</button>
          </div>
        </nav>

        <div className={`auth-form-wrap ${isSignup ? "signup-content" : "login-content"}`}>
          <div className="auth-heading">
            <p className="eyebrow">{isSignup ? "GET STARTED" : "WELCOME BACK"}</p>
            <h2>{isSignup ? "Create your account" : "Sign in to your workspace"}</h2>
            <p>{isSignup ? "Set up your applicant account in just a moment." : "Applicants, officers, and auditors all use the same sign-in."}</p>
          </div>
          <form onSubmit={submit} className="form-stack auth-form">
            {isSignup && <label>Full name<input type="text" autoComplete="name" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your full name" /></label>}
            <label>Email address<input type="email" autoComplete="username" required maxLength={254} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" /></label>
            <label>Password
              <span className="password-field"><input type={showPassword ? "text" : "password"} autoComplete={isSignup ? "new-password" : "current-password"} required minLength={isSignup ? 10 : 1} maxLength={128} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={isSignup ? "At least 10 characters" : "Enter your password"} /><button type="button" className="password-toggle" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((shown) => !shown)}>{showPassword ? "Hide" : "Show"}</button></span>
            </label>
            {isSignup && <label>Confirm password<input type={showPassword ? "text" : "password"} autoComplete="new-password" required maxLength={128} value={form.confirmPassword} onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })} placeholder="Re-enter your password" /></label>}
            {isSignup && <p className="auth-hint">Password must be at least 10 characters. New accounts are created with Applicant access.</p>}
            {error && <p role="alert" className="form-error">{error}</p>}
            <button className="button primary wide auth-submit" disabled={busy}>{busy ? (isSignup ? "Creating account..." : "Signing in...") : (isSignup ? "Create account" : "Sign in")} <span>→</span></button>
          </form>

          {!isSignup && <div className="auth-demo-accounts">
            <p><b>Demo accounts</b> <span>(default password: DemoPass123!)</span></p>
            <p>Officer: officer@bnk.local</p>
            <p>Auditor: auditor@bnk.local</p>
            <p>Applicant: asha.applicant@demo.local or ravi.applicant@demo.local</p>
          </div>}
          <p className="auth-privacy">Your workspace access is determined by your account role.</p>
        </div>
      </section>
    </section>
  </main>;
}
