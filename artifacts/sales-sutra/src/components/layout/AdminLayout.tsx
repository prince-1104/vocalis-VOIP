import React from "react";
import { Link, useLocation } from "wouter";
import { Building2, LayoutDashboard, ChevronLeft, LogOut, Receipt, BarChart3, BellRing, DollarSign, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { clearStoredToken } from "@/hooks/use-auth";
import { useQueryClient } from "@tanstack/react-query";

const ADMIN_NAV = [
  { href: "/superadmin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/superadmin/tenants", label: "Tenant Management", icon: Building2, exact: false },
  { href: "/superadmin/costs", label: "Cost & Billing", icon: Receipt, exact: false },
  { href: "/superadmin/analytics", label: "Analytics", icon: BarChart3, exact: false },
  { href: "/superadmin/alerts", label: "Alerts", icon: BellRing, exact: false },
  { href: "/superadmin/pricing", label: "Pricing Config", icon: DollarSign, exact: false },
  { href: "/superadmin/settings", label: "System Settings", icon: Settings, exact: false },
];

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const queryClient = useQueryClient();

  function handleLogout() {
    clearStoredToken();
    queryClient.clear();
    window.location.href = "/login";
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside className="w-64 flex flex-col bg-card/80 backdrop-blur-xl border-r border-white/5">
        <div className="flex items-center h-20 px-6 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="flex flex-col gap-0.5">
              <img
                src={`${import.meta.env.BASE_URL}dialog-by-nmc-logo.png`}
                alt="Dialog by NMC"
                className="h-9 w-auto object-contain"
              />
              <p className="text-[11px] text-primary font-semibold uppercase tracking-wider">Superadmin</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-6 px-4 space-y-1.5">
          {ADMIN_NAV.map((item) => {
            const isActive = item.exact ? location === item.href : location.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href}>
                <div className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 cursor-pointer group relative",
                  isActive
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                )}>
                  {isActive && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full" />
                  )}
                  <item.icon className={cn("w-5 h-5", isActive ? "text-primary" : "text-muted-foreground")} />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/5 space-y-2">
          <Link href="/">
            <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground">
              <ChevronLeft className="w-4 h-4" /> Back to App
            </Button>
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground hover:text-red-400"
            onClick={handleLogout}
          >
            <LogOut className="w-4 h-4" /> Sign out
          </Button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        <img
          src={`${import.meta.env.BASE_URL}images/mesh-bg.png`}
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-20 pointer-events-none mix-blend-screen"
        />
        <div className="flex-1 overflow-y-auto relative z-10">
          <div className="max-w-6xl mx-auto p-6 lg:p-8">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
