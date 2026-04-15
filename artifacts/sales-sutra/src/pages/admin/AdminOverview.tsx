import { useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import { Building2, Users, Phone, TrendingUp, ChevronRight, Loader2, Settings, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

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

interface PlatformSettings {
  defaultCommissionPct?: string;
  defaultPaymentTermsDays?: string;
  platformName?: string;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("ss_auth_token");
  const h: Record<string, string> = {};
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export default function AdminOverview() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState<PlatformSettings>({});
  const [settingsForm, setSettingsForm] = useState<PlatformSettings>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      const [tenantsRes, settingsRes] = await Promise.all([
        fetch("/api/admin/tenants", { headers: authHeaders() }),
        fetch("/api/admin/settings", { headers: authHeaders() }),
      ]);
      if (tenantsRes.ok) setTenants(await tenantsRes.json() as TenantSummary[]);
      if (settingsRes.ok) {
        const s = await settingsRes.json() as PlatformSettings;
        setSettings(s);
        setSettingsForm(s);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(settingsForm),
      });
      if (!res.ok) throw new Error("Failed to save");
      const updated = await res.json() as PlatformSettings;
      setSettings(updated);
      setSettingsForm(updated);
      toast({ title: "Platform settings saved" });
    } catch {
      toast({ title: "Error saving settings", variant: "destructive" });
    } finally {
      setSavingSettings(false);
    }
  }

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
        <p className="text-muted-foreground mt-1">Platform-wide summary and configuration</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={Building2} label="Total Tenants" value={tenants.length} />
        <StatCard icon={Building2} label="Active" value={activeCount} />
        <StatCard icon={Phone} label="Calls This Month" value={totalCalls} />
        <StatCard icon={TrendingUp} label="Cost This Month" value={`$${totalCost.toFixed(2)}`} />
      </div>

      <div className="glass-panel rounded-xl border border-white/5 p-6">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-primary" />
          <h2 className="font-semibold text-foreground">Platform Defaults</h2>
          <span className="text-xs text-muted-foreground ml-1">
            These defaults pre-fill when creating new tenants
          </span>
        </div>
        <form onSubmit={handleSaveSettings} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">Platform Name</Label>
              <Input
                value={settingsForm.platformName ?? ""}
                onChange={(e) => setSettingsForm({ ...settingsForm, platformName: e.target.value })}
                placeholder="SalesSutra"
                className="bg-white/5 border-white/10"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium">Default Commission %</Label>
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={settingsForm.defaultCommissionPct ?? ""}
                onChange={(e) => setSettingsForm({ ...settingsForm, defaultCommissionPct: e.target.value })}
                placeholder="0"
                className="bg-white/5 border-white/10"
              />
              <p className="text-xs text-muted-foreground">
                Applied to all usage. Existing: {settings.defaultCommissionPct ?? "0"}%
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium">Default Payment Terms (days)</Label>
              <Input
                type="number"
                min="1"
                value={settingsForm.defaultPaymentTermsDays ?? ""}
                onChange={(e) => setSettingsForm({ ...settingsForm, defaultPaymentTermsDays: e.target.value })}
                placeholder="30"
                className="bg-white/5 border-white/10"
              />
              <p className="text-xs text-muted-foreground">
                Days until invoice is overdue. Current: {settings.defaultPaymentTermsDays ?? "30"} days
              </p>
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={savingSettings} className="gap-2">
              {savingSettings ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Defaults
            </Button>
          </div>
        </form>
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
                    <Phone className="w-3.5 h-3.5 inline mr-1" />{t.callsThisMonth} calls
                  </span>
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    ${t.costThisMonth.toFixed(2)}
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
