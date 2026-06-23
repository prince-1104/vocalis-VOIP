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

async function apiFetch(path: string, options: Omit<RequestInit, "headers"> = {}): Promise<any> {
  const res = await fetch(path, { ...options, headers: authHeaders() });
  const data = await res.json() as any;
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
  telephonyType: string;
  telephony: {
    phoneNumber: string | null;
    twilioAccountSid: string | null;
    twilioAuthToken: string | null;
    twilioConfigured: boolean;
  };
  sipTrunkConfig: {
    sipDomain: string;
    sipUsername: string;
    phoneNumber: string;
    outboundProxy: string | null;
    transport: string;
    terminationUri: string | null;
    isEnabled: boolean;
  } | null;
  exotelConfig: {
    accountSid: string;
    exophone: string;
    region: string;
    appFlowUrl: string;
    apiKeyConfigured: boolean;
    apiTokenConfigured: boolean;
    isEnabled: boolean;
  } | null;
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
  const [activeTab, setActiveTab] = useState<"TWILIO" | "SIP_TRUNK" | "EXOTEL">("TWILIO");
  const [showSipTrunk, setShowSipTrunk] = useState(false);
  const [showExotel, setShowExotel] = useState(false);
  const [savingExotel, setSavingExotel] = useState(false);
  const [exotelForm, setExotelForm] = useState({
    accountSid: "",
    apiKey: "",
    apiToken: "",
    exophone: "",
    region: "singapore",
    appFlowUrl: "",
  });
  const [isEditingSip, setIsEditingSip] = useState(false);
  const [savingSip, setSavingSip] = useState(false);
  const [showSipPassword, setShowSipPassword] = useState(false);
  const [showExotelSecrets, setShowExotelSecrets] = useState(false);
  const [sipForm, setSipForm] = useState({
    sipDomain: "",
    sipUsername: "",
    sipPassword: "",
    phoneNumber: "",
    outboundProxy: "",
    transport: "UDP",
  });

  const fetchTenant = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await apiFetch(`/api/superadmin/tenants/${id}`);
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
      setActiveTab(
        data.telephonyType === "SIP_TRUNK" ? "SIP_TRUNK"
        : data.telephonyType === "EXOTEL" ? "EXOTEL"
        : "TWILIO",
      );
      if (data.exotelConfig) {
        setExotelForm({
          accountSid: data.exotelConfig.accountSid || "",
          apiKey: "",
          apiToken: "",
          exophone: data.exotelConfig.exophone || "",
          region: data.exotelConfig.region || "singapore",
          appFlowUrl: data.exotelConfig.appFlowUrl || "",
        });
      }
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
      await apiFetch(`/api/superadmin/tenants/${id}`, {
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
      await apiFetch(`/api/superadmin/tenants/${id}`, {
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
      await apiFetch(`/api/superadmin/tenants/${id}/users`, {
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
      await apiFetch(`/api/superadmin/tenants/${id}/users/${user.id}`, {
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
      await apiFetch(`/api/superadmin/tenants/${id}/telephony`, {
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

  function handleConfigureSipTrunk(existingConfig?: TenantDetail["sipTrunkConfig"]) {
    if (existingConfig) {
      setIsEditingSip(true);
      setSipForm({
        sipDomain: existingConfig.sipDomain || "",
        sipUsername: existingConfig.sipUsername || "",
        sipPassword: "",
        phoneNumber: existingConfig.phoneNumber || "",
        outboundProxy: existingConfig.outboundProxy || "",
        transport: existingConfig.transport || "UDP",
      });
    } else {
      setIsEditingSip(false);
      setSipForm({
        sipDomain: "",
        sipUsername: "",
        sipPassword: "",
        phoneNumber: "",
        outboundProxy: "",
        transport: "UDP",
      });
    }
    setShowSipPassword(false);
    setShowSipTrunk(true);
  }

  async function handleSaveExotel(e: React.FormEvent) {
    e.preventDefault();
    setSavingExotel(true);
    try {
      await apiFetch(`/api/superadmin/tenants/${id}/telephony/exotel`, {
        method: "POST",
        body: JSON.stringify({
          accountSid: exotelForm.accountSid,
          apiKey: exotelForm.apiKey || undefined,
          apiToken: exotelForm.apiToken || undefined,
          exophone: exotelForm.exophone,
          region: exotelForm.region,
          appFlowUrl: exotelForm.appFlowUrl,
        }),
      });
      toast({ title: "Exotel configuration saved" });
      setShowExotel(false);
      fetchTenant();
    } catch (e: unknown) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setSavingExotel(false);
    }
  }

  async function handleToggleExotel() {
    if (!tenant?.exotelConfig) return;
    const nextState = !tenant.exotelConfig.isEnabled;
    const confirmMsg = nextState
      ? "Enable Exotel for this tenant? Outbound calls will use Exotel instead of Twilio."
      : "Disable Exotel? Calls will revert to Twilio.";
    if (!window.confirm(confirmMsg)) return;
    try {
      await apiFetch(`/api/superadmin/tenants/${id}/telephony/exotel/toggle`, {
        method: "PATCH",
        body: JSON.stringify({ isEnabled: nextState }),
      });
      toast({ title: nextState ? "Exotel enabled" : "Exotel disabled" });
      fetchTenant();
    } catch (e: unknown) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    }
  }

  async function handleRemoveExotel() {
    if (!window.confirm("Remove Exotel configuration for this tenant?")) return;
    try {
      await apiFetch(`/api/superadmin/tenants/${id}/telephony/exotel`, { method: "DELETE" });
      toast({ title: "Exotel configuration removed" });
      setActiveTab("TWILIO");
      fetchTenant();
    } catch (e: unknown) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    }
  }

  async function handleSaveSipTrunk(e: React.FormEvent) {
    e.preventDefault();
    setSavingSip(true);
    try {
      await apiFetch(`/api/superadmin/tenants/${id}/telephony/sip-trunk`, {
        method: "POST",
        body: JSON.stringify({
          sipDomain: sipForm.sipDomain,
          sipUsername: sipForm.sipUsername,
          sipPassword: sipForm.sipPassword || undefined,
          phoneNumber: sipForm.phoneNumber,
          outboundProxy: sipForm.outboundProxy || undefined,
          transport: sipForm.transport,
        }),
      });
      toast({ title: isEditingSip ? "SIP Trunk updated" : "SIP Trunk configured" });
      setShowSipTrunk(false);
      fetchTenant();
    } catch (e: unknown) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setSavingSip(false);
    }
  }

  async function handleToggleSipTrunk() {
    if (!tenant || !tenant.sipTrunkConfig) return;
    const nextState = !tenant.sipTrunkConfig.isEnabled;
    const confirmMsg = nextState
      ? "Are you sure you want to enable SIP Trunking? Outbound calls will be routed through the SIP trunk instead of Twilio."
      : "Are you sure you want to disable SIP Trunking? Outbound calls will revert to using Twilio settings.";
    
    if (!window.confirm(confirmMsg)) return;

    try {
      await apiFetch(`/api/superadmin/tenants/${id}/telephony/sip-trunk/toggle`, {
        method: "PATCH",
        body: JSON.stringify({ isEnabled: nextState }),
      });
      toast({ title: nextState ? "SIP Trunk enabled" : "SIP Trunk disabled" });
      fetchTenant();
    } catch (e: unknown) {
      toast({ title: "Failed to toggle SIP Trunk", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    }
  }

  async function handleRemoveSipTrunk() {
    if (!window.confirm("Are you sure you want to completely remove the SIP Trunk configuration? This will delete all settings and reset active telephony to Twilio.")) {
      return;
    }

    try {
      await apiFetch(`/api/superadmin/tenants/${id}/telephony/sip-trunk`, {
        method: "DELETE",
      });
      toast({ title: "SIP Trunk configuration removed" });
      setActiveTab("TWILIO");
      fetchTenant();
    } catch (e: unknown) {
      toast({ title: "Failed to remove SIP Trunk", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
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
        <Link href="/superadmin/tenants">
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
            <span className="text-xs font-semibold flex items-center gap-1.5 text-muted-foreground bg-white/5 px-2.5 py-1 rounded-full border border-white/5">
              Active: {tenant.telephonyType === "SIP_TRUNK" ? "SIP Trunk" : tenant.telephonyType === "EXOTEL" ? "Exotel" : "Twilio"} <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
            </span>
          </div>

          <div className="flex bg-white/5 p-1 rounded-lg border border-white/5 w-full">
            <button
              type="button"
              onClick={() => setActiveTab("TWILIO")}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                activeTab === "TWILIO"
                  ? "bg-primary text-primary-foreground shadow"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Twilio
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("SIP_TRUNK")}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                activeTab === "SIP_TRUNK"
                  ? "bg-primary text-primary-foreground shadow"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              SIP Trunk
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("EXOTEL")}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                activeTab === "EXOTEL"
                  ? "bg-primary text-primary-foreground shadow"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Exotel
            </button>
          </div>

          {activeTab === "TWILIO" ? (
            <div className="space-y-4">
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
              <div className="flex justify-end pt-2">
                <Button variant="outline" size="sm" onClick={() => setShowTelephony(true)}>
                  <Edit2 className="w-4 h-4 mr-1.5" /> Configure Twilio
                </Button>
              </div>
            </div>
          ) : activeTab === "SIP_TRUNK" ? (
            <div className="space-y-4">
              {!tenant.sipTrunkConfig ? (
                <div className="flex flex-col items-center justify-center py-6 text-center space-y-3">
                  <Phone className="w-8 h-8 text-muted-foreground opacity-55" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">SIP Trunk Not Configured</p>
                    <p className="text-xs text-muted-foreground max-w-[280px]">
                      Set up custom SIP Trunking to handle call routing for this tenant.
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => handleConfigureSipTrunk()}>
                    <Plus className="w-4 h-4 mr-1.5" /> Configure SIP Trunk
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={tenant.sipTrunkConfig.isEnabled ? "default" : "secondary"}
                        className={tenant.sipTrunkConfig.isEnabled ? "bg-green-500/20 text-green-400 border-green-500/30 text-xs" : "bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-xs"}
                      >
                        {tenant.sipTrunkConfig.isEnabled ? "Active" : "Inactive"}
                      </Badge>
                      <span className="text-xs text-muted-foreground font-medium">SIP Trunking</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground font-medium">
                        {tenant.sipTrunkConfig.isEnabled ? "Enabled" : "Disabled"}
                      </span>
                      <button
                        type="button"
                        onClick={handleToggleSipTrunk}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                          tenant.sipTrunkConfig.isEnabled ? "bg-primary" : "bg-white/10"
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            tenant.sipTrunkConfig.isEnabled ? "translate-x-4" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  <dl className="space-y-2.5">
                    <Row label="SIP Domain" value={tenant.sipTrunkConfig.sipDomain} />
                    <Row label="Username" value={tenant.sipTrunkConfig.sipUsername} />
                    <Row label="Password" value="••••••••" />
                    <Row label="Phone Number" value={tenant.sipTrunkConfig.phoneNumber} />
                    <Row label="Outbound Proxy" value={tenant.sipTrunkConfig.outboundProxy || "—"} />
                    <Row label="Transport" value={tenant.sipTrunkConfig.transport} />
                    <Row label="Termination URI" value={tenant.sipTrunkConfig.terminationUri || "—"} />
                  </dl>

                  <div className="flex justify-end gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                      onClick={handleRemoveSipTrunk}
                    >
                      Remove
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleConfigureSipTrunk(tenant.sipTrunkConfig)}>
                      <Edit2 className="w-4 h-4 mr-1.5" /> Edit
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {!tenant.exotelConfig ? (
                <div className="flex flex-col items-center justify-center py-6 text-center space-y-3">
                  <Phone className="w-8 h-8 text-muted-foreground opacity-55" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Exotel Not Configured</p>
                    <p className="text-xs text-muted-foreground max-w-[280px]">
                      Connect Exotel API credentials and call flow for AI outbound dialing.
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setShowExotel(true)}>
                    <Plus className="w-4 h-4 mr-1.5" /> Configure Exotel
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={tenant.exotelConfig.isEnabled ? "default" : "secondary"}
                        className={tenant.exotelConfig.isEnabled ? "bg-green-500/20 text-green-400 border-green-500/30 text-xs" : "bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-xs"}
                      >
                        {tenant.exotelConfig.isEnabled ? "Active" : "Inactive"}
                      </Badge>
                      <span className="text-xs text-muted-foreground font-medium">Exotel</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleToggleExotel}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        tenant.exotelConfig.isEnabled ? "bg-primary" : "bg-white/10"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          tenant.exotelConfig.isEnabled ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                  <dl className="space-y-2.5">
                    <Row label="Account SID" value={tenant.exotelConfig.accountSid} />
                    <Row label="ExoPhone" value={tenant.exotelConfig.exophone} />
                    <Row label="Region" value={tenant.exotelConfig.region === "mumbai" ? "Mumbai (api.in.exotel.com)" : "Singapore (api.exotel.com)"} />
                    <Row label="App Flow URL" value={<span className="text-xs break-all">{tenant.exotelConfig.appFlowUrl}</span>} />
                    <Row label="API Key" value={tenant.exotelConfig.apiKeyConfigured ? "Configured" : "—"} />
                    <Row label="API Token" value={tenant.exotelConfig.apiTokenConfigured ? "Configured" : "—"} />
                  </dl>
                  <div className="text-[10px] text-muted-foreground leading-relaxed border border-white/10 rounded-md p-2 bg-white/5 space-y-1">
                    <p>
                      <span className="text-foreground font-medium">Voicebot applet:</span>{" "}
                      <code className="text-primary">wss://your-domain/ws/exotel/media-stream/{"{callLogId}"}</code>
                    </p>
                    <p>
                      <span className="text-foreground font-medium">Connect applet (for transfers):</span>{" "}
                      Dial Whom = Dynamic URL →{" "}
                      <code className="text-primary">https://your-domain/api/exotel/connect</code>
                    </p>
                    <p>Set CustomField to callLogId. Flow order: Voicebot → Connect (dynamic) → Hangup.</p>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" size="sm" className="border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={handleRemoveExotel}>
                      Remove
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setShowExotel(true)}>
                      <Edit2 className="w-4 h-4 mr-1.5" /> Edit
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
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

      <Dialog open={showSipTrunk} onOpenChange={setShowSipTrunk}>
        <DialogContent className="bg-card border-white/10 max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEditingSip ? "Edit SIP Trunk" : "Configure SIP Trunk"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSaveSipTrunk} className="space-y-4">
            <div className="space-y-2">
              <Label>SIP Domain *</Label>
              <Input
                value={sipForm.sipDomain}
                onChange={(e) => setSipForm({ ...sipForm, sipDomain: e.target.value })}
                placeholder="sip.example.com"
                required
                className="bg-white/5 border-white/10"
              />
            </div>
            <div className="space-y-2">
              <Label>SIP Username *</Label>
              <Input
                value={sipForm.sipUsername}
                onChange={(e) => setSipForm({ ...sipForm, sipUsername: e.target.value })}
                placeholder="username"
                required
                className="bg-white/5 border-white/10"
              />
            </div>
            <div className="space-y-2">
              <Label>
                SIP Password *{" "}
                {isEditingSip && <span className="text-muted-foreground text-xs">(leave blank to keep existing)</span>}
              </Label>
              <div className="relative">
                <Input
                  type={showSipPassword ? "text" : "password"}
                  value={sipForm.sipPassword}
                  onChange={(e) => setSipForm({ ...sipForm, sipPassword: e.target.value })}
                  placeholder="••••••••"
                  required={!isEditingSip}
                  className="bg-white/5 border-white/10 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowSipPassword(!showSipPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground hover:text-foreground focus:outline-none"
                >
                  {showSipPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Phone Number * (E.164)</Label>
              <Input
                value={sipForm.phoneNumber}
                onChange={(e) => setSipForm({ ...sipForm, phoneNumber: e.target.value })}
                placeholder="+1234567890"
                required
                className="bg-white/5 border-white/10"
              />
            </div>
            <div className="space-y-2">
              <Label>Outbound Proxy <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input
                value={sipForm.outboundProxy}
                onChange={(e) => setSipForm({ ...sipForm, outboundProxy: e.target.value })}
                placeholder="proxy.example.com"
                className="bg-white/5 border-white/10"
              />
            </div>
            <div className="space-y-2">
              <Label>Transport</Label>
              <select
                value={sipForm.transport}
                onChange={(e) => setSipForm({ ...sipForm, transport: e.target.value })}
                className="w-full h-10 rounded-md border border-white/10 bg-white/5 px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="UDP" className="bg-card text-foreground">UDP</option>
                <option value="TCP" className="bg-card text-foreground">TCP</option>
                <option value="TLS" className="bg-card text-foreground">TLS</option>
              </select>
            </div>
            <DialogFooter className="pt-2">
              <Button type="button" variant="ghost" onClick={() => setShowSipTrunk(false)}>Cancel</Button>
              <Button type="submit" disabled={savingSip}>
                {savingSip ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : "Save SIP Trunk"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showExotel} onOpenChange={setShowExotel}>
        <DialogContent className="bg-card border-white/10 max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{tenant.exotelConfig ? "Edit Exotel" : "Configure Exotel"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSaveExotel} className="space-y-4">
            <div className="text-xs text-muted-foreground leading-relaxed border border-white/10 rounded-md p-3 bg-white/5 space-y-1.5">
              <p>Copy credentials from Exotel → Developer Settings → API Credentials.</p>
              <p>
                Build a call flow: <span className="text-foreground font-medium">Voicebot</span> →{" "}
                <span className="text-foreground font-medium">Connect</span> →{" "}
                <span className="text-foreground font-medium">Hangup</span>.
              </p>
              <p>
                Voicebot WebSocket URL:{" "}
                <code className="text-primary text-[10px]">wss://your-domain/ws/exotel/media-stream/{"{callLogId}"}</code>
              </p>
              <p>
                Connect applet (human transfer): Dial Whom = Dynamic URL →{" "}
                <code className="text-primary text-[10px]">https://your-domain/api/exotel/connect</code>
              </p>
            </div>
            <div className="space-y-2">
              <Label>Account SID *</Label>
              <Input
                value={exotelForm.accountSid}
                onChange={(e) => setExotelForm({ ...exotelForm, accountSid: e.target.value })}
                placeholder="naveenindia1"
                required
                className="bg-white/5 border-white/10"
              />
            </div>
            <div className="space-y-2">
              <Label>
                API Key (Username) *{" "}
                {tenant.exotelConfig?.apiKeyConfigured && (
                  <span className="text-muted-foreground text-xs">(leave blank to keep existing)</span>
                )}
              </Label>
              <Input
                type={showExotelSecrets ? "text" : "password"}
                value={exotelForm.apiKey}
                onChange={(e) => setExotelForm({ ...exotelForm, apiKey: e.target.value })}
                placeholder="••••••••"
                required={!tenant.exotelConfig?.apiKeyConfigured}
                className="bg-white/5 border-white/10"
              />
            </div>
            <div className="space-y-2">
              <Label>
                API Token (Password) *{" "}
                {tenant.exotelConfig?.apiTokenConfigured && (
                  <span className="text-muted-foreground text-xs">(leave blank to keep existing)</span>
                )}
              </Label>
              <div className="relative">
                <Input
                  type={showExotelSecrets ? "text" : "password"}
                  value={exotelForm.apiToken}
                  onChange={(e) => setExotelForm({ ...exotelForm, apiToken: e.target.value })}
                  placeholder="••••••••"
                  required={!tenant.exotelConfig?.apiTokenConfigured}
                  className="bg-white/5 border-white/10 pr-16"
                />
                <button
                  type="button"
                  onClick={() => setShowExotelSecrets(!showExotelSecrets)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground hover:text-foreground focus:outline-none"
                >
                  {showExotelSecrets ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>ExoPhone (Caller ID) *</Label>
              <Input
                value={exotelForm.exophone}
                onChange={(e) => setExotelForm({ ...exotelForm, exophone: e.target.value })}
                placeholder="+91XXXXXXXXXX"
                required
                className="bg-white/5 border-white/10"
              />
            </div>
            <div className="space-y-2">
              <Label>Account Region *</Label>
              <select
                value={exotelForm.region}
                onChange={(e) => setExotelForm({ ...exotelForm, region: e.target.value })}
                className="w-full h-10 rounded-md border border-white/10 bg-white/5 px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="singapore" className="bg-card text-foreground">Singapore (api.exotel.com)</option>
                <option value="mumbai" className="bg-card text-foreground">Mumbai (api.in.exotel.com)</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>App Flow URL *</Label>
              <Input
                value={exotelForm.appFlowUrl}
                onChange={(e) => setExotelForm({ ...exotelForm, appFlowUrl: e.target.value })}
                placeholder="http://my.exotel.com/{sid}/exoml/start_voice/{app_id}"
                required
                className="bg-white/5 border-white/10"
              />
              <p className="text-[10px] text-muted-foreground">
                ExoML flow URL from Exotel dashboard — must include Voicebot applet for AI audio.
              </p>
            </div>
            <DialogFooter className="pt-2">
              <Button type="button" variant="ghost" onClick={() => setShowExotel(false)}>Cancel</Button>
              <Button type="submit" disabled={savingExotel}>
                {savingExotel ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : "Save Exotel"}
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
