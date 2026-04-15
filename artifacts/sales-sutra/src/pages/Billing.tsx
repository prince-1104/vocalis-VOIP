import React from "react";
import { useQuery } from "@tanstack/react-query";
import { adminFetch } from "@/lib/admin-fetch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FileText, Download, CreditCard, AlertCircle, CheckCircle2, Clock, Send } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Invoice {
  id: number;
  tenantId: number;
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

interface LineItem {
  id: number;
  callLogId: number | null;
  rawCostUsd: string;
  billedCostUsd: string;
  durationSeconds: number | null;
  phone: string | null;
  startedAt: string | null;
}

interface InvoiceDetail {
  invoice: Invoice;
  tenant?: { id: number; name: string } | null;
  lineItems: LineItem[];
  callCount: number;
  totalMinutes: number;
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

function InvoiceModal({ invoiceId, onClose }: { invoiceId: number; onClose: () => void }) {
  const { data, isLoading } = useQuery<InvoiceDetail>({
    queryKey: ["invoice-detail", invoiceId],
    queryFn: () => adminFetch(`${BASE}/api/invoices/${invoiceId}`),
  });

  const handlePrint = () => window.print();

  if (isLoading) {
    return (
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Loading Invoice…</DialogTitle></DialogHeader>
      </DialogContent>
    );
  }

  if (!data) return null;
  const { invoice, lineItems, callCount, totalMinutes } = data;
  const sc = statusConfig(invoice.status);

  return (
    <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto print:max-w-none print:max-h-none print:overflow-visible">
      <DialogHeader>
        <DialogTitle className="flex items-center justify-between">
          <span>Invoice #{invoice.id} — {invoice.period}</span>
          <Badge variant="outline" className={sc.className}>{sc.label}</Badge>
        </DialogTitle>
        {data.tenant?.name && (
          <p className="text-sm text-muted-foreground">{data.tenant.name}</p>
        )}
      </DialogHeader>

      <div className="space-y-6 py-2" id="invoice-print-area">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Period</p>
            <p className="font-medium">{invoice.period}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Due Date</p>
            <p className="font-medium">{formatDate(invoice.dueDate)}</p>
          </div>
          {invoice.paidAt && (
            <div>
              <p className="text-muted-foreground">Paid At</p>
              <p className="font-medium text-emerald-400">{formatDate(invoice.paidAt)}</p>
            </div>
          )}
          <div>
            <p className="text-muted-foreground">Total Calls</p>
            <p className="font-medium">{callCount}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Total Minutes</p>
            <p className="font-medium">{totalMinutes.toFixed(1)} min</p>
          </div>
        </div>

        <div className="border border-white/10 rounded-xl overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-muted-foreground">Description</TableHead>
                <TableHead className="text-muted-foreground text-right">Raw Cost</TableHead>
                <TableHead className="text-muted-foreground text-right">Commission ({parseFloat(invoice.commissionPct).toFixed(1)}%)</TableHead>
                <TableHead className="text-muted-foreground text-right">Billed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lineItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">No line items</TableCell>
                </TableRow>
              ) : (
                lineItems.slice(0, 20).map((li) => (
                  <TableRow key={li.id} className="border-white/5 hover:bg-white/2">
                    <TableCell className="text-sm">
                      <span className="font-mono text-xs text-muted-foreground">{li.phone ?? "Unknown"}</span>
                      {li.startedAt && (
                        <span className="ml-2 text-xs text-muted-foreground">{formatDate(li.startedAt)}</span>
                      )}
                      {li.durationSeconds != null && (
                        <span className="ml-2 text-xs text-muted-foreground">{Math.ceil(li.durationSeconds / 60)} min</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm font-mono">{formatUsd(li.rawCostUsd)}</TableCell>
                    <TableCell className="text-right text-sm font-mono text-amber-400">
                      +{formatUsd((parseFloat(li.billedCostUsd) - parseFloat(li.rawCostUsd)).toFixed(6))}
                    </TableCell>
                    <TableCell className="text-right text-sm font-mono font-medium">{formatUsd(li.billedCostUsd)}</TableCell>
                  </TableRow>
                ))
              )}
              {lineItems.length > 20 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-xs text-muted-foreground">
                    + {lineItems.length - 20} more calls
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="border border-white/10 rounded-xl p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Raw Cost (AI + Twilio)</span>
            <span className="font-mono">{formatUsd(invoice.totalRawCostUsd)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Commission ({parseFloat(invoice.commissionPct).toFixed(1)}%)</span>
            <span className="font-mono text-amber-400">+{formatUsd(invoice.commissionUsd)}</span>
          </div>
          <div className="border-t border-white/10 pt-2 flex justify-between font-semibold">
            <span>Total Due</span>
            <span className="font-mono text-lg">{formatUsd(invoice.totalBilledCostUsd)}</span>
          </div>
        </div>

        {invoice.notes && (
          <div className="text-sm text-muted-foreground border border-white/10 rounded-xl p-3">
            <p className="font-medium text-foreground mb-1">Notes</p>
            <p>{invoice.notes}</p>
          </div>
        )}

        <div className="flex gap-3 print:hidden">
          <Button variant="outline" className="gap-2" onClick={handlePrint}>
            <Download className="w-4 h-4" /> Download / Print PDF
          </Button>
          {invoice.status !== "paid" && (
            <Button className="gap-2 bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30">
              <CreditCard className="w-4 h-4" /> Pay Now (Contact Support)
            </Button>
          )}
        </div>
      </div>
    </DialogContent>
  );
}

export default function Billing() {
  const [selectedInvoiceId, setSelectedInvoiceId] = React.useState<number | null>(null);

  const { data, isLoading } = useQuery<{ invoices: Invoice[] }>({
    queryKey: ["my-invoices"],
    queryFn: () => adminFetch(`${BASE}/api/invoices`),
  });

  const invoices = data?.invoices ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">
          Billing
        </h1>
        <p className="text-muted-foreground mt-1">Your monthly invoices and billing history</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">Loading invoices…</div>
      ) : invoices.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
          <FileText className="w-10 h-10 opacity-30" />
          <p>No invoices yet. Your invoices will appear here once generated.</p>
        </div>
      ) : (
        <div className="border border-white/10 rounded-2xl overflow-hidden bg-card/50">
          <Table>
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-muted-foreground">Period</TableHead>
                <TableHead className="text-muted-foreground">Status</TableHead>
                <TableHead className="text-muted-foreground text-right">Amount Due</TableHead>
                <TableHead className="text-muted-foreground">Due Date</TableHead>
                <TableHead className="text-muted-foreground">Paid At</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => {
                const sc = statusConfig(inv.status);
                return (
                  <TableRow
                    key={inv.id}
                    className={cn(
                      "border-white/5 hover:bg-white/3 cursor-pointer",
                      inv.status === "overdue" && "bg-red-500/5"
                    )}
                    onClick={() => setSelectedInvoiceId(inv.id)}
                  >
                    <TableCell className="font-medium">{inv.period}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("gap-1", sc.className)}>
                        <sc.icon className="w-3 h-3" />
                        {sc.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold">
                      {formatUsd(inv.totalBilledCostUsd)}
                    </TableCell>
                    <TableCell className={cn("text-sm", inv.status === "overdue" && "text-red-400 font-medium")}>
                      {formatDate(inv.dueDate)}
                    </TableCell>
                    <TableCell className="text-sm text-emerald-400">{formatDate(inv.paidAt)}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" className="gap-1 text-xs">
                        <FileText className="w-3 h-3" /> View
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={selectedInvoiceId !== null} onOpenChange={(open) => !open && setSelectedInvoiceId(null)}>
        {selectedInvoiceId !== null && (
          <InvoiceModal invoiceId={selectedInvoiceId} onClose={() => setSelectedInvoiceId(null)} />
        )}
      </Dialog>
    </div>
  );
}
