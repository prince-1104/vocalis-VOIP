import React, { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { adminFetch, adminAuthHeaders } from "@/lib/admin-fetch";
import {
  Phone, PhoneOff, PhoneForwarded, Mic, MicOff, UserCheck,
  Clock, Send, AlertTriangle, CheckCircle2, XCircle,
  Loader2, Wifi, WifiOff, Bot, User, ArrowRight,
  Key, Copy, Eye, EyeOff, RefreshCw, Plus, Trash2,
  Volume2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

interface CallState {
  callId: number | null;
  callSid: string | null;
  phone: string;
  status: "idle" | "dialing" | "ringing" | "active" | "transferring" | "transferred" | "ended";
  startTime: number | null;
  liveTranscript: TranscriptEntry[];
  intent: string | null;
  transferredTo: string | null;
}

interface TranscriptEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface CrmAgent {
  id: number;
  crmAgentId: string;
  name: string;
  specialization: string | null;
  phone: string | null;
  intents: string[];
  isAvailable: boolean;
  currentCalls: number;
  maxConcurrentCalls: number;
}

interface ApiKey {
  id: number;
  keyPrefix: string;
  name: string;
  scopes: string[];
  webhookUrl: string | null;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════
// HELPER: Format duration
// ═══════════════════════════════════════════════════════════════════

function formatDuration(startTime: number | null): string {
  if (!startTime) return "00:00";
  const diff = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(diff / 60).toString().padStart(2, "0");
  const s = (diff % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ═══════════════════════════════════════════════════════════════════
// DIALER PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════════

const SESSION_KEY = "dialog_dialer_call_state";

function loadStoredCallState(): CallState {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CallState;
      // Don't restore a stale ended/idle state — start fresh
      if (parsed.status === "ended" || parsed.status === "idle") return getDefaultCallState();
      return parsed;
    }
  } catch { /* ignore */ }
  return getDefaultCallState();
}

function getDefaultCallState(): CallState {
  return {
    callId: null,
    callSid: null,
    phone: "",
    status: "idle",
    startTime: null,
    liveTranscript: [],
    intent: null,
    transferredTo: null,
  };
}

export default function Dialer() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Stores the cleanup fn for the live-transcript poll so we can stop it from anywhere
  const pollCleanupRef = useRef<(() => void) | null>(null);

  const [callState, setCallState] = useState<CallState>(loadStoredCallState);

  const [elapsed, setElapsed] = useState("00:00");
  const [wsConnected, setWsConnected] = useState(false);
  // Initialise dialInput from stored phone so the number shows when navigating back
  const [dialInput, setDialInput] = useState(() => {
    const stored = loadStoredCallState();
    return stored.phone || "";
  });
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [transferReason, setTransferReason] = useState("");

  // ── Persist call state to sessionStorage on every change ──
  useEffect(() => {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(callState));
    } catch { /* ignore quota errors */ }
  }, [callState]);

  // ── Timer for elapsed call duration ──
  useEffect(() => {
    if (callState.status === "active" && callState.startTime) {
      const interval = setInterval(() => setElapsed(formatDuration(callState.startTime)), 1000);
      return () => clearInterval(interval);
    }
    return undefined;
  }, [callState.status, callState.startTime]);

  // ── Auto-scroll transcript ──
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [callState.liveTranscript]);

  // ── Core polling function (returns cleanup fn) ──
  const startPolling = useCallback((callId: number) => {
    let active = true;
    const pollInterval = setInterval(async () => {
      if (!active) return;
      try {
        const res = await fetch(`${BASE}/api/calls/${callId}`, { headers: adminAuthHeaders() });
        if (!active) return; // component may have unmounted while awaiting
        if (res.ok) {
          const data = await res.json();
          if (data.liveTranscript && Array.isArray(data.liveTranscript)) {
            setCallState(prev => ({
              ...prev,
              liveTranscript: data.liveTranscript,
            }));
          }
          if (data.endedAt) {
            setCallState(prev => ({ ...prev, status: "ended" }));
            clearInterval(pollInterval);
            active = false;
          }
          if (data.transferredTo) {
            setCallState(prev => ({
              ...prev,
              transferredTo: data.transferredTo,
              status: prev.status === "active" ? "transferred" : prev.status,
            }));
          }
        }
      } catch { /* ignore */ }
    }, 2000);

    const cleanup = () => {
      active = false;
      clearInterval(pollInterval);
    };
    return cleanup;
  }, []);

  // ── Stop polling when component unmounts (e.g. navigating away briefly) ──
  // NOTE: we intentionally do NOT clear sessionStorage here — the state
  // is preserved so the user can navigate back and see the active call.
  useEffect(() => {
    return () => {
      pollCleanupRef.current?.();
    };
  }, []);

  // ── Re-attach polling if we remount with an active call ──
  useEffect(() => {
    const { callId, status } = callState;
    if (callId && (status === "active" || status === "dialing" || status === "transferring")) {
      const cleanup = startPolling(callId);
      pollCleanupRef.current = cleanup;
      return cleanup;
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run only on mount

  // ── WebSocket for live events (kept for future WS upgrade; currently uses polling) ──
  const connectWebSocket = useCallback((callId: number) => {
    // Stop any existing poll before starting a new one
    pollCleanupRef.current?.();
    const cleanup = startPolling(callId);
    pollCleanupRef.current = cleanup;
    setWsConnected(true);
    return cleanup;
  }, [startPolling]);

  // ── Fetch CRM agents ──
  const { data: agentsData } = useQuery<{ agents: CrmAgent[] }>({
    queryKey: ["crm-agents"],
    queryFn: () => adminFetch(`${BASE}/api/crm-agents`),
    retry: false,
  });

  // ── Fetch API keys ──
  const { data: apiKeysData, refetch: refetchKeys } = useQuery<{ apiKeys: ApiKey[] }>({
    queryKey: ["crm-api-keys"],
    queryFn: () => adminFetch(`${BASE}/api/crm-admin/api-keys`),
    retry: false,
  });

  // ── Fetch recent calls ──
  const { data: recentCalls } = useQuery<{ calls: any[] }>({
    queryKey: ["recent-calls-dialer"],
    queryFn: () => adminFetch(`${BASE}/api/calls?limit=10`),
    refetchInterval: callState.status === "idle" ? 10000 : false,
  });

  // ── Mutations ──

  const dialMutation = useMutation({
    mutationFn: async (phone: string) => {
      const res = await fetch(`${BASE}/api/dial/phone`, {
        method: "POST",
        headers: adminAuthHeaders(),
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to dial");
      }
      return res.json();
    },
    onSuccess: (data: any) => {
      setCallState(prev => ({
        ...prev,
        callId: data.callLogId,
        callSid: data.callSid,
        phone: dialInput,
        status: "dialing",
        startTime: Date.now(),
        liveTranscript: [],
        intent: null,
        transferredTo: null,
      }));

      // Start polling for live transcript after a brief connect delay
      setTimeout(() => {
        if (data.callLogId) {
          connectWebSocket(data.callLogId);
          setCallState(prev => ({ ...prev, status: "active" }));
        }
      }, 3000);

      toast({ title: "📞 Calling...", description: `Dialing ${dialInput}` });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to dial", description: err.message, variant: "destructive" });
    },
  });

  const endCallMutation = useMutation({
    mutationFn: async () => {
      if (!callState.callId) throw new Error("No active call");
      // Use the JWT-auth endpoint (dial.ts) — not the CRM API-key endpoint
      return adminFetch(`${BASE}/api/dial/calls/${callState.callId}/end`, { method: "POST" });
    },
    onSuccess: () => {
      // Stop polling immediately so it doesn't override the ended status
      pollCleanupRef.current?.();
      pollCleanupRef.current = null;
      setCallState(prev => ({ ...prev, status: "ended" }));
      toast({ title: "📵 Call ended" });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to end call",
        description: err.message || "Could not end the call. Please try again.",
        variant: "destructive",
      });
    },
  });

  const transferMutation = useMutation({
    mutationFn: async ({ agentId, reason }: { agentId: string; reason: string }) => {
      if (!callState.callId) throw new Error("No active call");
      return adminFetch(`${BASE}/api/crm/calls/${callState.callId}/transfer`, {
        method: "POST",
        body: JSON.stringify({
          crmAgentId: agentId,
          reason: reason || "Manual transfer from dialer",
          transferType: "cold",
        }),
      });
    },
    onSuccess: () => {
      setCallState(prev => ({ ...prev, status: "transferring" }));
      toast({ title: "🔄 Transferring...", description: "Connecting to agent" });
    },
  });

  const generateKeyMutation = useMutation({
    mutationFn: async (name: string) => {
      return adminFetch<any>(`${BASE}/api/crm-admin/api-keys`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    },
    onSuccess: (data: any) => {
      setNewApiKey(data.key);
      refetchKeys();
      toast({ title: "🔑 API Key Created", description: "Copy it now — it won't be shown again!" });
    },
  });

  const deleteKeyMutation = useMutation({
    mutationFn: async (keyId: number) =>
      adminFetch(`${BASE}/api/crm-admin/api-keys/${keyId}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirmDeleteId(null);
      refetchKeys();
      toast({ title: "🗑️ API Key deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // ── Handlers ──

  function handleDial() {
    if (!dialInput.trim()) return;
    dialMutation.mutate(dialInput.trim());
  }

  function handleEndCall() {
    endCallMutation.mutate();
  }

  function handleTransfer() {
    if (!selectedAgent) return;
    transferMutation.mutate({ agentId: selectedAgent, reason: transferReason });
  }

  function handleNewCall() {
    // Stop any lingering poll
    pollCleanupRef.current?.();
    pollCleanupRef.current = null;
    // Clear persisted state so next mount starts fresh
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    setCallState(getDefaultCallState());
    setDialInput("");
    setElapsed("00:00");
    queryClient.invalidateQueries({ queryKey: ["recent-calls-dialer"] });
  }

  const isCallActive = ["dialing", "ringing", "active", "transferring"].includes(callState.status);
  const agents = agentsData?.agents || [];
  const apiKeys = apiKeysData?.apiKeys || [];

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold">Dialer</h1>
        <p className="text-muted-foreground mt-1">Make calls, view live transcripts, and manage CRM integrations.</p>
      </div>

      <Tabs defaultValue="dialer" className="space-y-6">
        <TabsList className="bg-white/5 border border-white/10">
          <TabsTrigger value="dialer" className="data-[state=active]:bg-primary/20">
            <Phone className="w-4 h-4 mr-2" /> Dialer
          </TabsTrigger>
          <TabsTrigger value="agents" className="data-[state=active]:bg-primary/20">
            <UserCheck className="w-4 h-4 mr-2" /> CRM Agents
          </TabsTrigger>
          <TabsTrigger value="integration" className="data-[state=active]:bg-primary/20">
            <Key className="w-4 h-4 mr-2" /> API Integration
          </TabsTrigger>
        </TabsList>

        {/* ══════════════════════════════════════════════════════ */}
        {/* TAB 1: DIALER */}
        {/* ══════════════════════════════════════════════════════ */}
        <TabsContent value="dialer" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* ── Left: Dial Pad + Controls ── */}
            <div className="space-y-4">
              <Card className="glass-panel border-white/5">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Phone className="w-5 h-5 text-primary" />
                    {isCallActive ? "Active Call" : "New Call"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Phone input */}
                  <div className="relative">
                    <Input
                      id="dialer-phone-input"
                      placeholder="+91 98765 43210"
                      value={isCallActive ? (callState.phone || dialInput) : dialInput}
                      onChange={(e) => setDialInput(e.target.value)}
                      disabled={isCallActive}
                      className="text-lg font-mono h-14 bg-black/30 border-white/10 text-center tracking-wider"
                      onKeyDown={(e) => e.key === "Enter" && !isCallActive && handleDial()}
                    />
                  </div>

                  {/* Call Status */}
                  {isCallActive && (
                    <div className="text-center space-y-2">
                      <div className="flex items-center justify-center gap-2">
                        {callState.status === "dialing" && (
                          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 animate-pulse">
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Dialing...
                          </Badge>
                        )}
                        {callState.status === "active" && (
                          <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                            <Volume2 className="w-3 h-3 mr-1" /> Connected
                          </Badge>
                        )}
                        {callState.status === "transferring" && (
                          <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse">
                            <PhoneForwarded className="w-3 h-3 mr-1" /> Transferring...
                          </Badge>
                        )}
                        {callState.status === "transferred" && (
                          <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30">
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Transferred
                          </Badge>
                        )}
                      </div>
                      <p className="text-3xl font-mono font-bold text-foreground tracking-wider">{elapsed}</p>
                      {callState.intent && (
                        <Badge variant="outline" className="text-xs border-primary/30 text-primary">
                          Intent: {callState.intent}
                        </Badge>
                      )}
                    </div>
                  )}

                  {callState.status === "ended" && (
                    <div className="text-center space-y-2 py-4">
                      <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
                      <p className="text-sm text-muted-foreground">Call completed • {elapsed}</p>
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex gap-2">
                    {callState.status === "idle" && (
                      <Button
                        id="dial-button"
                        className="flex-1 h-14 text-lg bg-emerald-600 hover:bg-emerald-700 text-white"
                        onClick={handleDial}
                        disabled={!dialInput.trim() || dialMutation.isPending}
                      >
                        {dialMutation.isPending ? (
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                        ) : (
                          <Phone className="w-5 h-5 mr-2" />
                        )}
                        Dial
                      </Button>
                    )}

                    {isCallActive && (
                      <>
                        <Button
                          id="end-call-button"
                          className="flex-1 h-14 text-lg bg-red-600 hover:bg-red-700 text-white"
                          onClick={handleEndCall}
                          disabled={endCallMutation.isPending}
                        >
                          <PhoneOff className="w-5 h-5 mr-2" /> End
                        </Button>
                      </>
                    )}

                    {callState.status === "ended" && (
                      <Button
                        id="new-call-button"
                        className="flex-1 h-14 text-lg"
                        onClick={handleNewCall}
                      >
                        <Phone className="w-5 h-5 mr-2" /> New Call
                      </Button>
                    )}
                  </div>

                  {/* Transfer Panel */}
                  {callState.status === "active" && agents.length > 0 && (
                    <div className="pt-2 border-t border-white/5 space-y-3">
                      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Transfer to Agent</p>
                      <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                        <SelectTrigger className="bg-black/20 border-white/10">
                          <SelectValue placeholder="Select agent..." />
                        </SelectTrigger>
                        <SelectContent>
                          {agents.filter(a => a.isAvailable && a.phone).map(a => (
                            <SelectItem key={a.crmAgentId} value={a.crmAgentId}>
                              <div className="flex items-center gap-2">
                                <span>{a.name}</span>
                                {a.specialization && (
                                  <span className="text-xs text-muted-foreground">({a.specialization})</span>
                                )}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        placeholder="Transfer reason (optional)"
                        value={transferReason}
                        onChange={(e) => setTransferReason(e.target.value)}
                        className="bg-black/20 border-white/10 text-sm"
                      />
                      <Button
                        id="transfer-button"
                        variant="outline"
                        className="w-full border-blue-500/30 text-blue-400 hover:bg-blue-500/10"
                        onClick={handleTransfer}
                        disabled={!selectedAgent || transferMutation.isPending}
                      >
                        <PhoneForwarded className="w-4 h-4 mr-2" />
                        {transferMutation.isPending ? "Transferring..." : "Transfer"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Recent Calls */}
              {callState.status === "idle" && (
                <Card className="glass-panel border-white/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">Recent Calls</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    {recentCalls?.calls && recentCalls.calls.length > 0 ? (
                      <div className="divide-y divide-white/5">
                        {recentCalls.calls.slice(0, 5).map((call: any) => (
                          <div key={call.id} className="px-4 py-3 flex items-center justify-between hover:bg-white/5 transition-colors">
                            <div className="flex items-center gap-3">
                              <Phone className="w-4 h-4 text-muted-foreground" />
                              <div>
                                <p className="text-sm font-medium font-mono">{call.phone}</p>
                                <p className="text-xs text-muted-foreground">
                                  {call.duration ? `${call.duration}s` : "—"} • {call.outcome || "—"}
                                </p>
                              </div>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs hover:bg-white/10"
                              onClick={() => { setDialInput(call.phone); }}
                            >
                              Redial
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="p-4 text-sm text-muted-foreground text-center">No recent calls</p>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>

            {/* ── Right: Live Transcript ── */}
            <div className="lg:col-span-2">
              <Card className="glass-panel border-white/5 h-[calc(100vh-280px)] flex flex-col">
                <CardHeader className="pb-3 border-b border-white/5 shrink-0">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Mic className="w-5 h-5 text-emerald-400" />
                      Live Transcript
                    </CardTitle>
                    {isCallActive && (
                      <div className="flex items-center gap-2">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                        </span>
                        <span className="text-xs text-emerald-400">Live</span>
                      </div>
                    )}
                  </div>
                </CardHeader>

                <ScrollArea className="flex-1 p-4">
                  {callState.liveTranscript.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center py-20">
                      {isCallActive ? (
                        <>
                          <Loader2 className="w-10 h-10 text-muted-foreground animate-spin mb-4" />
                          <p className="text-muted-foreground">Waiting for conversation to begin...</p>
                        </>
                      ) : (
                        <>
                          <Mic className="w-12 h-12 text-muted-foreground/30 mb-4" />
                          <p className="text-muted-foreground">Dial a number to see the live transcript here.</p>
                          <p className="text-xs text-muted-foreground/60 mt-1">The AI conversation will appear in real-time.</p>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {callState.liveTranscript.map((entry, i) => (
                        <div
                          key={i}
                          className={`flex gap-3 ${entry.role === "assistant" ? "" : "flex-row-reverse"}`}
                        >
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                            entry.role === "assistant"
                              ? "bg-primary/20 border border-primary/30"
                              : "bg-emerald-500/20 border border-emerald-500/30"
                          }`}>
                            {entry.role === "assistant" ? (
                              <Bot className="w-4 h-4 text-primary" />
                            ) : (
                              <User className="w-4 h-4 text-emerald-400" />
                            )}
                          </div>
                          <div className={`max-w-[75%] ${entry.role === "assistant" ? "" : "text-right"}`}>
                            <div className={`inline-block rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                              entry.role === "assistant"
                                ? "bg-white/5 border border-white/10 text-foreground rounded-tl-sm"
                                : "bg-emerald-500/10 border border-emerald-500/20 text-foreground rounded-tr-sm"
                            }`}>
                              {entry.content}
                            </div>
                            <p className="text-[10px] text-muted-foreground/50 mt-1 px-1">
                              {entry.role === "assistant" ? "AI Agent" : "Caller"} • {
                                new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                              }
                            </p>
                          </div>
                        </div>
                      ))}
                      <div ref={transcriptEndRef} />
                    </div>
                  )}
                </ScrollArea>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* ══════════════════════════════════════════════════════ */}
        {/* TAB 2: CRM AGENTS */}
        {/* ══════════════════════════════════════════════════════ */}
        <TabsContent value="agents" className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold">CRM Agents</h2>
              <p className="text-sm text-muted-foreground">Agents registered for call transfers. AI detects intent and routes to the right specialist.</p>
            </div>
            <RegisterAgentDialog onSuccess={() => queryClient.invalidateQueries({ queryKey: ["crm-agents"] })} />
          </div>

          {agents.length === 0 ? (
            <Card className="glass-panel border-white/5 p-12 text-center">
              <UserCheck className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
              <p className="text-lg font-medium">No agents registered</p>
              <p className="text-muted-foreground mt-1">Register CRM agents to enable call transfers based on detected intent.</p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {agents.map(agent => (
                <Card key={agent.id} className="glass-panel border-white/5 hover:border-white/10 transition-colors">
                  <CardContent className="p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                          agent.isAvailable ? "bg-emerald-500/20 border border-emerald-500/30" : "bg-white/5 border border-white/10"
                        }`}>
                          <UserCheck className={`w-5 h-5 ${agent.isAvailable ? "text-emerald-400" : "text-muted-foreground"}`} />
                        </div>
                        <div>
                          <p className="font-medium">{agent.name}</p>
                          <p className="text-xs text-muted-foreground font-mono">{agent.crmAgentId}</p>
                        </div>
                      </div>
                      <Badge
                        variant="outline"
                        className={agent.isAvailable
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                          : "bg-white/5 text-muted-foreground border-white/10"
                        }
                      >
                        {agent.isAvailable ? "Available" : "Offline"}
                      </Badge>
                    </div>

                    {agent.specialization && (
                      <p className="text-sm text-muted-foreground">{agent.specialization}</p>
                    )}

                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Phone className="w-3 h-3" />
                      <span className="font-mono">{agent.phone || "No phone"}</span>
                    </div>

                    {agent.intents && agent.intents.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {agent.intents.map(intent => (
                          <Badge key={intent} variant="outline" className="text-[10px] border-primary/20 text-primary/80">
                            {intent}
                          </Badge>
                        ))}
                      </div>
                    )}

                    <div className="text-xs text-muted-foreground">
                      Active calls: {agent.currentCalls} / {agent.maxConcurrentCalls}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ══════════════════════════════════════════════════════ */}
        {/* TAB 3: API INTEGRATION */}
        {/* ══════════════════════════════════════════════════════ */}
        <TabsContent value="integration" className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold">External CRM Integration</h2>
            <p className="text-sm text-muted-foreground">
              Connect any external CRM (Salesforce, Zoho, HubSpot, or custom) to Dialog using API keys and webhooks.
            </p>
          </div>

          {/* API Keys */}
          <Card className="glass-panel border-white/5">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Key className="w-5 h-5 text-amber-400" /> API Keys
                </CardTitle>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button size="sm" className="bg-primary">
                      <Plus className="w-4 h-4 mr-1" /> Generate Key
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="glass-panel border-white/10">
                    <DialogHeader>
                      <DialogTitle>Generate CRM API Key</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 mt-4">
                      <Input
                        placeholder="Key name (e.g. Production CRM)"
                        value={newKeyName}
                        onChange={(e) => setNewKeyName(e.target.value)}
                        className="bg-black/20 border-white/10"
                      />
                      <Button
                        className="w-full bg-primary"
                        onClick={() => generateKeyMutation.mutate(newKeyName || "API Key")}
                        disabled={generateKeyMutation.isPending}
                      >
                        {generateKeyMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                        Generate
                      </Button>

                      {newApiKey && (
                        <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl space-y-2">
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-amber-400" />
                            <p className="text-sm font-medium text-amber-400">Save this key — it won't be shown again!</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 text-xs font-mono bg-black/40 px-3 py-2 rounded border border-white/10 break-all">
                              {showApiKey ? newApiKey : "dk_live_••••••••••••••••••••••••••••••••"}
                            </code>
                            <Button variant="ghost" size="icon" onClick={() => setShowApiKey(!showApiKey)}>
                              {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => {
                              navigator.clipboard.writeText(newApiKey);
                              toast({ title: "Copied!" });
                            }}>
                              <Copy className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {apiKeys.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No API keys yet. Generate one to connect your external CRM.
                </p>
              ) : (
                <div className="space-y-3">
                  {apiKeys.map(key => (
                    <div key={key.id} className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/5 hover:border-white/10 transition-colors group">
                      <div className="flex items-center gap-3">
                        <Key className="w-4 h-4 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium">{key.name}</p>
                          <p className="text-xs font-mono text-muted-foreground">{key.keyPrefix}••••••••</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={key.isActive ? "border-emerald-500/30 text-emerald-400" : "border-red-500/30 text-red-400"}>
                          {key.isActive ? "Active" : "Revoked"}
                        </Badge>
                        {key.lastUsedAt && (
                          <span className="text-xs text-muted-foreground">
                            Last used: {new Date(key.lastUsedAt).toLocaleDateString()}
                          </span>
                        )}
                        {/* Delete button with inline confirmation */}
                        {confirmDeleteId === key.id ? (
                          <div className="flex items-center gap-1.5 animate-in fade-in slide-in-from-right-2">
                            <span className="text-xs text-red-400 font-medium">Delete?</span>
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-7 px-2.5 text-xs"
                              onClick={() => deleteKeyMutation.mutate(key.id)}
                              disabled={deleteKeyMutation.isPending}
                            >
                              {deleteKeyMutation.isPending ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : "Yes, delete"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2.5 text-xs hover:bg-white/10"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/10 hover:text-red-400"
                            onClick={() => setConfirmDeleteId(key.id)}
                            title="Delete API key"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Integration Guide */}
          <Card className="glass-panel border-white/5">
            <CardHeader>
              <CardTitle className="text-lg">Quick Integration Guide</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <h4 className="font-medium flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center font-bold">1</span>
                  Initiate a Call from your CRM
                </h4>
                <pre className="p-4 bg-black/40 border border-white/10 rounded-xl text-xs font-mono text-emerald-300 overflow-x-auto whitespace-pre">
{`POST /api/crm/calls
Authorization: Bearer dk_live_your_key_here
Content-Type: application/json

{
  "phone": "+919876543210",
  "crmContactId": "your-crm-lead-id",
  "metadata": { "dealStage": "qualification" },
  "transferRules": {
    "intents": ["pricing_query", "complaint"],
    "maxAiTurns": 8
  }
}`}
                </pre>
              </div>

              <Separator className="bg-white/5" />

              <div className="space-y-3">
                <h4 className="font-medium flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center font-bold">2</span>
                  Receive Real-Time Events via Webhook
                </h4>
                <pre className="p-4 bg-black/40 border border-white/10 rounded-xl text-xs font-mono text-blue-300 overflow-x-auto whitespace-pre">
{`POST /api/crm/webhooks
Authorization: Bearer dk_live_your_key_here

{ "webhookUrl": "https://your-crm.com/hooks/dialog" }

// Your CRM will receive events like:
// call.turn   → each user/AI message
// call.intent → detected caller intent
// call.ended  → call completed with transcript`}
                </pre>
              </div>

              <Separator className="bg-white/5" />

              <div className="space-y-3">
                <h4 className="font-medium flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center font-bold">3</span>
                  Transfer Calls to CRM Agents
                </h4>
                <pre className="p-4 bg-black/40 border border-white/10 rounded-xl text-xs font-mono text-purple-300 overflow-x-auto whitespace-pre">
{`// Register an agent:
POST /api/crm/agents
{
  "crmAgentId": "agent-sales-1",
  "name": "Raj (Sales Closer)",
  "phone": "+919999888877",
  "intents": ["pricing_query", "interested"]
}

// Trigger a transfer mid-call:
POST /api/crm/calls/{callId}/transfer
{
  "crmAgentId": "agent-sales-1",
  "reason": "pricing negotiation"
}`}
                </pre>
              </div>

              <Separator className="bg-white/5" />

              <div className="p-4 bg-primary/5 border border-primary/20 rounded-xl">
                <h4 className="font-medium text-primary mb-2">Full API Reference</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono">
                  {[
                    ["POST", "/api/crm/calls", "Initiate call"],
                    ["GET", "/api/crm/calls/:id", "Get call + transcript"],
                    ["POST", "/api/crm/calls/:id/transfer", "Transfer call"],
                    ["POST", "/api/crm/calls/:id/end", "End call"],
                    ["GET", "/api/crm/agents", "List agents"],
                    ["POST", "/api/crm/agents", "Register agent"],
                    ["POST", "/api/crm/webhooks", "Set webhook URL"],
                    ["POST", "/api/crm/campaigns", "Create campaign"],
                  ].map(([method, path, desc]) => (
                    <div key={path} className="flex items-center gap-2 p-2 bg-black/20 rounded">
                      <Badge className={`text-[10px] ${method === "POST" ? "bg-emerald-500/20 text-emerald-400" : "bg-blue-500/20 text-blue-400"} border-0`}>
                        {method}
                      </Badge>
                      <span className="text-muted-foreground">{path}</span>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// REGISTER AGENT DIALOG
// ═══════════════════════════════════════════════════════════════════

function RegisterAgentDialog({ onSuccess }: { onSuccess: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    crmAgentId: "",
    name: "",
    phone: "",
    specialization: "",
    intents: "",
  });

  const mutation = useMutation({
    mutationFn: () => adminFetch(`${BASE}/api/crm/agents`, {
      method: "POST",
      body: JSON.stringify({
        ...form,
        intents: form.intents.split(",").map(s => s.trim()).filter(Boolean),
      }),
    }),
    onSuccess: () => {
      toast({ title: "Agent registered" });
      onSuccess();
      setOpen(false);
      setForm({ crmAgentId: "", name: "", phone: "", specialization: "", intents: "" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-primary">
          <Plus className="w-4 h-4 mr-2" /> Register Agent
        </Button>
      </DialogTrigger>
      <DialogContent className="glass-panel border-white/10">
        <DialogHeader>
          <DialogTitle>Register CRM Agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <Input placeholder="Agent ID (e.g. agent-sales-1)" value={form.crmAgentId}
            onChange={(e) => setForm(f => ({ ...f, crmAgentId: e.target.value }))}
            className="bg-black/20 border-white/10" />
          <Input placeholder="Name" value={form.name}
            onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
            className="bg-black/20 border-white/10" />
          <Input placeholder="Phone (+91...)" value={form.phone}
            onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))}
            className="bg-black/20 border-white/10" />
          <Input placeholder="Specialization (e.g. Sales Closer)" value={form.specialization}
            onChange={(e) => setForm(f => ({ ...f, specialization: e.target.value }))}
            className="bg-black/20 border-white/10" />
          <Input placeholder="Intents (comma-separated: pricing_query, complaint)" value={form.intents}
            onChange={(e) => setForm(f => ({ ...f, intents: e.target.value }))}
            className="bg-black/20 border-white/10" />
          <Button className="w-full bg-primary" onClick={() => mutation.mutate()} disabled={!form.crmAgentId || !form.name || mutation.isPending}>
            {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Register Agent
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
