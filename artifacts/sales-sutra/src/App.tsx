import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { AppLayout } from "@/components/layout/AppLayout";
import { AdminLayout } from "@/components/layout/AdminLayout";
import Dashboard from "@/pages/Dashboard";
import Contacts from "@/pages/Contacts";
import Campaigns from "@/pages/Campaigns";
import Calls from "@/pages/Calls";
import Dialer from "@/pages/Dialer";
import AgentSettings from "@/pages/Agent";
import WidgetSettings from "@/pages/Widget";
import Training from "@/pages/Training";
import Scripts from "@/pages/Scripts";
import Analytics from "@/pages/Analytics";
import Login from "@/pages/Login";
import SuspensionNotice from "@/pages/SuspensionNotice";
import AdminOverview from "@/pages/superadmin/AdminOverview";
import AdminTenants from "@/pages/superadmin/AdminTenants";
import AdminTenantDetail from "@/pages/superadmin/AdminTenantDetail";
import AdminInvoices from "@/pages/superadmin/AdminInvoices";
import AdminCosts from "@/pages/superadmin/AdminCosts";
import AdminAnalytics from "@/pages/superadmin/AdminAnalytics";
import AdminAlerts from "@/pages/superadmin/AdminAlerts";
import AdminPricing from "@/pages/superadmin/AdminPricing";
import AdminSettings from "@/pages/superadmin/AdminSettings";
import Billing from "@/pages/Billing";
import NotFound from "@/pages/not-found";
import WidgetTest from "@/pages/WidgetTest";
import WidgetDemo from "@/pages/WidgetDemo";
import BbmpDemo from "@/pages/BbmpDemo";
import NmcDemo from "@/pages/NmcDemo";
import Forbidden from "@/pages/superadmin/Forbidden";
import { useAuth } from "@/hooks/use-auth";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { isSuperadmin, isLoading, isAuthenticated } = useAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return <Redirect to="/login" />;
  if (!isSuperadmin) return <Forbidden />;
  return <>{children}</>;
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated, isSuspended, suspensionInvoiceId, suspensionAmountDue, isSuperadmin } = useAuth();
  const [location] = useLocation();
  if (isLoading) return null;
  if (isSuspended) return <SuspensionNotice invoiceId={suspensionInvoiceId} amountDue={suspensionAmountDue} />;
  if (!isAuthenticated) return <Redirect to="/login" />;
  if (isSuperadmin && location === "/") return <Redirect to="/superadmin" />;
  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/test" component={WidgetTest} />
      <Route path="/test/" component={WidgetTest} />
      <Route path="/widget-test" component={WidgetTest} />
      <Route path="/widget-test/" component={WidgetTest} />
      <Route path="/widget-demo" component={WidgetDemo} />
      <Route path="/widget-demo/" component={WidgetDemo} />
      <Route path="/bbmp" component={BbmpDemo} />
      <Route path="/bbmp/" component={BbmpDemo} />
      <Route path="/nmc" component={NmcDemo} />
      <Route path="/nmc/" component={NmcDemo} />
      <Route path="/login" component={Login} />

      <Route path="/superadmin">
        <AdminGuard>
          <AdminLayout>
            <AdminOverview />
          </AdminLayout>
        </AdminGuard>
      </Route>
      <Route path="/superadmin/tenants">
        <AdminGuard>
          <AdminLayout>
            <AdminTenants />
          </AdminLayout>
        </AdminGuard>
      </Route>
      <Route path="/superadmin/tenants/:id">
        {() => (
          <AdminGuard>
            <AdminLayout>
              <AdminTenantDetail />
            </AdminLayout>
          </AdminGuard>
        )}
      </Route>
      <Route path="/superadmin/invoices">
        <AdminGuard>
          <AdminLayout>
            <AdminInvoices />
          </AdminLayout>
        </AdminGuard>
      </Route>
      <Route path="/superadmin/costs">
        <AdminGuard>
          <AdminLayout>
            <AdminCosts />
          </AdminLayout>
        </AdminGuard>
      </Route>
      <Route path="/superadmin/analytics">
        <AdminGuard>
          <AdminLayout>
            <AdminAnalytics />
          </AdminLayout>
        </AdminGuard>
      </Route>
      <Route path="/superadmin/alerts">
        <AdminGuard>
          <AdminLayout>
            <AdminAlerts />
          </AdminLayout>
        </AdminGuard>
      </Route>
      <Route path="/superadmin/pricing">
        <AdminGuard>
          <AdminLayout>
            <AdminPricing />
          </AdminLayout>
        </AdminGuard>
      </Route>
      <Route path="/superadmin/settings">
        <AdminGuard>
          <AdminLayout>
            <AdminSettings />
          </AdminLayout>
        </AdminGuard>
      </Route>

      <Route>
        <AuthGuard>
          <AppLayout>
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/contacts" component={Contacts} />
              <Route path="/campaigns" component={Campaigns} />
              <Route path="/calls" component={Calls} />
              <Route path="/dialer" component={Dialer} />
              <Route path="/agent" component={AgentSettings} />
              <Route path="/widget" component={WidgetSettings} />
              <Route path="/training" component={Training} />
              <Route path="/scripts" component={Scripts} />
              <Route path="/analytics" component={Analytics} />
              <Route path="/billing" component={Billing} />
              <Route component={NotFound} />
            </Switch>
          </AppLayout>
        </AuthGuard>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
