import React, { useState, useCallback, useEffect } from "react";
import { useParams, Link } from "wouter";
import {
  ArrowLeft, Building2, Users, Phone, TrendingUp, AlertTriangle,
  CheckCircle2, XCircle, Loader2, Plus, UserCheck, UserX,
  Edit2, Save, X, Key
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("ss_auth_token");
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function apiFetch(path: string, options: Omit<RequestInit, "headers"> = {}) {
  const res = await fetch(path, { ...options, headers: authHeaders() });
  const data = await res.json() as { error?: string };
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

interface TenantUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
}

interface TenantDetail {
  id: number;
  name: string;
  slug: string;
  status: string;
  commissionPct: string;
  paymentTermsDays: number;
  createdAt: string;
  ownerId: number;
  users: TenantUser[];
  telephony: {
    phoneNumber: string | null;
    twilioAccountSid: string | null;
    twilioAuthToken: string | null;
    twilioConfigured: boolean;
  };
  stats: {
    callsThisMonth: number;
    costThisMonth: number;
    userCount: number;
  };
}

export default function AdminTenantDetail() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", commissionPct: "", paymentTermsDays: "" });
  const [saving, setSaving] = useState(false);
  const [showAddUser, setShowAddUser] = useState(false);
  const [addingUser, setAddingUser] = useState(false);
  const [userForm, setUserForm] = useState({ email: "", name: "", role: "manager", password: "" });
  const [showTelephony, setShowTelephony] = useState(false);
  const [telephonyForm, setTelephonyForm] = useState({ phoneNumber: "", twilioAccountSid: "", twilioAuthToken: "" });
  const [savingTelephony, setSavingTelephony] = useState(false);

  const fetchTenant = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await apiFetch(`/api/admin/tenants/${id}`);
      setTenant(data);
      setEditForm({
        name: data.name,
        commissionPct: data.commissionPct,
        paymentTermsDays: String(data.paymentTermsDays),
      });
      setTelephonyForm({
        phoneNumber: data.telephony.phoneNumber || "",
        twilioAccountSid: data.telephony.twilioAccountSid || "",
        twilioAuthToken: "",
      });
    } catch (e: unknown) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  }, [id, toast]);

  useEffect(() => { fetchTenant(); }, [fetchTenant]);

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch(`/api/admin/tenants/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editForm.name,
          commissionPct: editForm.commissionPct,
          paymentTermsDays: parseInt(editForm.paymentTermsDays),
        }),
      });
      toast({ title: "Tenant updated" });
      setEditMode(false);
      fetchTenant();
    } catch (e: unknown) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusToggle() {
    if (!tenant) return;
    const newStatus = tenant.status === "active" ? "suspended" : "active";
    try {
      await apiFetch(`/api/admin/tenants/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      toast({ title: `Tenant ${newStatus === "active" ? "reactivated" : "suspended"}` });
      fetchTenant();
    } catch (e: unknown) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    }
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setAddingUser(true);
    try {
      await apiFetch(`/api/admin/tenants/${id}/users`, {
        method: "POST",
        body: JSON.stringify(userForm),
      });
      toast({ title: "User created" });
      setShowAddUser(false);
      setUserForm({ email: "", name: "", role: "manager", password: "" });
      fetchTenant();
    } catch (e: unknown) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setAddingUser(false);
    }
  }

  async function toggleUserActive(user: TenantUser) {
    try {
      await apiFetch(`/api/admin/tenants/${id}/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      toast({ title: user.isActive ? "User deactivated" : "User activated" });
      fetchTenant();
    } catch (e: unknown) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    }
  }

  async function handleSaveTelephony(e: React.FormEvent) {
    e.preventDefault();
    setSavingTelephony(true);
    try {
      await apiFetch(`/api/admin/tenants/${id}/telephony`, {
        method: "PUT",
        body: JSON.stringify(telephonyForm),
      });
      toast({ title: "Telephony updated" });
      setShowTelephony(false);
      fetchTenant();
    } catch (e: unknown) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setSavingTelephony(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!tenant) {
    return <div className="text-center py-16 text-muted-foreground">Tenant not found</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/tenants">
          <Button variant="ghost" size="icon" className="shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-foreground">{tenant.name}</h1>
            <Badge
              variant={tenant.status === "active" ? "default" : "destructive"}
              className={tenant.status === "active" ? "bg-green-500/20 text-green-400 border-green-500/30" : ""}
            >
              {tenant.status}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">/{tenant.slug}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className={tenant.status === "active"
              ? "border-red-500/30 text-red-400 hover:bg-red-500/10"
              : "border-green-500/30 text-green-400 hover:bg-green-500/10"}
            onClick={handleStatusToggle}
          >
            {tenant.status === "active" ? (
              <><AlertTriangle className="w-4 h-4 mr-1.5" /> Suspend</>
            ) : (
              <><CheckCircle2 className="w-4 h-4 mr-1.5" /> Reactivate</>
            )}
          </Button>
          {!editMode ? (
            <Button variant="outline" size="sm" onClick={() => setEditMode(true)}>
              <Edit2 className="w-4 h-4 mr-1.5" /> Edit
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditMode(false)}><X className="w-4 h-4" /></Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Save className="w-4 h-4 mr-1.5" /> Save</>}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard icon={Phone} label="Calls this month" value={tenant.stats.callsThisMonth} />
        <StatCard icon={TrendingUp} label="Cost this month" value={`$${tenant.stats.costThisMonth.toFixed(2)}`} />
        <StatCard icon={Users} label="Team members" value={tenant.stats.userCount} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-panel rounded-xl p-6 border border-white/5 space-y-4">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <Building2 className="w-5 h-5 text-primary" /> Settings
          </h2>
          {editMode ? (
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">Organization Name</Label>
                <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="bg-white/5 border-white/10 mt-1" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Commission Markup %</Label>
                <Input type="number" value={editForm.commissionPct} onChange={(e) => setEditForm({ ...editForm, commissionPct: e.target.value })} className="bg-white/5 border-white/10 mt-1" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Payment Terms (days)</Label>
                <Input type="number" value={editForm.paymentTermsDays} onChange={(e) => setEditForm({ ...editForm, paymentTermsDays: e.target.value })} className="bg-white/5 border-white/10 mt-1" />
              </div>
            </div>
          ) : (
            <dl className="space-y-3">
              <Row label="Commission Markup" value={`${tenant.commissionPct}%`} />
              <Row label="Payment Terms" value={`${tenant.paymentTermsDays} days`} />
              <Row label="Created" value={new Date(tenant.createdAt).toLocaleDateString()} />
            </dl>
          )}
        </div>

        <div className="glass-panel rounded-xl p-6 border border-white/5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-foreground flex items-center gap-2">
              <Key className="w-5 h-5 text-primary" /> Telephony
            </h2>
            <Button variant="outline" size="sm" onClick={() => setShowTelephony(true)}>
              <Edit2 className="w-4 h-4 mr-1.5" /> Configure
            </Button>
          </div>
          <dl className="space-y-3">
            <Row label="Phone Number" value={tenant.telephony.phoneNumber || "—"} />
            <Row label="Twilio Account SID" value={tenant.telephony.twilioAccountSid ? `${tenant.telephony.twilioAccountSid.slice(0, 10)}…` : "—"} />
            <Row
              label="Status"
              value={
                <span className={`flex items-center gap-1.5 ${tenant.telephony.twilioConfigured ? "text-green-400" : "text-muted-foreground"}`}>
                  {tenant.telephony.twilioConfigured
                    ? <><CheckCircle2 className="w-4 h-4" /> Configured</>
                    : <><XCircle className="w-4 h-4" /> Not configured</>}
                </span>
              }
            />
          </dl>
        </div>
      </div>

      <div className="glass-panel rounded-xl p-6 border border-white/5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" /> Team Members
          </h2>
          <Button size="sm" onClick={() => setShowAddUser(true)} className="gap-1.5">
            <Plus className="w-4 h-4" /> Add User
          </Button>
        </div>
        <div className="space-y-2">
          {tenant.users.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-6">No team members yet</p>
          ) : (
            tenant.users.map((user) => (
              <div key={user.id} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold ${user.isActive ? "bg-primary/20 text-primary border border-primary/30" : "bg-white/5 text-muted-foreground border border-white/10"}`}>
                    {user.name?.charAt(0) || user.email.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{user.name || user.email}</p>
                    {user.name && <p className="text-xs text-muted-foreground">{user.email}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="text-xs capitalize border-white/10">
                    {user.role}
                  </Badge>
                  <Badge variant={user.isActive ? "default" : "secondary"} className={user.isActive ? "bg-green-500/10 text-green-400 border-green-500/30 text-xs" : "text-xs"}>
                    {user.isActive ? "Active" : "Inactive"}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-8 h-8"
                    onClick={() => toggleUserActive(user)}
                    title={user.isActive ? "Deactivate" : "Activate"}
                  >
                    {user.isActive
                      ? <UserX className="w-4 h-4 text-muted-foreground hover:text-red-400" />
                      : <UserCheck className="w-4 h-4 text-muted-foreground hover:text-green-400" />}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <Dialog open={showAddUser} onOpenChange={setShowAddUser}>
        <DialogContent className="bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>Add Team Member</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAddUser} className="space-y-4">
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={userForm.email} onChange={(e) => setUserForm({ ...userForm, email: e.target.value })} required className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-2">
              <Label>Full Name <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input value={userForm.name} onChange={(e) => setUserForm({ ...userForm, name: e.target.value })} className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <select
                value={userForm.role}
                onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
                className="w-full h-10 rounded-md border border-white/10 bg-white/5 px-3 text-sm text-foreground"
              >
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Temporary Password</Label>
              <Input type="password" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} required className="bg-white/5 border-white/10" />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowAddUser(false)}>Cancel</Button>
              <Button type="submit" disabled={addingUser}>
                {addingUser ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Adding…</> : "Add User"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showTelephony} onOpenChange={setShowTelephony}>
        <DialogContent className="bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>Configure Telephony</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSaveTelephony} className="space-y-4">
            <div className="space-y-2">
              <Label>Phone Number</Label>
              <Input value={telephonyForm.phoneNumber} onChange={(e) => setTelephonyForm({ ...telephonyForm, phoneNumber: e.target.value })} placeholder="+1234567890" className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-2">
              <Label>Twilio Account SID</Label>
              <Input value={telephonyForm.twilioAccountSid} onChange={(e) => setTelephonyForm({ ...telephonyForm, twilioAccountSid: e.target.value })} placeholder="AC..." className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-2">
              <Label>Twilio Auth Token {tenant.telephony.twilioConfigured && <span className="text-muted-foreground text-xs">(leave blank to keep existing)</span>}</Label>
              <Input type="password" value={telephonyForm.twilioAuthToken} onChange={(e) => setTelephonyForm({ ...telephonyForm, twilioAuthToken: e.target.value })} placeholder="••••••••" className="bg-white/5 border-white/10" />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowTelephony(false)}>Cancel</Button>
              <Button type="submit" disabled={savingTelephony}>
                {savingTelephony ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : "Save Telephony"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string | number }) {
  return (
    <div className="glass-panel rounded-xl p-5 border border-white/5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Icon className="w-5 h-5 text-primary" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-bold text-foreground">{value}</p>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground font-medium">{value}</dd>
    </div>
  );
}
