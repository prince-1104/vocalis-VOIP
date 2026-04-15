import React, { useState } from "react";
import { Link } from "wouter";
import {
  Building2, Users, Phone, TrendingUp, Plus, ChevronRight,
  CheckCircle2, XCircle, Loader2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

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
  createdAt: string;
}

function useTenants() {
  const [data, setData] = React.useState<TenantSummary[] | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const fetchTenants = React.useCallback(async () => {
    try {
      setIsLoading(true);
      const token = localStorage.getItem("ss_auth_token");
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/admin/tenants", { headers });
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => { fetchTenants(); }, [fetchTenants]);

  return { data, isLoading, error, refetch: fetchTenants };
}

async function apiPost(path: string, body: any) {
  const token = localStorage.getItem("ss_auth_token");
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

export default function AdminTenants() {
  const { data: tenants, isLoading, error, refetch } = useTenants();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", commissionPct: "0", paymentTermsDays: "30" });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await apiPost("/api/admin/tenants", {
        name: form.name,
        slug: form.slug,
        commissionPct: form.commissionPct,
        paymentTermsDays: parseInt(form.paymentTermsDays),
      });
      toast({ title: "Tenant created" });
      setShowCreate(false);
      setForm({ name: "", slug: "", commissionPct: "0", paymentTermsDays: "30" });
      refetch();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-destructive">
        <p>Error loading tenants: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Tenants</h1>
          <p className="text-muted-foreground mt-1">{tenants?.length ?? 0} total workspaces</p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="w-4 h-4" /> New Tenant
        </Button>
      </div>

      <div className="grid gap-4">
        {tenants?.map((tenant) => (
          <Link key={tenant.id} href={`/admin/tenants/${tenant.id}`}>
            <div className="glass-panel rounded-xl p-5 border border-white/5 hover:border-primary/30 transition-all duration-200 cursor-pointer group">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Building2 className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <h3 className="font-semibold text-foreground">{tenant.name}</h3>
                      <Badge
                        variant={tenant.status === "active" ? "default" : "destructive"}
                        className={tenant.status === "active" ? "bg-green-500/20 text-green-400 border-green-500/30" : ""}
                      >
                        {tenant.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">/{tenant.slug}</p>
                  </div>
                </div>
                <div className="flex items-center gap-8">
                  <div className="text-center hidden md:block">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Users className="w-4 h-4" />
                      <span className="text-sm">{tenant.userCount} users</span>
                    </div>
                  </div>
                  <div className="text-center hidden md:block">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Phone className="w-4 h-4" />
                      <span className="text-sm">{tenant.callsThisMonth} calls</span>
                    </div>
                  </div>
                  <div className="text-center hidden md:block">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <TrendingUp className="w-4 h-4" />
                      <span className="text-sm">{tenant.commissionPct}% markup</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {tenant.twilioConfigured
                      ? <CheckCircle2 className="w-4 h-4 text-green-400" />
                      : <XCircle className="w-4 h-4 text-muted-foreground" />}
                    <span className="text-xs text-muted-foreground hidden md:inline">Twilio</span>
                  </div>
                  <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
              </div>
            </div>
          </Link>
        ))}
        {tenants?.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <Building2 className="w-12 h-12 mx-auto mb-4 opacity-30" />
            <p>No tenants yet. Create one to get started.</p>
          </div>
        )}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>Create New Tenant</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Organization Name</Label>
              <Input
                placeholder="Acme Corp"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                className="bg-white/5 border-white/10"
              />
            </div>
            <div className="space-y-2">
              <Label>Workspace Slug</Label>
              <Input
                placeholder="acme-corp"
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
                required
                className="bg-white/5 border-white/10"
              />
              <p className="text-xs text-muted-foreground">Used for login: /<span className="text-foreground">{form.slug || "your-slug"}</span></p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Commission Markup %</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={form.commissionPct}
                  onChange={(e) => setForm({ ...form, commissionPct: e.target.value })}
                  className="bg-white/5 border-white/10"
                />
              </div>
              <div className="space-y-2">
                <Label>Payment Terms (days)</Label>
                <Input
                  type="number"
                  min="1"
                  value={form.paymentTermsDays}
                  onChange={(e) => setForm({ ...form, paymentTermsDays: e.target.value })}
                  className="bg-white/5 border-white/10"
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={creating}>
                {creating ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating…</> : "Create Tenant"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
