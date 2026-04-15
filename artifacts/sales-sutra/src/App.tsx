import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { AppLayout } from "@/components/layout/AppLayout";
import { AdminLayout } from "@/components/layout/AdminLayout";
import Dashboard from "@/pages/Dashboard";
import Contacts from "@/pages/Contacts";
import Campaigns from "@/pages/Campaigns";
import Calls from "@/pages/Calls";
import AgentSettings from "@/pages/Agent";
import Training from "@/pages/Training";
import Scripts from "@/pages/Scripts";
import Analytics from "@/pages/Analytics";
import Login from "@/pages/Login";
import AdminOverview from "@/pages/admin/AdminOverview";
import AdminTenants from "@/pages/admin/AdminTenants";
import AdminTenantDetail from "@/pages/admin/AdminTenantDetail";
import NotFound from "@/pages/not-found";
import Forbidden from "@/pages/admin/Forbidden";
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
  const { isLoading, isAuthenticated } = useAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return <Redirect to="/login" />;
  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />

      <Route path="/admin">
        <AdminGuard>
          <AdminLayout>
            <AdminOverview />
          </AdminLayout>
        </AdminGuard>
      </Route>
      <Route path="/admin/tenants">
        <AdminGuard>
          <AdminLayout>
            <AdminTenants />
          </AdminLayout>
        </AdminGuard>
      </Route>
      <Route path="/admin/tenants/:id">
        {(params) => (
          <AdminGuard>
            <AdminLayout>
              <AdminTenantDetail />
            </AdminLayout>
          </AdminGuard>
        )}
      </Route>

      <Route>
        <AuthGuard>
          <AppLayout>
            <Switch>
              <Route path="/" component={Dashboard} />
              <Route path="/contacts" component={Contacts} />
              <Route path="/campaigns" component={Campaigns} />
              <Route path="/calls" component={Calls} />
              <Route path="/agent" component={AgentSettings} />
              <Route path="/training" component={Training} />
              <Route path="/scripts" component={Scripts} />
              <Route path="/analytics" component={Analytics} />
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
