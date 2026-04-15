import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Building2, Users, Phone, TrendingUp, ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface TenantSummary {
  id: number;
  name: string;
  slug: string;
  status: string;
  commissionPct: string;
  userCount: number;
  callsThisMonth: number;
  costThisMonth: number;
  twilioConfigured: boolean;
}

export default function AdminOverview() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const token = localStorage.getItem("ss_auth_token");
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch("/api/admin/tenants", { headers });
        if (res.ok) setTenants(await res.json());
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const totalCalls = tenants.reduce((s, t) => s + t.callsThisMonth, 0);
  const totalCost = tenants.reduce((s, t) => s + t.costThisMonth, 0);
  const activeCount = tenants.filter((t) => t.status === "active").length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Superadmin Overview</h1>
        <p className="text-muted-foreground mt-1">Platform-wide summary</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={Building2} label="Total Tenants" value={tenants.length} />
        <StatCard icon={Building2} label="Active" value={activeCount} />
        <StatCard icon={Phone} label="Calls This Month" value={totalCalls} />
        <StatCard icon={TrendingUp} label="Cost This Month" value={`$${totalCost.toFixed(2)}`} />
      </div>

      <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <Building2 className="w-5 h-5 text-primary" /> Recent Tenants
          </h2>
          <Link href="/admin/tenants">
            <span className="text-sm text-primary hover:underline cursor-pointer flex items-center gap-1">
              View all <ChevronRight className="w-4 h-4" />
            </span>
          </Link>
        </div>
        <div className="divide-y divide-white/5">
          {tenants.slice(0, 5).map((t) => (
            <Link key={t.id} href={`/admin/tenants/${t.id}`}>
              <div className="flex items-center justify-between px-6 py-4 hover:bg-white/5 transition-colors cursor-pointer">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-sm font-bold text-primary">
                    {t.name.charAt(0)}
                  </div>
                  <div>
                    <p className="font-medium text-sm text-foreground">{t.name}</p>
                    <p className="text-xs text-muted-foreground">/{t.slug}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    <Users className="w-3.5 h-3.5 inline mr-1" />{t.userCount}
                  </span>
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    <Phone className="w-3.5 h-3.5 inline mr-1" />{t.callsThisMonth}
                  </span>
                  <Badge
                    variant={t.status === "active" ? "default" : "destructive"}
                    className={t.status === "active" ? "bg-green-500/20 text-green-400 border-green-500/30 text-xs" : "text-xs"}
                  >
                    {t.status}
                  </Badge>
                </div>
              </div>
            </Link>
          ))}
          {tenants.length === 0 && (
            <div className="text-center py-10 text-muted-foreground text-sm">No tenants yet</div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string | number }) {
  return (
    <div className="glass-panel rounded-xl p-4 border border-white/5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-lg font-bold text-foreground">{value}</p>
        </div>
      </div>
    </div>
  );
}
