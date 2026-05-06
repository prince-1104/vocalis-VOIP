import React, { useEffect, useState, useRef } from "react";
import { useAgentConfig, useUpdateAgentMutation } from "@/hooks/use-agent";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Bot, Phone, Settings2, AlertCircle, Copy, CheckCircle2, Webhook, Cpu, Lock, Ear, Brain, Volume2, Zap, ChevronDown, Play, Square, Languages, Sparkles } from "lucide-react";
import { useForm } from "react-hook-form";
import { useAuth } from "@/hooks/use-auth";
import { Switch } from "@/components/ui/switch";

const INDIAN_LANGUAGES = ["kn-IN", "hi-IN", "ta-IN", "te-IN", "mr-IN"];

const CURRENT_MODELS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gemini-1.5-pro",
  "deepseek-chat",
  "sarvam-m",
];

const TELEPHONY_PROVIDERS = [
  { value: "twilio", label: "Twilio" },
  { value: "gupshup", label: "Gupshup" },
  { value: "exotel", label: "Exotel" },
  { value: "plivo", label: "Plivo" },
  { value: "custom", label: "Custom Provider" },
];

function isIndian(lang: string) {
  return INDIAN_LANGUAGES.includes(lang);
}

function isAuto(lang: string) {
  return lang === "auto";
}

interface AgentFormValues {
  agentName: string;
  voice: string;
  language: string;
  personality: string;
  aiModel: string;
  greeting: string;
  voicemailMessage: string;
  phoneNumber: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  telephonyProvider: string;
  telephonyProviderName: string;
  telephonyApiKey: string;
  telephonyApiSecret: string;
  telephonyAppId: string;
}

function WebhookUrl({ label, path }: { label: string; path: string }) {
  const [copied, setCopied] = useState(false);
  const baseUrl = window.location.origin;
  const fullUrl = `${baseUrl}${path}`;
  const copy = () => {
    navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{label}</p>
      <div className="flex items-center gap-2 bg-background/50 border border-white/10 rounded-md px-3 py-2">
        <code className="text-xs text-primary flex-1 truncate">{fullUrl}</code>
        <button onClick={copy} className="shrink-0 hover:text-primary transition-colors">
          {copied ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
        </button>
      </div>
    </div>
  );
}

function TelephonyReadOnly({ configured, phoneNumber, provider }: { configured: boolean; phoneNumber?: string | null; provider?: string }) {
  const providerLabel = TELEPHONY_PROVIDERS.find(p => p.value === (provider || "twilio"))?.label || "Telephony";
  return (
    <div className="space-y-3">
      {phoneNumber && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground/80">Phone Number</label>
          <div className="flex items-center gap-2 h-10 rounded-md border border-white/10 bg-background/50 px-3">
            <span className="text-sm text-foreground flex-1">{phoneNumber}</span>
          </div>
        </div>
      )}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 flex items-center gap-3">
        <Lock className="w-5 h-5 text-muted-foreground shrink-0" />
        <div>
          <p className="text-sm font-medium text-foreground">
            {configured ? `${providerLabel} credentials configured by platform` : "Telephony credentials not yet configured"}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Contact your platform administrator to update carrier credentials.
          </p>
        </div>
        {configured && <CheckCircle2 className="w-5 h-5 text-green-400 ml-auto shrink-0" />}
      </div>
    </div>
  );
}

