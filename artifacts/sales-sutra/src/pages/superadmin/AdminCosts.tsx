import { useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import {
  DollarSign, AlertTriangle, TrendingUp, Building2, ChevronRight,
  Loader2, Shield, ShieldAlert, ShieldCheck, Send, Save, ArrowLeft,
  BarChart3, Cpu, Volume2, Mic, Download, Layers
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { adminAuthHeaders } from "@/lib/admin-fetch";

interface TenantCostRow {
  tenantId: number;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: string;
  monthlyLimitUsd: number;
  hardLimit: boolean;
  totalCostUsd: number;
  llmCostUsd: number;
  ttsCostUsd: number;
  sttCostUsd: number;
  apiCalls: number;
  usagePercent: number;
  status: "ok" | "warning" | "over_limit";
  limitAlertSentAt: string | null;
  alertMonth: string | null;
}

interface CostSummary {
  totalTenants: number;
  combinedCostUsd: number;
  tenantsAtRisk: number;
  tenantsOverLimit: number;
}

interface TenantDetail {
  tenantId: number;
  tenantName: string;
  breakdown: Array<{
    apiProvider: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    characters: number;
    minutes: number;
    callCount: number;
  }>;
  subtotals: { llm: number; tts: number; stt: number };
  grandTotal: number;
  monthlyLimitUsd: number;
  hardLimit: boolean;
  usagePercent: number;
  status: string;
  limitAlertSentAt: string | null;
  alertMonth: string | null;
  trend: Array<{ month: string; costUsd: number }>;
}

type FilterMode = "all" | "warning" | "over_limit" | "under_50";

export default function AdminCosts() {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [tenants, setTenants] = useState<TenantCostRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [selectedTenant, setSelectedTenant] = useState<number | null>(null);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editingLimit, setEditingLimit] = useState<{ id: number; value: string; hardLimit: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [sendingAlert, setSendingAlert] = useState<number | null>(null);
  const [selectedTenants, setSelectedTenants] = useState<number[]>([]);
  const { toast } = useToast();

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch("/api/superadmin/costs", { headers: adminAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSummary(data.summary);
        setTenants(data.tenants);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  async function fetchDetail(tenantId: number) {
    setDetailLoading(true);
    setSelectedTenant(tenantId);
    try {
      const res = await fetch(`/api/superadmin/costs/${tenantId}`, { headers: adminAuthHeaders() });
      if (res.ok) setDetail(await res.json());
    } finally {
      setDetailLoading(false);
    }
  }

  async function saveLimit() {
    if (!editingLimit) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/superadmin/costs/${editingLimit.id}/limit`, {
        method: "PATCH",
        headers: { ...adminAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          monthlyLimitUsd: parseFloat(editingLimit.value) || 5,
          hardLimit: editingLimit.hardLimit,
        }),
      });
      if (res.ok) {
        toast({ title: "Limit updated" });
        setEditingLimit(null);
        await fetchOverview();
        if (selectedTenant === editingLimit.id) await fetchDetail(editingLimit.id);
      }
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function sendAlert(tenantId: number) {
    setSendingAlert(tenantId);
    try {
      const res = await fetch(`/api/superadmin/costs/${tenantId}/send-alert`, {
        method: "POST",
        headers: adminAuthHeaders(),
      });
      if (res.ok) {
        toast({ title: "Alert sent" });
        await fetchOverview();
      }
    } catch {
      toast({ title: "Failed to send alert", variant: "destructive" });
    } finally {
      setSendingAlert(null);
    }
  }

  function handleExportCsv() {
    const header = "Tenant Name,Slug,Calls,Total Cost USD,Monthly Limit USD,Usage %,Status\n";
    const csv = filtered.map(t => 
      `${t.tenantName},${t.tenantSlug},${t.apiCalls},${t.totalCostUsd},${t.monthlyLimitUsd},${t.usagePercent.toFixed(1)},${t.status}`
    ).join("\n");
    const blob = new Blob([header + csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tenant-costs-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  }

  async function handleBulkLimit() {
    const val = prompt("Enter new monthly limit (USD) for selected tenants:");
    if (!val || isNaN(parseFloat(val))) return;
    setSaving(true);
    try {
      await Promise.all(selectedTenants.map(id =>
        fetch(`/api/superadmin/costs/${id}/limit`, {
          method: "PATCH",
          headers: { ...adminAuthHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ monthlyLimitUsd: parseFloat(val) }),
        })
      ));
      toast({ title: `Updated limits for ${selectedTenants.length} tenants` });
      setSelectedTenants([]);
      await fetchOverview();
    } catch {
      toast({ title: "Bulk update failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const filtered = tenants.filter(t => {
    if (filter === "warning") return t.status === "warning";
    if (filter === "over_limit") return t.status === "over_limit";
    if (filter === "under_50") return t.usagePercent < 50;
    return true;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // ── Detail View ──────────────────────────────────────────────────────
  if (selectedTenant && detail) {
    return <DetailView
      detail={detail}
      loading={detailLoading}
      onBack={() => { setSelectedTenant(null); setDetail(null); }}
      editingLimit={editingLimit}
      setEditingLimit={setEditingLimit}
      saveLimit={saveLimit}
      saving={saving}
      sendAlert={sendAlert}
      sendingAlert={sendingAlert}
    />;
  }

  // ── Overview ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Tenant Cost Monitoring</h1>
        <p className="text-muted-foreground mt-1">Track API spending, set limits, and manage alerts</p>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCard icon={Building2} label="Total Tenants" value={summary.totalTenants} color="text-primary" />
          <SummaryCard icon={DollarSign} label="Combined Cost" value={`$${summary.combinedCostUsd.toFixed(4)}`} color="text-green-400" />
          <SummaryCard icon={AlertTriangle} label="At Risk (≥80%)" value={summary.tenantsAtRisk} color="text-amber-400" />
          <SummaryCard icon={ShieldAlert} label="Over Limit" value={summary.tenantsOverLimit} color="text-red-400" />
        </div>
      )}

      {/* Filter Buttons & Actions */}
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div className="flex gap-2 flex-wrap">
          {(["all", "warning", "over_limit", "under_50"] as FilterMode[]).map(f => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "outline"}
              onClick={() => setFilter(f)}
              className={filter === f ? "" : "border-white/10 text-muted-foreground hover:text-foreground"}
            >
              {f === "all" ? "All" : f === "warning" ? "⚠ Warning" : f === "over_limit" ? "🔴 Over Limit" : "Under 50%"}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          {selectedTenants.length > 0 && (
            <Button size="sm" variant="secondary" onClick={handleBulkLimit} disabled={saving} className="gap-2">
              <Layers className="w-4 h-4" /> Bulk Set Limit ({selectedTenants.length})
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleExportCsv} className="gap-2 border-white/10">
            <Download className="w-4 h-4" /> Export CSV
          </Button>
        </div>
      </div>

      {/* Tenant Cost Table */}
      <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
        <div className="px-6 py-4 border-b border-white/5">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-primary" /> Monthly Spending — {filtered.length} tenant{filtered.length !== 1 ? "s" : ""}
          </h2>
        </div>

        {/* Header */}
        <div className="hidden md:grid grid-cols-[40px_1fr_100px_120px_80px_100px_140px] gap-2 px-6 py-3 text-xs text-muted-foreground border-b border-white/5 font-medium">
          <div className="flex items-center">
            <input 
              type="checkbox" 
              className="rounded bg-white/5 border-white/10"
              checked={selectedTenants.length === filtered.length && filtered.length > 0}
              onChange={e => setSelectedTenants(e.target.checked ? filtered.map(t => t.tenantId) : [])}
            />
          </div>
          <span>Tenant</span>
          <span className="text-right">Limit</span>
          <span className="text-right">This Month</span>
          <span className="text-right">Usage</span>
          <span className="text-center">Status</span>
          <span className="text-right">Actions</span>
        </div>

        <div className="divide-y divide-white/5">
          {filtered.map(t => (
            <div key={t.tenantId} className="grid grid-cols-1 md:grid-cols-[40px_1fr_100px_120px_80px_100px_140px] gap-2 px-6 py-4 items-center hover:bg-white/[0.02] transition-colors">
              {/* Checkbox */}
              <div className="flex items-center">
                <input 
                  type="checkbox" 
                  className="rounded bg-white/5 border-white/10"
                  checked={selectedTenants.includes(t.tenantId)}
                  onChange={e => {
                    if (e.target.checked) setSelectedTenants([...selectedTenants, t.tenantId]);
                    else setSelectedTenants(selectedTenants.filter(id => id !== t.tenantId));
                  }}
                />
              </div>

              {/* Tenant Name */}
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-sm font-bold text-primary">
                  {t.tenantName.charAt(0)}
                </div>
                <div>
                  <p className="font-medium text-sm text-foreground">{t.tenantName}</p>
                  <p className="text-xs text-muted-foreground">/{t.tenantSlug} · {t.apiCalls} calls</p>
                </div>
              </div>

              {/* Limit */}
              <div className="text-right">
                {editingLimit?.id === t.tenantId ? (
                  <Input
                    type="number"
                    step="0.5"
                    min="0"
                    value={editingLimit.value}
                    onChange={e => setEditingLimit({ ...editingLimit, value: e.target.value })}
                    onKeyDown={e => e.key === "Enter" && saveLimit()}
                    className="h-7 text-xs bg-white/5 border-white/10 w-20 ml-auto"
                    autoFocus
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">${t.monthlyLimitUsd.toFixed(2)}</span>
                )}
              </div>

              {/* Cost */}
              <div className="text-right">
                <span className="text-sm font-medium text-foreground">${t.totalCostUsd.toFixed(4)}</span>
              </div>

              {/* Usage Bar */}
              <div className="text-right">
                <div className="inline-flex items-center gap-2">
                  <div className="w-12 h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        t.usagePercent >= 100 ? "bg-red-500" : t.usagePercent >= 80 ? "bg-amber-500" : "bg-green-500"
                      }`}
                      style={{ width: `${Math.min(t.usagePercent, 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground w-10">{t.usagePercent.toFixed(0)}%</span>
                </div>
              </div>

              {/* Status */}
              <div className="flex justify-center">
                <Badge
                  className={`text-[10px] ${
                    t.status === "over_limit"
                      ? "bg-red-500/20 text-red-400 border-red-500/30"
                      : t.status === "warning"
                        ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                        : "bg-green-500/20 text-green-400 border-green-500/30"
                  }`}
                >
                  {t.status === "over_limit" ? "Over Limit" : t.status === "warning" ? "Warning" : "OK"}
                </Badge>
              </div>

              {/* Actions */}
              <div className="flex gap-1 justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs px-2"
                  onClick={() => {
                    if (editingLimit?.id === t.tenantId) saveLimit();
                    else setEditingLimit({ id: t.tenantId, value: t.monthlyLimitUsd.toString(), hardLimit: t.hardLimit });
                  }}
                >
                  {editingLimit?.id === t.tenantId ? <Save className="w-3.5 h-3.5" /> : "Set Limit"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs px-2"
                  onClick={() => fetchDetail(t.tenantId)}
                >
                  Detail <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
                </Button>
                {(t.status === "warning" || t.status === "over_limit") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs px-2 text-amber-400 hover:text-amber-300"
                    disabled={sendingAlert === t.tenantId}
                    onClick={() => sendAlert(t.tenantId)}
                  >
                    {sendingAlert === t.tenantId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-center py-10 text-muted-foreground text-sm">No tenants match this filter</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Detail View Component ────────────────────────────────────────────────
function DetailView({
  detail, loading, onBack, editingLimit, setEditingLimit, saveLimit, saving, sendAlert, sendingAlert,
}: {
  detail: TenantDetail;
  loading: boolean;
  onBack: () => void;
  editingLimit: { id: number; value: string; hardLimit: boolean } | null;
  setEditingLimit: (v: { id: number; value: string; hardLimit: boolean } | null) => void;
  saveLimit: () => void;
  saving: boolean;
  sendAlert: (id: number) => void;
  sendingAlert: number | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const maxTrend = Math.max(...detail.trend.map(t => t.costUsd), 0.001);

  const providerLabels: Record<string, string> = {
    "llm:gpt-4o-mini": "GPT-4o Mini",
    "llm:deepseek-chat": "DeepSeek V3",
    "llm:sarvam-m": "Sarvam-M",
    "tts:sarvam": "Sarvam Bulbul v3",
    "tts:openai": "OpenAI TTS",
    "stt:whisper": "Whisper STT",
  };

  const providerIcons: Record<string, typeof Cpu> = {
    "llm:": Cpu,
    "tts:": Volume2,
    "stt:": Mic,
  };

  function getProviderIcon(provider: string) {
    for (const [prefix, Icon] of Object.entries(providerIcons)) {
      if (provider.startsWith(prefix)) return Icon;
    }
    return Cpu;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{detail.tenantName}</h1>
          <p className="text-muted-foreground text-sm">Detailed cost breakdown — current month</p>
        </div>
      </div>

      {/* Grand Total + Limit Card */}
      <div className="glass-panel rounded-xl border border-white/5 p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Grand Total This Month</p>
            <p className="text-3xl font-bold text-foreground">${detail.grandTotal.toFixed(4)}</p>
            <div className="flex items-center gap-3 mt-2">
              <div className="w-32 h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    detail.usagePercent >= 100 ? "bg-red-500" : detail.usagePercent >= 80 ? "bg-amber-500" : "bg-green-500"
                  }`}
                  style={{ width: `${Math.min(detail.usagePercent, 100)}%` }}
                />
              </div>
              <span className="text-sm text-muted-foreground">{detail.usagePercent.toFixed(1)}% of ${detail.monthlyLimitUsd.toFixed(2)}</span>
              <Badge className={`text-[10px] ${
                detail.status === "over_limit"
                  ? "bg-red-500/20 text-red-400 border-red-500/30"
                  : detail.status === "warning"
                    ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                    : "bg-green-500/20 text-green-400 border-green-500/30"
              }`}>
                {detail.status === "over_limit" ? "Over Limit" : detail.status === "warning" ? "Warning" : "OK"}
              </Badge>
            </div>
          </div>

          {/* Limit Editor */}
          <div className="flex flex-col gap-2 p-4 rounded-lg bg-white/[0.03] border border-white/5 min-w-[220px]">
            <Label className="text-xs text-muted-foreground">Monthly Limit (USD)</Label>
            <div className="flex gap-2 items-center">
              <Input
                type="number"
                step="0.5"
                min="0"
                value={editingLimit?.id === detail.tenantId ? editingLimit.value : detail.monthlyLimitUsd.toString()}
                onChange={e => setEditingLimit({ id: detail.tenantId, value: e.target.value, hardLimit: editingLimit?.hardLimit ?? detail.hardLimit })}
                className="h-8 text-sm bg-white/5 border-white/10 w-24"
              />
              <Button
                size="sm"
                className="h-8 gap-1"
                disabled={saving}
                onClick={() => {
                  if (!editingLimit || editingLimit.id !== detail.tenantId) {
                    setEditingLimit({ id: detail.tenantId, value: detail.monthlyLimitUsd.toString(), hardLimit: detail.hardLimit });
                  } else {
                    saveLimit();
                  }
                }}
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save
              </Button>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <Switch
                checked={editingLimit?.id === detail.tenantId ? editingLimit.hardLimit : detail.hardLimit}
                onCheckedChange={checked => setEditingLimit({
                  id: detail.tenantId,
                  value: editingLimit?.id === detail.tenantId ? editingLimit.value : detail.monthlyLimitUsd.toString(),
                  hardLimit: checked,
                })}
              />
              <Label className="text-xs text-muted-foreground cursor-pointer">Hard limit (block API calls)</Label>
            </div>
            {detail.limitAlertSentAt && (
              <p className="text-[10px] text-muted-foreground mt-1">
                Alert sent: {new Date(detail.limitAlertSentAt).toLocaleDateString()} ({detail.alertMonth})
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              className="mt-1 h-7 gap-1 text-xs border-white/10"
              disabled={sendingAlert === detail.tenantId}
              onClick={() => sendAlert(detail.tenantId)}
            >
              {sendingAlert === detail.tenantId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              Send Alert
            </Button>
          </div>
        </div>
      </div>

      {/* Category Subtotals */}
      <div className="grid grid-cols-3 gap-4">
        <SubtotalCard label="LLM" value={detail.subtotals.llm} icon={Cpu} />
        <SubtotalCard label="TTS" value={detail.subtotals.tts} icon={Volume2} />
        <SubtotalCard label="STT" value={detail.subtotals.stt} icon={Mic} />
      </div>

      {/* Per-Provider Breakdown */}
      <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
        <div className="px-6 py-4 border-b border-white/5">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-primary" /> API Breakdown
          </h2>
        </div>
        <div className="hidden md:grid grid-cols-[1fr_100px_100px_90px_80px_80px] gap-2 px-6 py-3 text-xs text-muted-foreground border-b border-white/5 font-medium">
          <span>Provider</span>
          <span className="text-right">Cost</span>
          <span className="text-right">In Tokens</span>
          <span className="text-right">Out Tokens</span>
          <span className="text-right">Chars</span>
          <span className="text-right">Calls</span>
        </div>
        <div className="divide-y divide-white/5">
          {detail.breakdown.length === 0 && (
            <div className="text-center py-8 text-muted-foreground text-sm">No API usage this month</div>
          )}
          {detail.breakdown.map((b, i) => {
            const Icon = getProviderIcon(b.apiProvider);
            return (
              <div key={i} className="grid grid-cols-1 md:grid-cols-[1fr_100px_100px_90px_80px_80px] gap-2 px-6 py-3 items-center">
                <div className="flex items-center gap-2">
                  <Icon className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">{providerLabels[b.apiProvider] ?? b.apiProvider}</span>
                </div>
                <span className="text-right text-sm font-medium text-foreground">${b.costUsd.toFixed(6)}</span>
                <span className="text-right text-sm text-muted-foreground">{b.inputTokens > 0 ? b.inputTokens.toLocaleString() : "—"}</span>
                <span className="text-right text-sm text-muted-foreground">{b.outputTokens > 0 ? b.outputTokens.toLocaleString() : "—"}</span>
                <span className="text-right text-sm text-muted-foreground">{b.characters > 0 ? b.characters.toLocaleString() : "—"}</span>
                <span className="text-right text-sm text-muted-foreground">{b.callCount}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 6-Month Trend */}
      <div className="glass-panel rounded-xl border border-white/5 p-6">
        <h2 className="font-semibold text-foreground flex items-center gap-2 mb-4">
          <BarChart3 className="w-5 h-5 text-primary" /> 6-Month Cost Trend
        </h2>
        <div className="flex items-end gap-3 h-32">
          {detail.trend.map((t, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[10px] text-muted-foreground">${t.costUsd.toFixed(2)}</span>
              <div className="w-full bg-white/5 rounded-t-md overflow-hidden" style={{ height: "80px" }}>
                <div
                  className="w-full bg-gradient-to-t from-primary/60 to-primary/20 rounded-t-md transition-all"
                  style={{ height: `${maxTrend > 0 ? (t.costUsd / maxTrend) * 100 : 0}%`, marginTop: "auto" }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground">{t.month.slice(5)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Reusable UI Atoms ────────────────────────────────────────────────────
function SummaryCard({ icon: Icon, label, value, color }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string | number; color: string }) {
  return (
    <div className="glass-panel rounded-xl p-4 border border-white/5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Icon className={`w-4 h-4 ${color}`} />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-lg font-bold text-foreground">{value}</p>
        </div>
      </div>
    </div>
  );
}

function SubtotalCard({ label, value, icon: Icon }: { label: string; value: number; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="glass-panel rounded-xl p-4 border border-white/5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label} Cost</p>
          <p className="text-lg font-bold text-foreground">${value.toFixed(4)}</p>
        </div>
      </div>
    </div>
  );
}
