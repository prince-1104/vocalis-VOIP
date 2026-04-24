import React, { useState, useEffect } from "react";
import { useAgentConfig, useUpdateAgentMutation } from "@/hooks/use-agent";
import { useCampaignsList } from "@/hooks/use-campaigns";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { getStoredToken } from "@/hooks/use-auth";
import {
  Globe, Copy, CheckCircle2, RefreshCw, ToggleLeft, ToggleRight,
  Code2, Megaphone, Activity, Info, ExternalLink, Zap
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetAgentQueryKey } from "@workspace/api-client-react";

function CopyBox({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="space-y-1.5">
      {label && <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>}
      <div className="flex items-start gap-2 bg-background/50 border border-white/10 rounded-md px-3 py-2">
        <code className="text-xs text-primary flex-1 whitespace-pre-wrap break-all leading-relaxed">{value}</code>
        <button onClick={copy} className="shrink-0 mt-0.5 hover:text-primary transition-colors">
          {copied
            ? <CheckCircle2 className="w-4 h-4 text-green-400" />
            : <Copy className="w-4 h-4 text-muted-foreground" />}
        </button>
      </div>
    </div>
  );
}

export default function WidgetSettings() {
  const { data: agent, isLoading } = useAgentConfig();
  const { data: campaignsData } = useCampaignsList();
  const updateAgent = useUpdateAgentMutation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const agentAny = agent as any;
  const widgetApiKey: string = agentAny?.widgetApiKey || "";
  const widgetEnabled: boolean = agentAny?.widgetEnabled ?? false;
  const widgetCampaignId: number | null = agentAny?.widgetCampaignId ?? null;

  const [campaignId, setCampaignId] = useState<string>("");
  const [generatingKey, setGeneratingKey] = useState(false);

  useEffect(() => {
    setCampaignId(widgetCampaignId ? String(widgetCampaignId) : "");
  }, [widgetCampaignId]);

  const campaigns = (campaignsData as any)?.campaigns ?? (Array.isArray(campaignsData) ? campaignsData : []);

  const apiBase = window.location.origin;
  const loaderScript = `<script src="${apiBase}/api/widget/loader.js?key=${widgetApiKey}" defer></script>`;

  async function toggleWidget() {
    try {
      await updateAgent.mutateAsync({ widgetEnabled: !widgetEnabled } as any);
      toast({ title: `Widget ${!widgetEnabled ? "enabled" : "disabled"}` });
    } catch {
      toast({ title: "Failed to update widget status", variant: "destructive" });
    }
  }

  async function saveCampaign() {
    try {
      await updateAgent.mutateAsync({
        widgetCampaignId: campaignId ? Number(campaignId) : null
      } as any);
      toast({ title: "Campaign assignment saved" });
    } catch {
      toast({ title: "Failed to save campaign assignment", variant: "destructive" });
    }
  }

  async function regenerateKey() {
    if (!confirm("This will invalidate your current embed code. Any existing widget installations will stop working until you update their script tag. Continue?")) return;
    setGeneratingKey(true);
    try {
      const token = getStoredToken();
      const res = await fetch(`${apiBase}/api/widget/generate-key`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(await res.text());
      await res.json();
      queryClient.invalidateQueries({ queryKey: getGetAgentQueryKey() });
      toast({ title: "Widget API key regenerated", description: "Update your embed code on all sites." });
    } catch (err: any) {
      toast({ title: "Failed to regenerate key", description: err.message, variant: "destructive" });
    } finally {
      setGeneratingKey(false);
    }
  }

  if (isLoading) return <div className="animate-pulse h-96 bg-white/5 rounded-xl" />;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-display font-bold">Web Widget</h1>
        <p className="text-muted-foreground mt-1">
          Embed a chat-based voice widget on your website or app. Interactions are tracked in your dashboard and billed like regular calls.
        </p>
      </div>

      <Card className="glass-panel border-white/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-primary" /> Widget Status
          </CardTitle>
          <CardDescription>Enable or disable the chat widget. When disabled, the embed script shows nothing.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl p-4">
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                {widgetEnabled ? "Widget is live" : "Widget is disabled"}
              </p>
              <p className="text-sm text-muted-foreground">
                {widgetEnabled
                  ? "Your AI agent is accepting web widget conversations."
                  : "Toggle on to let visitors chat with your AI agent on your website."}
              </p>
            </div>
            <button
              onClick={toggleWidget}
              disabled={updateAgent.isPending}
              className="shrink-0 disabled:opacity-50 hover:opacity-80 transition-opacity"
            >
              {widgetEnabled
                ? <ToggleRight className="w-12 h-12 text-primary" />
                : <ToggleLeft className="w-12 h-12 text-muted-foreground" />}
            </button>
          </div>

          {widgetEnabled && (
            <div className="mt-4 flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-lg p-3">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse shrink-0" />
              <p className="text-sm text-green-300">Widget is active — visitors can start conversations from your website.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass-panel border-white/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-primary" /> Campaign Assignment
          </CardTitle>
          <CardDescription>
            Route widget conversations to a campaign. This lets you track widget interactions alongside telephony activity in the same funnel.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Link to Campaign (optional)</label>
            <div className="flex gap-3">
              <select
                value={campaignId}
                onChange={e => setCampaignId(e.target.value)}
                className="flex-1 h-10 rounded-md border border-white/10 bg-background/50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">— No campaign (standalone widget) —</option>
                {campaigns.map((c: any) => (
                  <option key={c.id} value={String(c.id)}>{c.name}</option>
                ))}
              </select>
              <Button onClick={saveCampaign} disabled={updateAgent.isPending} variant="outline" className="border-white/10 shrink-0">
                Save
              </Button>
            </div>
          </div>
          {widgetCampaignId && (
            <div className="flex items-start gap-2 bg-primary/10 border border-primary/20 rounded-lg p-3">
              <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <p className="text-sm text-primary/80">
                Widget conversations will appear in the selected campaign's analytics alongside telephony calls, giving you a unified view of all interactions.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass-panel border-white/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Code2 className="w-5 h-5 text-primary" /> Embed Code
          </CardTitle>
          <CardDescription>
            Paste this single script tag into the <code className="text-xs bg-white/10 px-1 rounded">&lt;body&gt;</code> of your website — just before the closing tag. No other dependencies required.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <CopyBox label="Your widget API key" value={widgetApiKey || "— Not yet generated —"} />
          <CopyBox label="Script tag (paste into your HTML)" value={loaderScript} />

          <div className="bg-background/30 border border-white/5 rounded-xl p-4 space-y-3">
            <p className="text-sm font-medium text-foreground/80 flex items-center gap-2"><Zap className="w-4 h-4 text-amber-400" /> What the widget does</p>
            <ul className="text-sm text-muted-foreground space-y-1.5 list-none">
              <li className="flex items-start gap-2"><span className="text-primary mt-0.5">→</span> Adds a floating chat bubble (bottom-right) to your page</li>
              <li className="flex items-start gap-2"><span className="text-primary mt-0.5">→</span> Uses your agent's greeting, personality and knowledge base</li>
              <li className="flex items-start gap-2"><span className="text-primary mt-0.5">→</span> Conversations logged in Call Logs as "Widget" interactions</li>
              <li className="flex items-start gap-2"><span className="text-primary mt-0.5">→</span> Billed at the same per-session rate as telephony calls</li>
            </ul>
          </div>

          <div className="flex items-center justify-between pt-2">
            <p className="text-xs text-muted-foreground">
              Regenerating creates a new key — update all sites after regeneration.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={regenerateKey}
              disabled={generatingKey}
              className="border-white/10 gap-2"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${generatingKey ? "animate-spin" : ""}`} />
              {generatingKey ? "Regenerating…" : "Regenerate Key"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="glass-panel border-white/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" /> Billing &amp; Usage
          </CardTitle>
          <CardDescription>Widget interactions are metered and appear in your billing dashboard.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Channel</p>
              <p className="font-semibold text-foreground">Web Widget</p>
              <p className="text-xs text-muted-foreground mt-1">Chat-based voice AI</p>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Tracking</p>
              <p className="font-semibold text-foreground">Per session</p>
              <p className="text-xs text-muted-foreground mt-1">Logged in Call Logs</p>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Invoice</p>
              <p className="font-semibold text-foreground">Monthly</p>
              <p className="text-xs text-muted-foreground mt-1">Line-item on invoices</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1.5 pt-1">
            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
            View all widget sessions in <a href="/calls" className="text-primary hover:underline">Call Logs</a> filtered by direction = "Widget".
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
