import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import AppShell from "@/components/AppShell";
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import UsersPage from "@/pages/users";
import CustomersPage from "@/pages/customers";
import CustomerDetailPage from "@/pages/customer-detail";
import JobsPage from "@/pages/jobs";
import JobDetailPage from "@/pages/job-detail";
import FieldTicketsPage from "@/pages/field-tickets";
import JsasPage from "@/pages/jsas";
import DailyReportsPage from "@/pages/daily-reports";
import DailyReportDetailPage from "@/pages/daily-report-detail";
import JsaIntakePage from "@/pages/jsa-intake";
import JsaIntakeDetailPage from "@/pages/jsa-intake-detail";
import RigUpReportsPage from "@/pages/rig-up-reports";
import CertificationsPage from "@/pages/certifications";
import EmployeeProfilesPage from "@/pages/employee-profiles";
import ServicePage from "@/pages/service";
import MaintenancePage from "@/pages/maintenance";
import AuditTrailPage from "@/pages/audit-trail";
import AssetsPage from "@/pages/assets";
import Settings from "@/pages/settings";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";

function Protected() {
  const { profile } = useAuth();
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/customers" component={CustomersPage} />
        <Route path="/customers/:id" component={CustomerDetailPage} />
        <Route path="/jobs" component={JobsPage} />
        <Route path="/jobs/:id" component={JobDetailPage} />
        <Route path="/field-tickets" component={FieldTicketsPage} />
        {/* Legacy path — field reports are now part of the unified Daily Reports list */}
        <Route path="/field-daily-reports" component={DailyReportsPage} />
        <Route path="/jsas" component={JsasPage} />
        <Route path="/daily-reports" component={DailyReportsPage} />
        <Route path="/daily-reports/:id" component={DailyReportDetailPage} />
        <Route path="/jsa-intake" component={JsaIntakePage} />
        <Route path="/jsa-intake/:id" component={JsaIntakeDetailPage} />
        <Route path="/rig-up-reports" component={RigUpReportsPage} />
        <Route path="/certifications" component={CertificationsPage} />
        <Route path="/employee-profiles" component={EmployeeProfilesPage} />
        <Route path="/assets" component={AssetsPage} />
        <Route path="/service" component={ServicePage} />
        <Route path="/reports" component={MaintenancePage} />
        <Route path="/audit-trail" component={AuditTrailPage} />
        {profile?.role === "admin" && <Route path="/users" component={UsersPage} />}
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function Gate() {
  const { profile, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return profile ? <Protected /> : <Login />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthProvider>
          <Router hook={useHashLocation}>
            <Gate />
          </Router>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