function AutoModePanel() {
  return (
    <div className="rounded-xl border border-fuchsia-500/30 bg-gradient-to-br from-fuchsia-500/10 via-violet-500/5 to-cyan-500/10 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-fuchsia-300" />
        <span className="text-sm font-semibold text-fuchsia-200">Auto-Detect Mode Active</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-fuchsia-300/70 font-medium bg-fuchsia-500/10 border border-fuchsia-500/20 rounded-full px-2 py-0.5">
          Multilingual Pipeline
        </span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        The agent automatically detects each caller's / visitor's language from their first words and routes
        the conversation through the best provider for that language. Designed for low latency and high
        accuracy on <strong className="text-foreground">English, Hindi, and Kannada</strong>.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-background/50 border border-blue-500/30 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-blue-300 text-xs font-bold uppercase tracking-wider">English</span>
            <span className="text-[10px] text-blue-300/60">en-US / en-IN</span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Brain className="w-3 h-3 text-blue-400" /> GPT-4o Mini</div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Volume2 className="w-3 h-3 text-blue-400" /> OpenAI TTS</div>
          <div className="text-[10px] text-blue-300/80">Lowest latency • ~700ms</div>
        </div>

        <div className="bg-background/50 border border-orange-500/30 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-orange-300 text-xs font-bold uppercase tracking-wider">Hindi</span>
            <span className="text-[10px] text-orange-300/60">hi-IN</span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Brain className="w-3 h-3 text-orange-400" /> DeepSeek V3</div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Volume2 className="w-3 h-3 text-orange-400" /> Sarvam Bulbul v3 (Kavya)</div>
          <div className="text-[10px] text-orange-300/80">Native Devanagari • Hi-fi</div>
        </div>

        <div className="bg-background/50 border border-emerald-500/30 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-emerald-300 text-xs font-bold uppercase tracking-wider">Kannada</span>
            <span className="text-[10px] text-emerald-300/60">kn-IN</span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Brain className="w-3 h-3 text-emerald-400" /> Sarvam-M (Indic-native)</div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Volume2 className="w-3 h-3 text-emerald-400" /> Sarvam Bulbul v3 (Manan)</div>
          <div className="text-[10px] text-emerald-300/80">Native ಕನ್ನಡ • Accurate prosody</div>
        </div>
      </div>

      <div className="flex items-start gap-2 text-[11px] text-muted-foreground bg-black/30 border border-white/5 rounded-lg p-3">
        <Languages className="w-3.5 h-3.5 text-fuchsia-300 mt-0.5 shrink-0" />
        <div>
          Detection runs on every turn — if the user switches mid-conversation (e.g. starts in English then
          switches to Kannada), the pipeline switches automatically. Tamil, Telugu, and Marathi are also
          supported with Sarvam-M + Bulbul v3.
        </div>
      </div>
    </div>
  );
}

function SplitModelPanel({ language }: { language: string }) {
  const isHindi = language === "hi-IN";
  const llmName = isHindi ? "DeepSeek V3.2" : "Sarvam-1 (2B)";
  const llmDesc = isHindi
    ? "Optimised for Hindi & English code-switching"
    : "Lightweight, Indic-native model (Kannada / Tamil / Telugu / Marathi)";
  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <Zap className="w-4 h-4 text-indigo-400" />
        <span className="text-sm font-semibold text-indigo-300">Split-Model Pipeline Active</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-indigo-400/70 font-medium bg-indigo-500/10 border border-indigo-500/20 rounded-full px-2 py-0.5">
          Indian Language Mode
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Calls route through a three-stage Indic-optimised pipeline. API keys are configured by your platform administrator.
      </p>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="bg-background/40 border border-white/10 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-cyan-400 font-semibold"><Ear className="w-3.5 h-3.5" /> Ear (STT)</div>
          <div className="text-foreground font-medium">Sarvam Shorthand</div>
          <div className="text-muted-foreground leading-snug">+ Bhashini fallback — handles heavy regional accents</div>
        </div>
        <div className="bg-background/40 border border-white/10 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-violet-400 font-semibold"><Brain className="w-3.5 h-3.5" /> Brain (LLM)</div>
          <div className="text-foreground font-medium">{llmName}</div>
          <div className="text-muted-foreground leading-snug">{llmDesc}</div>
        </div>
        <div className="bg-background/40 border border-white/10 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-emerald-400 font-semibold"><Volume2 className="w-3.5 h-3.5" /> Mouth (TTS)</div>
          <div className="text-foreground font-medium">Sarvam Bulbul V3</div>
          <div className="text-muted-foreground leading-snug">Natural-sounding Indic TTS</div>
        </div>
      </div>
    </div>
  );
}

const selectCls = "w-full flex h-10 items-center justify-between rounded-md border border-white/10 bg-background/50 px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-primary";

