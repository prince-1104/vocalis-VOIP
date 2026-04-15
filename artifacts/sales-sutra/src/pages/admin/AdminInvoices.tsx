import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminFetch } from "@/lib/admin-fetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Send,
  Plus,
  FileText,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Tenant {
  id: number;
  name: string;
  commissionPct: string;
  status: string;
}

interface Invoice {
  id: number;
  tenantId: number;
  tenantName: string | null;
  period: string;
  totalRawCostUsd: string;
  totalBilledCostUsd: string;
  commissionUsd: string;
  commissionPct: string;
  status: string;
  dueDate: string | null;
  paidAt: string | null;
  notes: string | null;
  createdAt: string;
}

function statusConfig(status: string): { label: string; icon: React.ComponentType<{ className?: string }>; className: string } {
  switch (status) {
    case "paid":
      return { label: "Paid", icon: CheckCircle2, className: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" };
    case "overdue":
      return { label: "Overdue", icon: AlertCircle, className: "bg-red-500/20 text-red-400 border-red-500/30" };
    case "sent":
      return { label: "Sent", icon: Send, className: "bg-blue-500/20 text-blue-400 border-blue-500/30" };
    default:
      return { label: "Draft", icon: Clock, className: "bg-gray-500/20 text-gray-400 border-gray-500/30" };
  }
}

function formatUsd(val: string | null | undefined) {
  const n = parseFloat(val ?? "0");
  return `$${n.toFixed(2)}`;
}

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function GenerateInvoiceModal({ tenants, onClose }: { tenants: Tenant[]; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tenantId, setTenantId] = React.useState("");
  const [period, setPeriod] = React.useState(currentPeriod());
  const [notes, setNotes] = React.useState("");

  const mutation = useMutation({
    mutationFn: () =>
      adminFetch(`${BASE}/api/admin/invoices/generate`, {
        method: "POST",
        body: JSON.stringify({ tenantId: parseInt(tenantId), period, notes: notes || undefined }),
      }),
    onSuccess: (data: unknown) => {
      const d = data as { callCount: number };
      toast({ title: "Invoice generated", description: `Created invoice for ${period} with ${d.callCount} calls.` });
      qc.invalidateQueries({ queryKey: ["admin-invoices"] });
      onClose();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to generate invoice";
      toast({ title: "Error", description: msg, variant: "destructive" });
    },
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Generate Invoice</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <Label>Tenant</Label>
          <Select value={tenantId} onValueChange={setTenantId}>
            <SelectTrigger className="bg-background border-white/10">
              <SelectValue placeholder="Select tenant…" />
            </SelectTrigger>
            <SelectContent>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.name}
                  <span className="ml-2 text-xs text-muted-foreground">({parseFloat(t.commissionPct).toFixed(1)}% commission)</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Period (YYYY-MM)</Label>
          <Input
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder="2025-01"
            className="bg-background border-white/10 font-mono"
          />
        </div>
        <div className="space-y-2">
          <Label>Notes (optional)</Label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional notes…"
            className="bg-background border-white/10"
          />
        </div>
        <Button
          className="w-full"
          disabled={!tenantId || !period || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Generate Invoice
        </Button>
      </div>
    </DialogContent>
  );
}

export default function AdminInvoices() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showGenerate, setShowGenerate] = React.useState(false);
  const [filterStatus, setFilterStatus] = React.useState("all");
  const [editingCommission, setEditingCommission] = React.useState<Record<number, string>>({});
  const [savingCommission, setSavingCommission] = React.useState<Record<number, boolean>>({});
  const [sortKey, setSortKey] = React.useState<"createdAt" | "dueDate" | "status" | "totalBilledCostUsd">("createdAt");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  const { data: invoicesData, isLoading: loadingInvoices } = useQuery<{ invoices: Invoice[] }>({
    queryKey: ["admin-invoices"],
    queryFn: () => adminFetch(`${BASE}/api/admin/invoices`),
  });

  const { data: tenantsRaw } = useQuery<Tenant[]>({
    queryKey: ["admin-tenants-list"],
    queryFn: () => adminFetch(`${BASE}/api/admin/tenants`),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      adminFetch(`${BASE}/api/admin/invoices/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_data, { status }) => {
      const labels: Record<string, string> = { paid: "marked as paid", sent: "marked as sent", overdue: "marked as overdue" };
      toast({ title: "Invoice updated", description: `Invoice ${labels[status] ?? "updated"}.` });
      qc.invalidateQueries({ queryKey: ["admin-invoices"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to update invoice";
      toast({ title: "Error", description: msg, variant: "destructive" });
    },
  });

  const invoices = invoicesData?.invoices ?? [];
  const tenants: Tenant[] = Array.isArray(tenantsRaw) ? tenantsRaw : [];

  async function saveCommission(tenantId: number) {
    const val = editingCommission[tenantId];
    if (val === undefined) return;
    setSavingCommission((s) => ({ ...s, [tenantId]: true }));
    try {
      await adminFetch(`${BASE}/api/admin/tenants/${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({ commissionPct: val }),
      });
      toast({ title: "Commission updated", description: `Commission set to ${val}% for this tenant.` });
      qc.invalidateQueries({ queryKey: ["admin-tenants-list"] });
      setEditingCommission((s) => { const n = { ...s }; delete n[tenantId]; return n; });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setSavingCommission((s) => ({ ...s, [tenantId]: false }));
    }
  }

  const filteredBase = filterStatus === "all" ? invoices : invoices.filter((inv) => inv.status === filterStatus);
  const filtered = [...filteredBase].sort((a, b) => {
    let av: string | number = a[sortKey as keyof Invoice] as string ?? "";
    let bv: string | number = b[sortKey as keyof Invoice] as string ?? "";
    if (sortKey === "totalBilledCostUsd") { av = parseFloat(av as string); bv = parseFloat(bv as string); }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === "asc" ? cmp : -cmp;
  });

  const stats = {
    total: invoices.length,
    overdue: invoices.filter((i) => i.status === "overdue").length,
    unpaid: invoices.filter((i) => i.status === "sent" || i.status === "overdue").length,
    totalBilled: invoices.reduce((s, i) => s + parseFloat(i.totalBilledCostUsd), 0),
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Invoice Management</h1>
          <p className="text-muted-foreground text-sm mt-1">Generate and manage tenant invoices</p>
        </div>
        <Button onClick={() => setShowGenerate(true)} className="gap-2">
          <Plus className="w-4 h-4" /> Generate Invoice
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Total Invoices", value: stats.total, color: "text-white" },
          { label: "Overdue", value: stats.overdue, color: "text-red-400" },
          { label: "Awaiting Payment", value: stats.unpaid, color: "text-amber-400" },
          { label: "Total Billed", value: `$${stats.totalBilled.toFixed(2)}`, color: "text-emerald-400" },
        ].map((s) => (
          <div key={s.label} className="glass-panel rounded-xl p-4">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className={cn("text-2xl font-bold mt-1", s.color)}>{s.value}</p>
          </div>
        ))}
      </div>

      {tenants.length > 0 && (
        <div className="border border-white/10 rounded-2xl overflow-hidden bg-card/50">
          <div className="px-4 py-3 border-b border-white/10">
            <h2 className="text-sm font-semibold text-white">Tenant Commission Rates</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Edit commission % per tenant — applies to future invoice generation</p>
          </div>
          <div className="divide-y divide-white/5">
            {tenants.map((t) => {
              const isEditing = editingCommission[t.id] !== undefined;
              const currentVal = isEditing ? editingCommission[t.id] : parseFloat(t.commissionPct).toFixed(2);
              return (
                <div key={t.id} className="flex items-center gap-4 px-4 py-3">
                  <span className="flex-1 text-sm font-medium text-white">{t.name}</span>
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={currentVal}
                        onChange={(e) => setEditingCommission((s) => ({ ...s, [t.id]: e.target.value }))}
                        className="w-24 bg-background border-white/10 text-right font-mono text-sm pr-6"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">%</span>
                    </div>
                    {isEditing && (
                      <Button
                        size="sm"
                        className="text-xs"
                        disabled={savingCommission[t.id]}
                        onClick={() => saveCommission(t.id)}
                      >
                        {savingCommission[t.id] ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                      </Button>
                    )}
                    {isEditing && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-xs text-muted-foreground"
                        onClick={() => setEditingCommission((s) => { const n = { ...s }; delete n[t.id]; return n; })}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Label className="text-muted-foreground text-sm shrink-0">Filter by status:</Label>
        {["all", "draft", "sent", "paid", "overdue"].map((s) => (
          <Button
            key={s}
            variant="ghost"
            size="sm"
            onClick={() => setFilterStatus(s)}
            className={cn(
              "capitalize text-xs",
              filterStatus === s
                ? "bg-primary/20 text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {s}
          </Button>
        ))}
      </div>

      {loadingInvoices ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading invoices…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
          <FileText className="w-10 h-10 opacity-30" />
          <p>No invoices found.</p>
        </div>
      ) : (
        <div className="border border-white/10 rounded-2xl overflow-hidden bg-card/50">
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-muted-foreground">Invoice</TableHead>
                <TableHead className="text-muted-foreground">Tenant</TableHead>
                <TableHead className="text-muted-foreground">Period</TableHead>
                <TableHead className="text-muted-foreground">Commission</TableHead>
                <TableHead
                  className="text-muted-foreground text-right cursor-pointer hover:text-foreground select-none"
                  onClick={() => toggleSort("totalBilledCostUsd")}
                >
                  Billed {sortKey === "totalBilledCostUsd" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                </TableHead>
                <TableHead
                  className="text-muted-foreground cursor-pointer hover:text-foreground select-none"
                  onClick={() => toggleSort("status")}
                >
                  Status {sortKey === "status" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                </TableHead>
                <TableHead
                  className="text-muted-foreground cursor-pointer hover:text-foreground select-none"
                  onClick={() => toggleSort("dueDate")}
                >
                  Due {sortKey === "dueDate" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                </TableHead>
                <TableHead className="text-muted-foreground">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((inv) => {
                const sc = statusConfig(inv.status);
                return (
                  <TableRow
                    key={inv.id}
                    className={cn(
                      "border-white/5 hover:bg-white/2",
                      inv.status === "overdue" && "bg-red-500/5"
                    )}
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground">#{inv.id}</TableCell>
                    <TableCell className="font-medium">{inv.tenantName ?? `Tenant ${inv.tenantId}`}</TableCell>
                    <TableCell className="font-mono">{inv.period}</TableCell>
                    <TableCell className="text-xs text-amber-400">{parseFloat(inv.commissionPct).toFixed(1)}%</TableCell>
                    <TableCell className="text-right font-mono font-semibold">{formatUsd(inv.totalBilledCostUsd)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("gap-1", sc.className)}>
                        <sc.icon className="w-3 h-3" />
                        {sc.label}
                      </Badge>
                    </TableCell>
                    <TableCell className={cn("text-sm", inv.status === "overdue" && "text-red-400 font-medium")}>
                      {formatDate(inv.dueDate)}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {inv.status === "draft" && (
                          <Button
                            variant="ghost" size="sm"
                            className="text-xs text-blue-400 hover:text-blue-300"
                            onClick={() => updateMutation.mutate({ id: inv.id, status: "sent" })}
                            disabled={updateMutation.isPending}
                          >
                            Mark Sent
                          </Button>
                        )}
                        {(inv.status === "sent" || inv.status === "overdue") && (
                          <Button
                            variant="ghost" size="sm"
                            className="text-xs text-emerald-400 hover:text-emerald-300"
                            onClick={() => updateMutation.mutate({ id: inv.id, status: "paid" })}
                            disabled={updateMutation.isPending}
                          >
                            Mark Paid
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={showGenerate} onOpenChange={setShowGenerate}>
        {showGenerate && (
          <GenerateInvoiceModal
            tenants={tenants}
            onClose={() => setShowGenerate(false)}
          />
        )}
      </Dialog>
    </div>
  );
}
