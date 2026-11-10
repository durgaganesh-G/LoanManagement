import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import AppLayout from "./layouts/AppLayout";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import ApplicationsPage from "./pages/ApplicationsPage";
import NewApplicationPage from "./pages/NewApplicationPage";
import ApplicationDetailPage from "./pages/ApplicationDetailPage";
import DocumentUploadPage from "./pages/DocumentUploadPage";
import ExtractedProfilePage from "./pages/ExtractedProfilePage";
import EligibilityPage from "./pages/EligibilityPage";
import DecisionPage from "./pages/DecisionPage";
import ReferralsPage from "./pages/ReferralsPage";
import AuditPage from "./pages/AuditPage";

function Protected({ children }) {
  const { user } = useAuth();
  return user ? children : <Navigate to="/login" replace />;
}
function OfficerOnly({ children }) {
  const { user } = useAuth();
  return user?.role === "OFFICER" ? children : <Navigate to="/" replace />;
}
function AuditorOnly({ children }) {
  const { user } = useAuth();
  return user?.role === "AUDITOR" ? children : <Navigate to="/" replace />;
}
function WriteAccess({ children }) {
  const { user } = useAuth();
  return user?.role === "AUDITOR" ? <Navigate to="/" replace /> : children;
}
export default function App() {
  return <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={<Protected><AppLayout /></Protected>}>
      <Route index element={<DashboardPage />} /><Route path="applications" element={<ApplicationsPage />} />
      <Route path="applications/new" element={<WriteAccess><NewApplicationPage /></WriteAccess>} /><Route path="applications/:applicationId" element={<ApplicationDetailPage />} />
      <Route path="applications/:applicationId/documents" element={<WriteAccess><DocumentUploadPage /></WriteAccess>} /><Route path="applications/:applicationId/profile" element={<WriteAccess><ExtractedProfilePage /></WriteAccess>} />
      <Route path="applications/:applicationId/eligibility" element={<WriteAccess><EligibilityPage /></WriteAccess>} />
      <Route path="applications/:applicationId/decision" element={<DecisionPage />} /><Route path="applications/:applicationId/audit" element={<AuditorOnly><AuditPage /></AuditorOnly>} />
      <Route path="referrals" element={<OfficerOnly><ReferralsPage /></OfficerOnly>} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}