function VoicePreview({ voice }: { voice: string }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const togglePlay = (e: React.MouseEvent) => {
    e.preventDefault();
    if (playing) {
      audioRef.current?.pause();
      if (audioRef.current) audioRef.current.currentTime = 0;
      setPlaying(false);
    } else {
      audioRef.current?.play().catch(console.error);
      setPlaying(true);
    }
  };

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.onended = () => setPlaying(false);
    }
  }, []);

  useEffect(() => {
    if (playing) {
      audioRef.current?.pause();
      if (audioRef.current) audioRef.current.currentTime = 0;
      setPlaying(false);
    }
  }, [voice]);

  return (
    <Button
      variant="outline"
      className="shrink-0 h-10 px-3 border-white/10 bg-white/5 hover:bg-white/10"
      onClick={togglePlay}
      title="Review voice how it speaks"
    >
      {playing ? <Square className="w-4 h-4 text-primary fill-primary" /> : <Play className="w-4 h-4 text-primary fill-primary" />}
      <audio ref={audioRef} src={`https://cdn.openai.com/API/docs/audio/${voice}.wav`} hidden />
    </Button>
  );
}

export default function AgentSettings() {
  const { data: agent, isLoading } = useAgentConfig();
  const updateAgent = useUpdateAgentMutation();
  const { toast } = useToast();
  const { isSuperadmin } = useAuth();
  const [autoAiMode, setAutoAiMode] = useState(false);

  const agentAny = agent as any;

  const form = useForm<AgentFormValues>({
    defaultValues: {
      agentName: "", voice: "nova", language: "en-US", personality: "professional",
      aiModel: "gpt-4o-mini", greeting: "", voicemailMessage: "",
      phoneNumber: "", twilioAccountSid: "", twilioAuthToken: "",
      telephonyProvider: "twilio", telephonyProviderName: "",
      telephonyApiKey: "", telephonyApiSecret: "", telephonyAppId: "",
    }
  });

  const watchedLanguage = form.watch("language");
  const watchedProvider = form.watch("telephonyProvider");

  useEffect(() => {
    if (agent) {
      form.reset({
        agentName: agent.agentName || "",
        voice: agent.voice || "nova",
        language: agentAny?.language || "en-US",
        personality: agent.personality || "professional",
        aiModel: agentAny?.aiModel || "gpt-4o-mini",
        greeting: agent.greeting || "",
        voicemailMessage: agent.voicemailMessage || "",
        phoneNumber: agent.phoneNumber || "",
        twilioAccountSid: agent.twilioAccountSid || "",
        twilioAuthToken: "",
        telephonyProvider: agentAny?.telephonyProvider || "twilio",
        telephonyProviderName: agentAny?.telephonyProviderName || "",
        telephonyApiKey: "",
        telephonyApiSecret: "",
        telephonyAppId: agentAny?.telephonyAppId || "",
      });
      setAutoAiMode((agentAny?.language || "en-US") === "auto");
    }
  }, [agent]);

  const handleToggleAutoAiMode = (checked: boolean) => {
    setAutoAiMode(checked);
    if (checked) {
      form.setValue("language", "auto", { shouldDirty: true, shouldValidate: true });
    }
  };

  const onSubmit = async (data: AgentFormValues) => {
    try {
      const payload: any = {
        agentName: data.agentName,
        voice: data.voice,
        language: autoAiMode ? "auto" : data.language,
        personality: data.personality, aiModel: data.aiModel,
        greeting: data.greeting, voicemailMessage: data.voicemailMessage,
      };
      if (isSuperadmin) {
        payload.phoneNumber = data.phoneNumber;
        payload.twilioAccountSid = data.twilioAccountSid;
        if (data.twilioAuthToken) payload.twilioAuthToken = data.twilioAuthToken;
        payload.telephonyProvider = data.telephonyProvider;
        payload.telephonyProviderName = data.telephonyProviderName;
        if (data.telephonyApiKey) payload.telephonyApiKey = data.telephonyApiKey;
        if (data.telephonyApiSecret) payload.telephonyApiSecret = data.telephonyApiSecret;
        payload.telephonyAppId = data.telephonyAppId;
      }
      await updateAgent.mutateAsync(payload);
      toast({ title: "Agent configuration updated" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast({ title: "Failed to update", description: msg, variant: "destructive" });
    }
  };

  if (isLoading) return <div className="animate-pulse h-96 bg-white/5 rounded-xl" />;

  const providerConfigured = agentAny?.byocConfigured || agentAny?.twilioConfigured;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-display font-bold">AI Agent Settings</h1>
        <p className="text-muted-foreground mt-1">Configure your AI sales representative's persona, voice, and telephony.</p>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        <Card className="glass-panel border-fuchsia-500/30 bg-gradient-to-r from-fuchsia-500/10 via-violet-500/5 to-cyan-500/10">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-fuchsia-300" />
                Auto-AI Mode
                <span className="text-[10px] uppercase tracking-wider text-fuchsia-300/70 font-medium bg-fuchsia-500/10 border border-fuchsia-500/20 rounded-full px-2 py-0.5">
                  Recommended
                </span>
              </span>
              <Switch
                checked={autoAiMode}
                onCheckedChange={handleToggleAutoAiMode}
                aria-label="Toggle Auto-AI Mode"
              />
            </CardTitle>
            <CardDescription>
              Automatically detects language and routes LLM + voice pipeline per turn. Turn this off to manually control language, model, and voice behavior.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card className="glass-panel border-white/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Bot className="w-5 h-5 text-primary" /> Persona &amp; Voice</CardTitle>
            <CardDescription>How your agent presents itself to prospects.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium">Agent Name</label>
                <Input {...form.register("agentName")} className="bg-background/50 border-white/10" disabled={autoAiMode} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-1.5">
                  Language
                  {isAuto(watchedLanguage) && (
                    <span className="text-[10px] text-fuchsia-300 bg-fuchsia-500/10 border border-fuchsia-500/20 rounded-full px-1.5 py-0 font-normal flex items-center gap-1">
                      <Sparkles className="w-2.5 h-2.5" /> Auto
                    </span>
                  )}
                </label>
                <select {...form.register("language")} className={selectCls} disabled={autoAiMode}>
                  <optgroup label="Smart">
                    <option value="auto">Auto-Detect (English + Hindi + Kannada + more)</option>
                  </optgroup>
                  <optgroup label="Single language">
                    <option value="en-US">English (US)</option>
                    <option value="hi-IN">Hindi — हिन्दी</option>
                    <option value="kn-IN">Kannada — ಕನ್ನಡ</option>
                    <option value="ta-IN">Tamil — தமிழ்</option>
                    <option value="te-IN">Telugu — తెలుగు</option>
                    <option value="mr-IN">Marathi — मराठी</option>
                  </optgroup>
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">AI Voice</label>
                <div className="flex gap-2">
                  <select {...form.register("voice")} className={selectCls} disabled={autoAiMode}>
                    <option value="alloy">Alloy (Neutral, balanced)</option>
                    <option value="ash">Ash (Soft, clear, gentle)</option>
                    <option value="coral">Coral (Warm, friendly, soft)</option>
                    <option value="echo">Echo (Warm, approachable)</option>
                    <option value="fable">Fable (Expressive, animated)</option>
                    <option value="nova">Nova (Energetic, bright)</option>
                    <option value="onyx">Onyx (Deep, authoritative)</option>
                    <option value="sage">Sage (Pleasant, relaxed, soft)</option>
                    <option value="shimmer">Shimmer (Clear, articulate)</option>
                  </select>
                  {!isIndian(watchedLanguage) && (
                    <VoicePreview voice={form.watch("voice")} />
                  )}
                </div>
                {isIndian(watchedLanguage) && (
                  <p className="text-xs text-indigo-400">Voice overridden by <strong>Sarvam Bulbul V3</strong> (native script TTS) for Indian languages — Kannada uses <strong>Manan</strong>, Hindi uses <strong>Kavya</strong>, etc. Requires <code>SARVAM_API_KEY</code>.</p>
                )}
                {isAuto(watchedLanguage) && (
                  <p className="text-xs text-fuchsia-300">Auto mode: voice is selected per-turn based on detected language — OpenAI voices for English, Sarvam Bulbul V3 (native script) for Indian languages.</p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Personality</label>
                <select {...form.register("personality")} className={selectCls} disabled={autoAiMode}>
                  <option value="professional">Professional &amp; Direct</option>
                  <option value="friendly">Friendly &amp; Conversational</option>
                  <option value="energetic">Energetic &amp; Enthusiastic</option>
                  <option value="calm">Calm &amp; Reassuring</option>
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Default Greeting</label>
              <Textarea {...form.register("greeting")} className="bg-background/50 border-white/10 min-h-[100px]" placeholder="Hi, you've reached Dialog. I'm Alex, how can I help you today?" disabled={autoAiMode} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Voicemail Message</label>
              <Textarea {...form.register("voicemailMessage")} className="bg-background/50 border-white/10" placeholder="Please leave a message and our team will get back to you." disabled={autoAiMode} />
            </div>
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Cpu className="w-5 h-5 text-primary" /> AI Model</CardTitle>
            <CardDescription>Choose the model powering your agent's responses.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Conversation Model</label>
              <select {...form.register("aiModel")} className={selectCls} disabled={autoAiMode}>
                {!CURRENT_MODELS.includes(form.watch("aiModel")) && (
                  <option value={form.watch("aiModel")} disabled>Legacy model — please select a new model</option>
                )}
                <option value="gpt-4o-mini">GPT-4o Mini — Fast & Cost Effective</option>
                <option value="gpt-4o">GPT-4o — Highest Intelligence</option>
                <option value="gemini-1.5-pro">Gemini 1.5 Pro — Google's Multimodal</option>
                <option value="deepseek-chat">DeepSeek V3 — Open-source powerhouse</option>
                <option value="sarvam-m">Sarvam 2B — India-native LLM</option>
              </select>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-center">
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-2">
                <div className="font-semibold text-blue-400 text-[11px] truncate">GPT-4o Mini</div>
                <div className="text-muted-foreground text-[9px] mt-0.5 leading-tight">OpenAI<br/>Low Latency</div>
              </div>
              <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-2">
                <div className="font-semibold text-purple-400 text-[11px] truncate">GPT-4o</div>
                <div className="text-muted-foreground text-[9px] mt-0.5 leading-tight">OpenAI<br/>Adv. Reasoning</div>
              </div>
              <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg p-2">
                <div className="font-semibold text-cyan-400 text-[11px] truncate">Gemini 1.5</div>
                <div className="text-muted-foreground text-[9px] mt-0.5 leading-tight">Google<br/>Multimodal</div>
              </div>
              <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-2">
                <div className="font-semibold text-orange-400 text-[11px] truncate">DeepSeek V3</div>
                <div className="text-muted-foreground text-[9px] mt-0.5 leading-tight">DeepSeek<br/>Fast & Accurate</div>
              </div>
              <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-2">
                <div className="font-semibold text-green-400 text-[11px] truncate">Sarvam 2B</div>
                <div className="text-muted-foreground text-[9px] mt-0.5 leading-tight">Sarvam AI<br/>Indic-native</div>
              </div>
            </div>
            {isAuto(watchedLanguage) && <AutoModePanel />}
            {isIndian(watchedLanguage) && <SplitModelPanel language={watchedLanguage} />}
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Phone className="w-5 h-5 text-primary" /> Telephony Integration (BYOC)</CardTitle>
            <CardDescription>
              {isSuperadmin
                ? "Bring Your Own Carrier — configure the telephony provider for this tenant."
                : "Telephony is managed by your platform administrator."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {isSuperadmin ? (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Telephony Provider</label>
                  <select {...form.register("telephonyProvider")} className={selectCls}>
                    {TELEPHONY_PROVIDERS.map(p => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>

                {watchedProvider === "twilio" && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Phone Number</label>
                      <Input {...form.register("phoneNumber")} placeholder="+1234567890" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Account SID</label>
                      <Input {...form.register("twilioAccountSid")} placeholder="ACxxxxxxxxxxxx" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-sm font-medium">Auth Token</label>
                      <Input
                        {...form.register("twilioAuthToken")}
                        type="password"
                        placeholder={agentAny?.twilioConfigured ? "•••••••••••••••• (Configured)" : "Enter auth token"}
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                  </div>
                )}

                {watchedProvider === "gupshup" && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Phone Number</label>
                      <Input {...form.register("phoneNumber")} placeholder="+91XXXXXXXXXX" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">App ID</label>
                      <Input {...form.register("telephonyAppId")} placeholder="Gupshup App ID" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Key</label>
                      <Input
                        {...form.register("telephonyApiKey")}
                        type="password"
                        placeholder={agentAny?.byocConfigured ? "•••••••••• (Configured)" : "Gupshup API Key"}
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Secret</label>
                      <Input {...form.register("telephonyApiSecret")} type="password" placeholder="Gupshup API Secret" className="bg-background/50 border-white/10" />
                    </div>
                  </div>
                )}

                {watchedProvider === "exotel" && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Exotel SID (Phone)</label>
                      <Input {...form.register("telephonyAppId")} placeholder="Exotel Virtual Number" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Account SID</label>
                      <Input {...form.register("twilioAccountSid")} placeholder="Exotel Account SID" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Key</label>
                      <Input
                        {...form.register("telephonyApiKey")}
                        type="password"
                        placeholder={agentAny?.byocConfigured ? "•••••••••• (Configured)" : "Exotel API Key"}
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Token</label>
                      <Input {...form.register("telephonyApiSecret")} type="password" placeholder="Exotel API Token" className="bg-background/50 border-white/10" />
                    </div>
                  </div>
                )}

                {watchedProvider === "plivo" && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Plivo Number</label>
                      <Input {...form.register("phoneNumber")} placeholder="+91XXXXXXXXXX" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Auth ID</label>
                      <Input {...form.register("twilioAccountSid")} placeholder="Plivo Auth ID" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-sm font-medium">Auth Token</label>
                      <Input
                        {...form.register("telephonyApiKey")}
                        type="password"
                        placeholder={agentAny?.byocConfigured ? "•••••••••• (Configured)" : "Plivo Auth Token"}
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                  </div>
                )}

                {watchedProvider === "custom" && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-sm font-medium">Provider Name</label>
                      <Input {...form.register("telephonyProviderName")} placeholder="e.g. MyCarrier, Voximplant, TATA Tele..." className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Phone Number</label>
                      <Input {...form.register("phoneNumber")} placeholder="+91XXXXXXXXXX" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Application / SID</label>
                      <Input {...form.register("telephonyAppId")} placeholder="App/SID identifier" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Key</label>
                      <Input {...form.register("telephonyApiKey")} type="password" placeholder="API Key / Auth ID" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">API Secret / Token</label>
                      <Input {...form.register("telephonyApiSecret")} type="password" placeholder="API Secret / Token" className="bg-background/50 border-white/10" />
                    </div>
                    <div className="md:col-span-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-sm text-amber-200">
                      <strong>Custom provider:</strong> Point your carrier's inbound webhook to <code className="text-xs bg-black/30 px-1 rounded">/api/twilio/inbound</code> and configure its credentials above. Our team will integrate the outbound dialling SDK for your carrier.
                    </div>
                  </div>
                )}

                {watchedProvider !== "twilio" && watchedProvider !== "custom" && (
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-sm text-blue-200">
                    <strong>Note:</strong> Outbound dialling for this provider is in beta. Inbound voice will work via the webhook URLs below. Contact support to enable outbound campaigns.
                  </div>
                )}
              </>
            ) : (
              <TelephonyReadOnly
                configured={!!providerConfigured}
                phoneNumber={agent?.phoneNumber}
                provider={agentAny?.telephonyProvider}
              />
            )}
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Webhook className="w-5 h-5 text-primary" />
              {watchedProvider === "twilio" || !isSuperadmin ? "Twilio Webhook URLs" : `${TELEPHONY_PROVIDERS.find(p => p.value === watchedProvider)?.label || "Provider"} Webhook URLs`}
            </CardTitle>
            <CardDescription>Copy these URLs into your telephony provider's webhook configuration.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-sm text-amber-200">
              <strong>Setup:</strong> In your provider console, point the inbound call webhook (HTTP POST) to the Voice URL below. The status callback URL receives call events.
            </div>
            <WebhookUrl label="Inbound Call Webhook (Voice URL)" path="/api/twilio/inbound" />
            <WebhookUrl label="Call Status Callback" path="/api/twilio/status" />
            <WebhookUrl label="Outbound Voice Handler" path="/api/twilio/outbound-voice" />
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" size="lg" disabled={updateAgent.isPending} className="shadow-lg shadow-primary/20">
            <Settings2 className="w-4 h-4 mr-2" />
            {updateAgent.isPending ? "Saving..." : "Save Configuration"}
          </Button>
        </div>
      </form>
    </div>
  );
}
