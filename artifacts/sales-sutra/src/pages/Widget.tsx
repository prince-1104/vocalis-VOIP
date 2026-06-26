import React, { useState, useEffect, useRef } from "react";
import { useAgentConfig, useUpdateAgentMutation } from "@/hooks/use-agent";
import { useCampaignsList } from "@/hooks/use-campaigns";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { getStoredToken } from "@/hooks/use-auth";
import {
  Globe, Copy, CheckCircle2, RefreshCw, ToggleLeft, ToggleRight,
  Code2, Megaphone, Activity, Info, ExternalLink, Zap,
  Send, MessageSquare, Bot, Loader2, Trash2, Phone, Database, Link2
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

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  language?: string;
  modelUsed?: string;
}

const QUICK_PROMPTS = [
  "Hi, what can you help me with?",
  "Tell me about your services",
  "How do I get started?",
];

function ChatTestPanel({
  apiKey,
  agentName,
  widgetExternalCrmEnabled,
  crmConnected,
  crmName,
}: {
  apiKey: string;
  agentName: string;
  widgetExternalCrmEnabled: boolean;
  crmConnected: boolean;
  crmName: string | null;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [crmStep, setCrmStep] = useState<"phone" | "order" | "verified" | "none">("none");
  const [crmPhone, setCrmPhone] = useState("");
  const [crmSessionToken, setCrmSessionToken] = useState("");
  const [crmPendingToken, setCrmPendingToken] = useState("");
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const crmAuthRequired = widgetExternalCrmEnabled && crmConnected;
  const chatUnlocked = !crmAuthRequired || crmStep === "verified" || !!crmPendingToken;

  useEffect(() => {
    if (!crmAuthRequired) {
      setCrmStep("none");
      return;
    }
    setCrmStep("phone");
    setCrmPhone("");
    setCrmSessionToken("");
    setCrmPendingToken("");
    setMessages([{
      id: "crm-welcome",
      role: "assistant",
      content: `Welcome! To help you with your order, please enter your registered phone number${crmName ? ` (${crmName})` : ""}.`,
      timestamp: new Date(),
    }]);
  }, [crmAuthRequired, crmName, apiKey]);

  const scrollToBottom = () => {
    const el = messagesContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const sendMessage = async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || sending || !apiKey) return;

    if (crmAuthRequired && !chatUnlocked && !crmPendingToken) {
      await handleCrmInput(msg);
      return;
    }

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: msg,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setSending(true);

    try {
      const history = messages.map(m => ({ role: m.role, content: m.content }));
      const body: Record<string, unknown> = { apiKey, message: msg, history };
      if (crmSessionToken) body.crmSessionToken = crmSessionToken;
      if (crmPendingToken) body.crmPendingToken = crmPendingToken;
      const res = await fetch(`${window.location.origin}/api/widget/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      if (data.crmSessionToken) {
        setCrmSessionToken(data.crmSessionToken);
        setCrmPendingToken("");
        setCrmStep("verified");
      } else if (data.crmClearSession) {
        setCrmSessionToken("");
        setCrmStep("order");
      }
      if (data.crmPendingToken) setCrmPendingToken(data.crmPendingToken);

      const botMsg: ChatMessage = {
        id: `bot-${Date.now()}`,
        role: "assistant",
        content: data.reply || "No response",
        timestamp: new Date(),
        language: data.language,
        modelUsed: data.modelUsed,
      };
      setMessages(prev => [...prev, botMsg]);
    } catch {
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: "assistant",
        content: "⚠️ Failed to get a response. Check that the widget is enabled and try again.",
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const handleCrmInput = async (msg: string) => {
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: msg,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setSending(true);

    try {
      if (crmStep === "phone") {
        setCrmPhone(msg);
        const res = await fetch(`${window.location.origin}/api/widget/crm/verify-phone`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey, phone: msg }),
        });
        const data = await res.json();
        setMessages(prev => [...prev, {
          id: `bot-${Date.now()}`,
          role: "assistant",
          content: data.message || "Could not verify phone number.",
          timestamp: new Date(),
        }]);
        if (res.ok && data.success) setCrmStep("order");
        return;
      }

      if (crmStep === "order") {
        const res = await fetch(`${window.location.origin}/api/widget/crm/verify-order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey, phone: crmPhone, orderId: msg }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          setCrmSessionToken(data.sessionToken || "");
          setCrmPendingToken("");
          setCrmStep("verified");
        }
        setMessages(prev => [...prev, {
          id: `bot-${Date.now()}`,
          role: "assistant",
          content: data.greeting || data.message || "Could not verify order.",
          timestamp: new Date(),
        }]);
      }
    } catch {
      setMessages(prev => [...prev, {
        id: `err-${Date.now()}`,
        role: "assistant",
        content: "Verification failed. Please try again.",
        timestamp: new Date(),
      }]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const clearChat = () => {
    setMessages([]);
    setCrmStep(crmAuthRequired ? "phone" : "none");
    setCrmPhone("");
    setCrmSessionToken("");
    setCrmPendingToken("");
    if (crmAuthRequired) {
      setMessages([{
        id: "crm-welcome-reset",
        role: "assistant",
        content: `Welcome! To help you with your order, please enter your registered phone number${crmName ? ` (${crmName})` : ""}.`,
        timestamp: new Date(),
      }]);
    }
    inputRef.current?.focus();
  };

  const formatTime = (d: Date) =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col rounded-2xl overflow-hidden border border-white/[0.08] bg-[#0c0a14]" style={{ height: "480px" }}>
      <div className="px-4 py-3 bg-gradient-to-r from-violet-600 to-indigo-600 flex items-center gap-3 shrink-0">
        <div className="relative">
          <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center">
            <Bot className="w-5 h-5 text-white" />
          </div>
          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-green-400 border-2 border-violet-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{agentName}</p>
          <p className="text-[11px] text-white/60">Online • Test Mode</p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="text-white/50 hover:text-white/90 transition-colors p-1.5 rounded-lg hover:bg-white/10"
            title="Clear chat"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-4" style={{ minHeight: 0 }}>
        {messages.length === 0 && !crmAuthRequired && (
          <div className="flex flex-col items-center justify-center h-full gap-5">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-violet-500/30 to-indigo-500/30 flex items-center justify-center">
                <MessageSquare className="w-7 h-7 text-violet-300" />
              </div>
              <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-gradient-to-br from-green-400 to-emerald-500 flex items-center justify-center">
                <CheckCircle2 className="w-3 h-3 text-white" />
              </div>
            </div>
            <div className="text-center space-y-1.5">
              <p className="text-sm font-medium text-foreground">Chat with {agentName}</p>
              <p className="text-xs text-muted-foreground max-w-[240px]">
                Test how your widget responds to visitors. Try one of these:
              </p>
            </div>
            <div className="flex flex-col gap-2 w-full max-w-[280px]">
              {QUICK_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(prompt)}
                  className="text-left text-xs px-3 py-2.5 rounded-xl border border-violet-500/20 bg-violet-500/[0.06] hover:bg-violet-500/[0.12] hover:border-violet-500/30 text-foreground/80 hover:text-foreground transition-all duration-200 group"
                >
                  <span className="text-violet-400 mr-1.5 group-hover:mr-2 transition-all">→</span>
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" && (
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-violet-500 to-indigo-500 flex items-center justify-center shrink-0 mt-0.5">
                <Bot className="w-3.5 h-3.5 text-white" />
              </div>
            )}
            <div className="space-y-1 max-w-[75%]">
              <div className={`rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                msg.role === "user"
                  ? "bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-tr-md"
                  : "bg-white/[0.06] border border-white/[0.08] text-foreground/90 rounded-tl-md"
              }`}>
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
              </div>
              <div className={`flex items-center gap-1.5 px-1 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <span className="text-[10px] text-muted-foreground/40">{formatTime(msg.timestamp)}</span>
                {msg.role === "assistant" && msg.modelUsed && (
                  <span className="text-[10px] text-violet-400/50">• {msg.modelUsed}</span>
                )}
                {msg.role === "assistant" && msg.language && (
                  <span className="text-[10px] text-violet-400/50">• {msg.language}</span>
                )}
              </div>
            </div>
          </div>
        ))}

        {sending && (
          <div className="flex gap-2 justify-start">
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-violet-500 to-indigo-500 flex items-center justify-center shrink-0 mt-0.5">
              <Bot className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="bg-white/[0.06] border border-white/[0.08] rounded-2xl rounded-tl-md px-4 py-3">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-violet-400/70 animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-2 h-2 rounded-full bg-violet-400/70 animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-2 h-2 rounded-full bg-violet-400/70 animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

      </div>

      <div className="shrink-0 border-t border-white/[0.06] px-3 py-2.5 flex items-center gap-2 bg-[#0e0c17]">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder={
            crmStep === "phone"
              ? "Enter your registered phone number…"
              : crmStep === "order" || crmPendingToken
                ? "Enter your order ID…"
                : "Type a message…"
          }
          disabled={sending}
          className="flex-1 bg-white/[0.05] border border-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 focus:ring-violet-500/40 focus:border-violet-500/30 transition-all disabled:opacity-50"
        />
        <button
          onClick={() => sendMessage()}
          disabled={sending || !input.trim()}
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-lg shadow-violet-500/20"
        >
          {sending ? <Loader2 className="w-4 h-4 text-white animate-spin" /> : <Send className="w-4 h-4 text-white" />}
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
  const [crmConfig, setCrmConfig] = useState<{ name: string; isEnabled: boolean } | null>(null);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) return;
    fetch(`${window.location.origin}/api/external-crm/config`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => setCrmConfig(data.config ?? null))
      .catch(() => setCrmConfig(null));
  }, []);

  const agentAny = agent as any;
  const widgetApiKey: string = agentAny?.widgetApiKey || "";
  const widgetEnabled: boolean = agentAny?.widgetEnabled ?? false;
  const widgetCampaignId: number | null = agentAny?.widgetCampaignId ?? null;
  const widgetVoiceEnabled: boolean = agentAny?.widgetVoiceEnabled ?? false;
  const widgetExternalCrmEnabled: boolean = agentAny?.widgetExternalCrmEnabled ?? false;
  const twilioTwimlAppSid: string | null = agentAny?.twilioTwimlAppSid ?? null;
  const hasTwilioCreds = !!(agentAny?.twilioAccountSid && agentAny?.twilioAuthToken);
  const crmConnected = !!(crmConfig?.isEnabled && crmConfig?.name);

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

  async function toggleVoice() {
    if (!widgetVoiceEnabled && !hasTwilioCreds) {
      toast({
        title: "Twilio credentials required",
        description: "Configure your Twilio Account SID and Auth Token in Agent Settings first.",
        variant: "destructive",
      });
      return;
    }
    try {
      await updateAgent.mutateAsync({ widgetVoiceEnabled: !widgetVoiceEnabled } as any);
      toast({ title: `Voice calling ${!widgetVoiceEnabled ? "enabled" : "disabled"}` });
    } catch {
      toast({ title: "Failed to update voice calling", variant: "destructive" });
    }
  }

  async function toggleWidgetCrm() {
    if (!crmConnected && !widgetExternalCrmEnabled) {
      toast({
        title: "External CRM not configured",
        description: "Set up your CRM connection in External CRM settings first.",
        variant: "destructive",
      });
      return;
    }
    try {
      await updateAgent.mutateAsync({ widgetExternalCrmEnabled: !widgetExternalCrmEnabled } as any);
      toast({ title: `Widget CRM integration ${!widgetExternalCrmEnabled ? "enabled" : "disabled"}` });
    } catch {
      toast({ title: "Failed to update CRM integration", variant: "destructive" });
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
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-display font-bold">Web Widget</h1>
        <p className="text-muted-foreground mt-1">
          Embed a chat-based voice widget on your website or app. Interactions are tracked in your dashboard and billed like regular calls.
        </p>
      </div>

      {widgetEnabled ? (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div className="lg:col-span-3 space-y-6">
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
                    <p className="font-medium text-foreground">Widget is live</p>
                    <p className="text-sm text-muted-foreground">Your AI agent is accepting web widget conversations.</p>
                  </div>
                  <button onClick={toggleWidget} disabled={updateAgent.isPending} className="shrink-0 disabled:opacity-50 hover:opacity-80 transition-opacity">
                    <ToggleRight className="w-12 h-12 text-primary" />
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-lg p-2.5">
                  <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse shrink-0" />
                  <p className="text-xs text-green-300">Active — visitors can start conversations from your website.</p>
                </div>
              </CardContent>
            </Card>

            <Card className="glass-panel border-white/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Phone className="w-5 h-5 text-primary" /> Voice Calling
                </CardTitle>
                <CardDescription>Allow visitors to call your AI agent directly from the widget using their browser's microphone.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl p-4">
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">{widgetVoiceEnabled ? "Voice calls enabled" : "Voice calls disabled"}</p>
                    <p className="text-sm text-muted-foreground">Browser-based calling via Twilio Client SDK (WebRTC).</p>
                  </div>
                  <button onClick={toggleVoice} disabled={updateAgent.isPending} className="shrink-0 disabled:opacity-50 hover:opacity-80 transition-opacity">
                    {widgetVoiceEnabled
                      ? <ToggleRight className="w-12 h-12 text-primary" />
                      : <ToggleLeft className="w-12 h-12 text-muted-foreground" />}
                  </button>
                </div>
                {widgetVoiceEnabled && (
                  <div className="flex items-start gap-2 bg-green-500/10 border border-green-500/20 rounded-lg p-2.5">
                    <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
                    <div className="text-xs text-green-300 space-y-1">
                      <p>Voice calling is active. A 📞 button appears in the widget header.</p>
                      {twilioTwimlAppSid && <p className="opacity-60">TwiML App: {twilioTwimlAppSid}</p>}
                    </div>
                  </div>
                )}
                {!hasTwilioCreds && !widgetVoiceEnabled && (
                  <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
                    <Info className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-300">Requires Twilio credentials. Configure them in Agent Settings → Telephony.</p>
                  </div>
                )}
                <div className="flex items-start gap-2 bg-white/5 border border-white/10 rounded-lg p-2.5">
                  <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                  <p className="text-xs text-muted-foreground">Voice calls cost ~$0.004/min (Twilio Client) + LLM + TTS. Cheaper than inbound phone calls.</p>
                </div>
              </CardContent>
            </Card>

            <Card className="glass-panel border-white/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="w-5 h-5 text-primary" /> External CRM
                </CardTitle>
                <CardDescription>
                  Require customers to verify their phone number and order ID before chatting. Uses the same CRM data as voice calls.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl p-4">
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">
                      {widgetExternalCrmEnabled && crmConnected ? "CRM verification enabled" : "CRM verification disabled"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {crmConnected
                        ? `Connected to ${crmConfig?.name}. Visitors verify phone + order ID before chat.`
                        : "No external CRM configured yet."}
                    </p>
                  </div>
                  <button
                    onClick={toggleWidgetCrm}
                    disabled={updateAgent.isPending || !crmConnected}
                    className="shrink-0 disabled:opacity-50 hover:opacity-80 transition-opacity"
                  >
                    {widgetExternalCrmEnabled && crmConnected
                      ? <ToggleRight className="w-12 h-12 text-primary" />
                      : <ToggleLeft className="w-12 h-12 text-muted-foreground" />}
                  </button>
                </div>
                {widgetExternalCrmEnabled && crmConnected && (
                  <div className="flex items-start gap-2 bg-green-500/10 border border-green-500/20 rounded-lg p-2.5">
                    <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-green-300">
                      Widget will ask for phone number, verify orders from CRM, then greet with personalized order context.
                    </p>
                  </div>
                )}
                {!crmConnected && (
                  <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
                    <Info className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-300 flex items-center gap-1">
                      Configure your CRM in <a href="/external-crm" className="text-primary hover:underline inline-flex items-center gap-0.5"><Link2 className="w-3 h-3" /> External CRM</a> first.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="glass-panel border-white/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Megaphone className="w-5 h-5 text-primary" /> Campaign Assignment
                </CardTitle>
                <CardDescription>Route widget conversations to a campaign for unified tracking.</CardDescription>
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
                      <option value="">— No campaign (standalone) —</option>
                      {campaigns.map((c: any) => (
                        <option key={c.id} value={String(c.id)}>{c.name}</option>
                      ))}
                    </select>
                    <Button onClick={saveCampaign} disabled={updateAgent.isPending} variant="outline" className="border-white/10 shrink-0">Save</Button>
                  </div>
                </div>
                {widgetCampaignId && (
                  <div className="flex items-start gap-2 bg-primary/10 border border-primary/20 rounded-lg p-3">
                    <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <p className="text-sm text-primary/80">Widget conversations will appear in the selected campaign's analytics.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-2">
            <div className="lg:sticky lg:top-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <Zap className="w-3 h-3 text-amber-400" /> Live Preview
              </p>
              <ChatTestPanel
                apiKey={widgetApiKey}
                agentName={agentAny?.agentName || "Agent"}
                widgetExternalCrmEnabled={widgetExternalCrmEnabled}
                crmConnected={crmConnected}
                crmName={crmConfig?.name ?? null}
              />
            </div>
          </div>
        </div>
      ) : (
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
                <p className="font-medium text-foreground">Widget is disabled</p>
                <p className="text-sm text-muted-foreground">Toggle on to let visitors chat with your AI agent on your website.</p>
              </div>
              <button onClick={toggleWidget} disabled={updateAgent.isPending} className="shrink-0 disabled:opacity-50 hover:opacity-80 transition-opacity">
                <ToggleLeft className="w-12 h-12 text-muted-foreground" />
              </button>
            </div>
          </CardContent>
        </Card>
      )}




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
