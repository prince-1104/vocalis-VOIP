import React, { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { getStoredToken } from "@/hooks/use-auth";
import { AlertTriangle, CheckCircle2, Info, Loader2, ShieldCheck, ToggleLeft, ToggleRight } from "lucide-react";

export type VerificationMethod = "order_suffix_4" | "order_suffix_6" | "date_of_birth" | "sms_otp";

export interface VerificationPolicyView {
  policy: {
    enabled: boolean;
    method: VerificationMethod;
    dobFieldPath: string | null;
    dobFormat: string | null;
    version: number;
    updatedAt: string | null;
  };
  status: "disabled" | "active" | "needs_attention";
  reasons: string[];
  requirements: {
    crmConnected: boolean;
    widgetCrmEnabled: boolean;
    verificationKeyConfigured: boolean;
    otpDeliveryConfigured: boolean;
  };
  methods: Array<{
    id: VerificationMethod;
    label: string;
    assurance: "lower" | "moderate" | "higher";
    supported: boolean;
    unsupportedReason: string | null;
    requiresDobMapping: boolean;
  }>;
  dobFormats: string[];
}

const ENDPOINT = "/api/widget-verification/policy";

async function request(method: "GET" | "PUT", body?: unknown) {
  const res = await fetch(`${window.location.origin}${ENDPOINT}`, {
    method,
    headers: { Authorization: `Bearer ${getStoredToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const ASSURANCE_STYLE: Record<string, string> = {
  lower: "text-amber-300 bg-amber-500/10 border-amber-500/20",
  moderate: "text-sky-300 bg-sky-500/10 border-sky-500/20",
  higher: "text-green-300 bg-green-500/10 border-green-500/20",
};

/**
 * Tenant-admin settings for public widget customer verification. All
 * authorization and validation is enforced by the API; this UI only
 * reflects it.
 */
export function CustomerVerificationCard({ onChange }: { onChange?: (view: VerificationPolicyView | null) => void }) {
  const { toast } = useToast();
  const [view, setView] = useState<VerificationPolicyView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{ field?: string; message: string } | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [method, setMethod] = useState<VerificationMethod>("order_suffix_4");
  const [dobFieldPath, setDobFieldPath] = useState("");
  const [dobFormat, setDobFormat] = useState("");

  const apply = useCallback((next: VerificationPolicyView) => {
    setView(next);
    setEnabled(next.policy.enabled);
    setMethod(next.policy.method);
    setDobFieldPath(next.policy.dobFieldPath ?? "");
    setDobFormat(next.policy.dobFormat ?? "");
    onChange?.(next);
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    request("GET").then(({ ok, status, data }) => {
      if (cancelled) return;
      if (ok) apply(data as VerificationPolicyView);
      else {
        setLoadError(status === 403 ? "Only tenant admins can manage customer verification." : "Could not load verification settings.");
        onChange?.(null);
      }
    }).catch(() => !cancelled && setLoadError("Could not load verification settings."));
    return () => { cancelled = true; };
  }, [apply, onChange]);

  const dirty = !!view && (
    enabled !== view.policy.enabled ||
    method !== view.policy.method ||
    (dobFieldPath || null) !== view.policy.dobFieldPath ||
    (dobFormat || null) !== view.policy.dobFormat
  );

  async function save() {
    setFieldError(null);
    setSaving(true);
    try {
      const { ok, data } = await request("PUT", {
        enabled,
        method,
        dobFieldPath: dobFieldPath.trim() || null,
        dobFormat: dobFormat || null,
      });
      if (!ok) {
        setFieldError({ field: data.field, message: data.error || "Could not save verification settings." });
        toast({ title: "Settings not saved", description: data.error, variant: "destructive" });
        return;
      }
      apply(data as VerificationPolicyView);
      toast({
        title: "Verification settings saved",
        description: data.changed ? "Existing verified widget chats were signed out." : "No changes.",
      });
    } catch {
      toast({ title: "Settings not saved", description: "Network error.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const selected = view?.methods.find(m => m.id === method);

  return (
    <Card className="glass-panel border-white/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary" /> Customer Verification
        </CardTitle>
        <CardDescription>
          Choose how widget visitors prove they own an account before the agent can see their CRM customer or order details.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
            <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
            <p className="text-xs text-red-300">{loadError}</p>
          </div>
        )}
        {!view && !loadError && <div className="animate-pulse h-24 bg-white/5 rounded-xl" />}
        {view && (
          <>
            <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl p-4">
              <div className="space-y-1">
                <p className="font-medium text-foreground">Customer-specific order access</p>
                <p className="text-sm text-muted-foreground">
                  {enabled
                    ? "Verified visitors can ask about their own orders."
                    : "Off — the widget answers general questions only and never uses CRM customer data."}
                </p>
              </div>
              <button
                onClick={() => setEnabled(v => !v)}
                disabled={saving}
                aria-pressed={enabled}
                aria-label="Toggle customer-specific order access"
                className="shrink-0 disabled:opacity-50 hover:opacity-80 transition-opacity"
              >
                {enabled
                  ? <ToggleRight className="w-12 h-12 text-primary" />
                  : <ToggleLeft className="w-12 h-12 text-muted-foreground" />}
              </button>
            </div>

            <fieldset className="space-y-2" disabled={saving}>
              <legend className="text-sm font-medium mb-2">Verification method</legend>
              {view.methods.map(m => (
                <label
                  key={m.id}
                  className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${
                    method === m.id ? "border-primary/50 bg-primary/5" : "border-white/10 bg-white/[0.02]"
                  } ${m.supported ? "cursor-pointer" : "opacity-60 cursor-not-allowed"}`}
                >
                  <input
                    type="radio"
                    name="verification-method"
                    value={m.id}
                    checked={method === m.id}
                    disabled={!m.supported && method !== m.id}
                    onChange={() => setMethod(m.id)}
                    className="mt-1 accent-[hsl(var(--primary))]"
                  />
                  <div className="space-y-1 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-foreground">{m.label}</span>
                      <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${ASSURANCE_STYLE[m.assurance]}`}>
                        {m.assurance} assurance
                      </span>
                    </div>
                    {!m.supported && m.unsupportedReason && (
                      <p className="text-xs text-muted-foreground">{m.unsupportedReason}</p>
                    )}
                  </div>
                </label>
              ))}
            </fieldset>

            {method === "date_of_birth" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="dob-field" className="text-sm font-medium">CRM date-of-birth field</label>
                  <input
                    id="dob-field"
                    value={dobFieldPath}
                    onChange={e => setDobFieldPath(e.target.value)}
                    placeholder="customer.dateOfBirth"
                    disabled={saving}
                    aria-invalid={fieldError?.field === "dobFieldPath"}
                    className="w-full h-10 rounded-md border border-white/10 bg-background/50 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  <p className="text-xs text-muted-foreground">Path in your CRM lookup response, as used in External CRM response mapping.</p>
                </div>
                <div className="space-y-1">
                  <label htmlFor="dob-format" className="text-sm font-medium">Format your CRM returns</label>
                  <select
                    id="dob-format"
                    value={dobFormat}
                    onChange={e => setDobFormat(e.target.value)}
                    disabled={saving}
                    aria-invalid={fieldError?.field === "dobFormat"}
                    className="w-full h-10 rounded-md border border-white/10 bg-background/50 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    <option value="">Select format…</option>
                    {view.dobFormats.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <p className="text-xs text-muted-foreground">Values in any other format fail verification.</p>
                </div>
              </div>
            )}

            {fieldError && (
              <div role="alert" className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
                <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                <p className="text-xs text-red-300">{fieldError.message}</p>
              </div>
            )}

            <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
              <Info className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-300">
                Order digits and date of birth are knowledge checks, not proof of phone ownership. Anyone who knows them can pass.
                They give less assurance than a one-time code sent to the phone{selected?.assurance === "lower" ? ", and 4 digits is the weakest option" : ""}.
              </p>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-white/5 pt-4">
              <ActivePolicySummary view={view} />
              <Button onClick={save} disabled={saving || !dirty} className="shrink-0">
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Save
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ActivePolicySummary({ view }: { view: VerificationPolicyView }) {
  const label = view.methods.find(m => m.id === view.policy.method)?.label ?? view.policy.method;
  if (view.status === "disabled")
    return <p className="text-xs text-muted-foreground">Active policy: customer access off.</p>;
  if (view.status === "needs_attention")
    return (
      <div className="text-xs text-amber-300 space-y-0.5">
        <p className="flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Enabled but not enforced — customer access is blocked until resolved:</p>
        {view.reasons.map(r => <p key={r} className="opacity-80">{r}</p>)}
      </div>
    );
  return (
    <p className="text-xs text-green-300 flex items-center gap-1">
      <CheckCircle2 className="w-3 h-3" /> Active policy: {label} (version {view.policy.version})
    </p>
  );
}
