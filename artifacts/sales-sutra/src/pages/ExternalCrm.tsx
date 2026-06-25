import React, { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { adminFetch } from "@/lib/admin-fetch";
import {
  Database,
  Save,
  TestTube2,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Link2,
  Shield,
  Settings2,
  Zap,
  Phone,
  Clock,
  MessageSquare,
} from "lucide-react";

interface CrmConfig {
  id: number;
  name: string;
  isEnabled: boolean;
  lookupUrl: string;
  httpMethod: string;
  authType: string;
  authValue: string | null;
  authHeaderName: string | null;
  phoneParamName: string;
  phoneParamLocation: string;
  responseMapping: {
    customerName?: string;
    email?: string;
    accountId?: string;
    recentOrders?: string;
    customFields?: string[];
  } | null;
  useRawResponse: boolean;
  maxContextChars: number;
  timeoutMs: number;
  cacheTtlSeconds: number;
  openingPitch?: string | null;
  endingPitch?: string | null;
  unknownCallerPitch?: string | null;
  endingNote?: string | null;
  maxAiInteractionSeconds?: number;
  endingNoteLeadSeconds?: number;
  callInstructions?: string | null;
  verifyIdentity?: boolean;
}

const AUTH_TYPES = [
  { value: "bearer", label: "Bearer Token" },
  { value: "api_key", label: "API Key (X-API-Key)" },
  { value: "basic", label: "Basic Auth" },
  { value: "header", label: "Custom Header" },
];

const PARAM_LOCATIONS = [
  { value: "query", label: "Query Parameter (?phone=xxx)" },
  { value: "body", label: "JSON Body" },
  { value: "path", label: "URL Path ({phone})" },
];

export default function ExternalCrm() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [hasConfig, setHasConfig] = useState(false);

  const [name, setName] = useState("My CRM");
  const [isEnabled, setIsEnabled] = useState(true);
  const [lookupUrl, setLookupUrl] = useState("");
  const [httpMethod, setHttpMethod] = useState("GET");
  const [authType, setAuthType] = useState("bearer");
  const [authValue, setAuthValue] = useState("");
  const [authHeaderName, setAuthHeaderName] = useState("");
  const [phoneParamName, setPhoneParamName] = useState("phone");
  const [phoneParamLocation, setPhoneParamLocation] = useState("query");
  const [useRawResponse, setUseRawResponse] = useState(false);
  const [maxContextChars, setMaxContextChars] = useState(2000);
  const [timeoutMs, setTimeoutMs] = useState(3000);
  const [cacheTtlSeconds, setCacheTtlSeconds] = useState(300);

  const [customerNamePath, setCustomerNamePath] = useState("");
  const [emailPath, setEmailPath] = useState("");
  const [accountIdPath, setAccountIdPath] = useState("");
  const [recentOrdersPath, setRecentOrdersPath] = useState("");
  const [customFieldsStr, setCustomFieldsStr] = useState("");

  const [openingPitch, setOpeningPitch] = useState("");
  const [endingPitch, setEndingPitch] = useState("");
  const [unknownCallerPitch, setUnknownCallerPitch] = useState("");
  const [endingNote, setEndingNote] = useState("");
  const [maxAiInteractionMinutes, setMaxAiInteractionMinutes] = useState(0);
  const [endingNoteLeadSeconds, setEndingNoteLeadSeconds] = useState(2);
  const [callInstructions, setCallInstructions] = useState("");
  const [verifyIdentity, setVerifyIdentity] = useState(false);

  const [testPhone, setTestPhone] = useState("");
  const [testResult, setTestResult] = useState<any>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const data = await adminFetch<{ config: CrmConfig | null }>("/api/external-crm/config");
      if (data.config) {
        const c = data.config;
        setHasConfig(true);
        setName(c.name);
        setIsEnabled(c.isEnabled);
        setLookupUrl(c.lookupUrl);
        setHttpMethod(c.httpMethod);
        setAuthType(c.authType);
        setAuthValue(c.authValue || "");
        setAuthHeaderName(c.authHeaderName || "");
        setPhoneParamName(c.phoneParamName);
        setPhoneParamLocation(c.phoneParamLocation);
        setUseRawResponse(c.useRawResponse);
        setMaxContextChars(c.maxContextChars);
        setTimeoutMs(c.timeoutMs);
        setCacheTtlSeconds(c.cacheTtlSeconds);
        if (c.responseMapping) {
          setCustomerNamePath(c.responseMapping.customerName || "");
          setEmailPath(c.responseMapping.email || "");
          setAccountIdPath(c.responseMapping.accountId || "");
          setRecentOrdersPath(c.responseMapping.recentOrders || "");
          setCustomFieldsStr((c.responseMapping.customFields || []).join(", "));
        }
        setOpeningPitch(c.openingPitch || "");
        setEndingPitch(c.endingPitch || "");
        setUnknownCallerPitch(c.unknownCallerPitch || "");
        setEndingNote(c.endingNote || "");
        setMaxAiInteractionMinutes(
          c.maxAiInteractionSeconds ? Math.round(c.maxAiInteractionSeconds / 60) : 0,
        );
        setEndingNoteLeadSeconds(c.endingNoteLeadSeconds ?? 2);
        setCallInstructions(c.callInstructions || "");
        setVerifyIdentity(c.verifyIdentity ?? false);
      }
    } catch (err: any) {
      toast({ title: "Failed to load CRM config", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!lookupUrl || !name) {
      toast({ title: "Missing fields", description: "Name and Lookup URL are required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const responseMapping: any = {};
      if (customerNamePath) responseMapping.customerName = customerNamePath;
      if (emailPath) responseMapping.email = emailPath;
      if (accountIdPath) responseMapping.accountId = accountIdPath;
      if (recentOrdersPath) responseMapping.recentOrders = recentOrdersPath;
      if (customFieldsStr.trim()) {
        responseMapping.customFields = customFieldsStr.split(",").map((s: string) => s.trim()).filter(Boolean);
      }

      await adminFetch("/api/external-crm/config", {
        method: "PUT",
        body: JSON.stringify({
          name,
          isEnabled,
          lookupUrl,
          httpMethod,
          authType,
          authValue: authValue || null,
          authHeaderName: authHeaderName || null,
          phoneParamName,
          phoneParamLocation,
          responseMapping: Object.keys(responseMapping).length > 0 ? responseMapping : null,
          useRawResponse,
          maxContextChars,
          timeoutMs,
          cacheTtlSeconds,
          openingPitch: openingPitch.trim() || null,
          endingPitch: endingPitch.trim() || null,
          unknownCallerPitch: unknownCallerPitch.trim() || null,
          endingNote: endingNote.trim() || null,
          maxAiInteractionSeconds: Math.max(0, maxAiInteractionMinutes) * 60,
          endingNoteLeadSeconds: Math.max(0, endingNoteLeadSeconds),
          callInstructions: callInstructions.trim() || null,
          verifyIdentity,
        }),
      });

      setHasConfig(true);
      toast({ title: "Saved", description: "External CRM configuration saved successfully" });
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Remove external CRM integration? AI calls will no longer fetch customer context.")) return;
    setDeleting(true);
    try {
      await adminFetch("/api/external-crm/config", { method: "DELETE" });
      setHasConfig(false);
      setName("My CRM");
      setLookupUrl("");
      setAuthValue("");
      setTestResult(null);
      toast({ title: "Deleted", description: "External CRM configuration removed" });
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  async function handleTest() {
    if (!testPhone) {
      toast({ title: "Enter a phone number", description: "Provide a phone number to test the CRM lookup", variant: "destructive" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await adminFetch<any>("/api/external-crm/test", {
        method: "POST",
        body: JSON.stringify({ phone: testPhone }),
      });
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Database className="w-6 h-6 text-primary" />
          External CRM Integration
        </h1>
        <p className="text-muted-foreground mt-1">
          Connect your CRM so Dialog can fetch customer details during calls. The AI will use this context to personalize conversations.
        </p>
      </div>

      {/* Connection Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Link2 className="w-5 h-5" />
            Connection Settings
          </CardTitle>
          <CardDescription>Configure how Dialog connects to your CRM's customer lookup API</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">CRM Name</label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Zoho CRM, Salesforce, etc." />
            </div>
            <div className="space-y-1.5 flex items-end gap-3">
              <label className="text-sm font-medium flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isEnabled}
                  onChange={e => setIsEnabled(e.target.checked)}
                  className="rounded border-white/20"
                />
                Enabled
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Lookup URL</label>
            <Input
              value={lookupUrl}
              onChange={e => setLookupUrl(e.target.value)}
              placeholder="https://your-crm.com/api/contacts/lookup"
            />
            <p className="text-xs text-muted-foreground">
              The API endpoint that accepts a phone number and returns customer data.
              {phoneParamLocation === "path" && " Use {phone} as a placeholder in the URL."}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">HTTP Method</label>
              <select
                value={httpMethod}
                onChange={e => setHttpMethod(e.target.value)}
                className="w-full rounded-md border border-white/10 bg-background px-3 py-2 text-sm"
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Phone Param Name</label>
              <Input value={phoneParamName} onChange={e => setPhoneParamName(e.target.value)} placeholder="phone" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Phone Location</label>
              <select
                value={phoneParamLocation}
                onChange={e => setPhoneParamLocation(e.target.value)}
                className="w-full rounded-md border border-white/10 bg-background px-3 py-2 text-sm"
              >
                {PARAM_LOCATIONS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Authentication */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Shield className="w-5 h-5" />
            Authentication
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Auth Type</label>
              <select
                value={authType}
                onChange={e => setAuthType(e.target.value)}
                className="w-full rounded-md border border-white/10 bg-background px-3 py-2 text-sm"
              >
                {AUTH_TYPES.map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </div>
            {authType === "header" && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Header Name</label>
                <Input value={authHeaderName} onChange={e => setAuthHeaderName(e.target.value)} placeholder="X-Auth-Token" />
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {authType === "bearer" ? "Bearer Token" : authType === "basic" ? "username:password" : authType === "api_key" ? "API Key" : "Token Value"}
            </label>
            <Input
              type="password"
              value={authValue}
              onChange={e => setAuthValue(e.target.value)}
              placeholder={authValue === "***configured***" ? "***configured*** (leave blank to keep)" : "Enter token or key"}
            />
          </div>
        </CardContent>
      </Card>

      {/* Call Flow & Cost Control */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Phone className="w-5 h-5" />
            Inbound Call Flow
          </CardTitle>
          <CardDescription>
            Control how the AI opens, closes, and times inbound calls using CRM data. Use {"{{customerName}}"} and other field placeholders in pitches.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Opening Pitch</label>
            <Textarea
              value={openingPitch}
              onChange={e => setOpeningPitch(e.target.value)}
              placeholder="Hi {{customerName}}, thank you for calling. I can see your recent order is ready to ship. How may I help you today?"
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              Spoken when the call connects. Overrides the default agent greeting when CRM is enabled.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Unknown Caller Opening</label>
            <Textarea
              value={unknownCallerPitch}
              onChange={e => setUnknownCallerPitch(e.target.value)}
              placeholder="Hi, thank you for calling. I couldn't find your account with this number — how can I assist you?"
              rows={2}
            />
            <p className="text-xs text-muted-foreground">
              Used when the CRM returns no match for the caller's phone number.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Ending Pitch</label>
            <Textarea
              value={endingPitch}
              onChange={e => setEndingPitch(e.target.value)}
              placeholder="Is there anything else I can help you with today? Have a wonderful day!"
              rows={2}
            />
            <p className="text-xs text-muted-foreground">
              Closing line the AI uses when wrapping up, and spoken before hangup when the time limit is reached.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                Max AI Interaction (minutes)
              </label>
              <Input
                type="number"
                min={0}
                value={maxAiInteractionMinutes}
                onChange={e => setMaxAiInteractionMinutes(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">0 = unlimited. Caps AI billing per inbound call.</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Pause Before Hangup (seconds)</label>
              <Input
                type="number"
                min={0}
                value={endingNoteLeadSeconds}
                onChange={e => setEndingNoteLeadSeconds(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Brief pause after the ending note (default: 2 sec).</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5" />
              Custom Ending Note
            </label>
            <Textarea
              value={endingNote}
              onChange={e => setEndingNote(e.target.value)}
              placeholder="Thank you for calling Rastafari Wellness. We appreciate your trust."
              rows={2}
            />
            <p className="text-xs text-muted-foreground">
              Played automatically when the time limit is reached, right before the call disconnects.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">AI Call Instructions</label>
            <Textarea
              value={callInstructions}
              onChange={e => setCallInstructions(e.target.value)}
              placeholder="Only discuss the customer's orders. For prescription questions, mention the doctor on file. Never quote prices unless the customer asks."
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              Extra rules for precise CRM-aware conversations (order focus, tone, topics to avoid).
            </p>
          </div>

          <label className="text-sm font-medium flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={verifyIdentity}
              onChange={e => setVerifyIdentity(e.target.checked)}
              className="rounded border-white/20"
            />
            Verify caller identity before sharing order or prescription details
          </label>
        </CardContent>
      </Card>

      {/* Response Mapping */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Settings2 className="w-5 h-5" />
            Response Mapping
          </CardTitle>
          <CardDescription>
            Map JSON paths from the CRM response to fields the AI can use. Use dot notation (e.g. "data.customer.name").
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="text-sm font-medium flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={useRawResponse}
              onChange={e => setUseRawResponse(e.target.checked)}
              className="rounded border-white/20"
            />
            Raw mode — pass the entire API response as context (skip field mapping)
          </label>

          {!useRawResponse && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Customer Name</label>
                  <Input value={customerNamePath} onChange={e => setCustomerNamePath(e.target.value)} placeholder="data.name" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Email</label>
                  <Input value={emailPath} onChange={e => setEmailPath(e.target.value)} placeholder="data.email" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Account ID</label>
                  <Input value={accountIdPath} onChange={e => setAccountIdPath(e.target.value)} placeholder="data.account_id" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Recent Orders</label>
                  <Input value={recentOrdersPath} onChange={e => setRecentOrdersPath(e.target.value)} placeholder="data.orders" />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Custom Fields (comma-separated JSON paths)</label>
                <Input
                  value={customFieldsStr}
                  onChange={e => setCustomFieldsStr(e.target.value)}
                  placeholder="data.address, data.plan, data.last_ticket"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-4 pt-2 border-t border-white/5">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Max Context (chars)</label>
              <Input type="number" value={maxContextChars} onChange={e => setMaxContextChars(Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Timeout (ms)</label>
              <Input type="number" value={timeoutMs} onChange={e => setTimeoutMs(Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Cache TTL (seconds)</label>
              <Input type="number" value={cacheTtlSeconds} onChange={e => setCacheTtlSeconds(Number(e.target.value))} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving} className="gap-2">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {hasConfig ? "Update Configuration" : "Save Configuration"}
        </Button>
        {hasConfig && (
          <Button variant="destructive" onClick={handleDelete} disabled={deleting} className="gap-2">
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Remove
          </Button>
        )}
      </div>

      {/* Test Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <TestTube2 className="w-5 h-5" />
            Test CRM Lookup
          </CardTitle>
          <CardDescription>Enter a phone number to test the connection and see what data the AI would receive</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3">
            <Input
              value={testPhone}
              onChange={e => setTestPhone(e.target.value)}
              placeholder="+919876543210"
              className="flex-1"
            />
            <Button onClick={handleTest} disabled={testing || !hasConfig} className="gap-2">
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              Test
            </Button>
          </div>

          {!hasConfig && (
            <p className="text-xs text-muted-foreground">Save a configuration first to test the lookup.</p>
          )}

          {testResult && (
            <div className={`rounded-lg border p-4 ${testResult.success ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}>
              <div className="flex items-center gap-2 mb-2">
                {testResult.success ? (
                  <CheckCircle2 className="w-4 h-4 text-green-400" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-400" />
                )}
                <span className="text-sm font-medium">{testResult.success ? "Success" : "Failed"}</span>
              </div>

              {testResult.error && (
                <p className="text-sm text-red-400">{testResult.error}</p>
              )}

              {testResult.context && (
                <div className="space-y-2 mt-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Mapped Context (what the AI sees)</p>
                  <pre className="text-xs bg-background/50 rounded p-3 overflow-auto max-h-48 border border-white/5">
                    {JSON.stringify(testResult.context, null, 2)}
                  </pre>
                </div>
              )}

              {testResult.rawResponse && (
                <div className="space-y-2 mt-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Raw CRM Response</p>
                  <pre className="text-xs bg-background/50 rounded p-3 overflow-auto max-h-48 border border-white/5">
                    {JSON.stringify(testResult.rawResponse, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
