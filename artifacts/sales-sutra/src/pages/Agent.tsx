import React, { useEffect, useState } from "react";
import { useAgentConfig, useUpdateAgentMutation } from "@/hooks/use-agent";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Bot, Phone, Settings2, AlertCircle, Copy, CheckCircle2, Webhook, Cpu, Lock, Ear, Brain, Volume2, Zap } from "lucide-react";
import { useForm } from "react-hook-form";
import { useAuth } from "@/hooks/use-auth";

const INDIAN_LANGUAGES = ["kn-IN", "hi-IN", "ta-IN", "te-IN", "mr-IN"];

const CURRENT_MODELS = [
  "gemini-1.5-pro",
  "llama-3.3-8b-private",
  "bharatgpt",
  "bolna-ai",
];

function isIndian(lang: string) {
  return INDIAN_LANGUAGES.includes(lang);
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

function TelephonyReadOnly({ configured, phoneNumber }: { configured: boolean; phoneNumber?: string | null }) {
  return (
    <div className="space-y-3">
      {phoneNumber && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground/80">Phone Number</label>
          <div className="flex items-center gap-2 h-10 rounded-md border border-white/10 bg-background/50 px-3">
            <span className="text-sm text-foreground flex-1">{phoneNumber}</span>
          </div>
          <p className="text-xs text-muted-foreground">Use this number in your Twilio webhook configuration.</p>
        </div>
      )}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 flex items-center gap-3">
        <Lock className="w-5 h-5 text-muted-foreground shrink-0" />
        <div>
          <p className="text-sm font-medium text-foreground">
            {configured ? "Twilio credentials configured by platform" : "Twilio credentials not yet configured"}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Contact your platform administrator to update Account SID and Auth Token.
          </p>
        </div>
        {configured && <CheckCircle2 className="w-5 h-5 text-green-400 ml-auto shrink-0" />}
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
        Calls in this language route through a three-stage Indic-optimised pipeline instead of the standard engine.
        API keys are configured by your platform administrator.
      </p>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="bg-background/40 border border-white/10 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-cyan-400 font-semibold">
            <Ear className="w-3.5 h-3.5" /> Ear (STT)
          </div>
          <div className="text-foreground font-medium">Sarvam Shorthand</div>
          <div className="text-muted-foreground leading-snug">+ Bhashini fallback — handles heavy regional accents</div>
        </div>
        <div className="bg-background/40 border border-white/10 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-violet-400 font-semibold">
            <Brain className="w-3.5 h-3.5" /> Brain (LLM)
          </div>
          <div className="text-foreground font-medium">{llmName}</div>
          <div className="text-muted-foreground leading-snug">{llmDesc}</div>
        </div>
        <div className="bg-background/40 border border-white/10 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
            <Volume2 className="w-3.5 h-3.5" /> Mouth (TTS)
          </div>
          <div className="text-foreground font-medium">Sarvam Bulbul V3</div>
          <div className="text-muted-foreground leading-snug">Natural-sounding Indic TTS synthesis</div>
        </div>
      </div>
    </div>
  );
}

export default function AgentSettings() {
  const { data: agent, isLoading } = useAgentConfig();
  const updateAgent = useUpdateAgentMutation();
  const { toast } = useToast();
  const { isSuperadmin } = useAuth();

  const agentWithModel = agent as (typeof agent & { aiModel?: string; language?: string }) | undefined;

  const form = useForm<AgentFormValues>({
    defaultValues: {
      agentName: "",
      voice: "nova",
      language: "en-US",
      personality: "professional",
      aiModel: "gemini-1.5-pro",
      greeting: "",
      voicemailMessage: "",
      phoneNumber: "",
      twilioAccountSid: "",
      twilioAuthToken: ""
    }
  });

  const watchedLanguage = form.watch("language");

  useEffect(() => {
    if (agent) {
      form.reset({
        agentName: agent.agentName || "",
        voice: agent.voice || "nova",
        language: agentWithModel?.language || "en-US",
        personality: agent.personality || "professional",
        aiModel: agentWithModel?.aiModel || "gemini-1.5-pro",
        greeting: agent.greeting || "",
        voicemailMessage: agent.voicemailMessage || "",
        phoneNumber: agent.phoneNumber || "",
        twilioAccountSid: agent.twilioAccountSid || "",
        twilioAuthToken: ""
      });
    }
  }, [agent, form, agentWithModel?.aiModel, agentWithModel?.language]);

  const onSubmit = async (data: AgentFormValues) => {
    try {
      const payload: Partial<AgentFormValues> = {
        agentName: data.agentName,
        voice: data.voice,
        language: data.language,
        personality: data.personality,
        aiModel: data.aiModel,
        greeting: data.greeting,
        voicemailMessage: data.voicemailMessage,
      };
      if (isSuperadmin) {
        payload.phoneNumber = data.phoneNumber;
        payload.twilioAccountSid = data.twilioAccountSid;
        if (data.twilioAuthToken) payload.twilioAuthToken = data.twilioAuthToken;
      }
      await updateAgent.mutateAsync(payload as AgentFormValues);
      toast({ title: "Agent configuration updated" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast({ title: "Failed to update", description: message, variant: "destructive" });
    }
  };

  if (isLoading) return <div className="animate-pulse h-96 bg-white/5 rounded-xl"></div>;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-display font-bold">AI Agent Settings</h1>
        <p className="text-muted-foreground mt-1">Configure your AI sales representative's personality and voice.</p>
      </div>

      <div className="bg-primary/10 border border-primary/20 rounded-xl p-4 flex items-start gap-4">
        <AlertCircle className="w-5 h-5 text-primary mt-0.5 shrink-0" />
        <div>
          <h4 className="font-semibold text-primary">Google Voice Integration</h4>
          <p className="text-sm text-primary/80 mt-1">
            Google Voice does not permit direct API programmatic calling. To use your Google Voice number, set up Twilio below, then configure your Google Voice account to forward calls to your Twilio number.
          </p>
        </div>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        <Card className="glass-panel border-white/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" /> Persona &amp; Voice
            </CardTitle>
            <CardDescription>How your agent presents itself to prospects.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium">Agent Name</label>
                <Input {...form.register("agentName")} className="bg-background/50 border-white/10" />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Language</label>
                <select
                  {...form.register("language")}
                  className="w-full flex h-10 items-center justify-between rounded-md border border-white/10 bg-background/50 px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="en-US">English (US)</option>
                  <option value="hi-IN">Hindi — हिन्दी</option>
                  <option value="kn-IN">Kannada — ಕನ್ನಡ</option>
                  <option value="ta-IN">Tamil — தமிழ்</option>
                  <option value="te-IN">Telugu — తెలుగు</option>
                  <option value="mr-IN">Marathi — मराठी</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">AI Voice</label>
                <select
                  {...form.register("voice")}
                  className="w-full flex h-10 items-center justify-between rounded-md border border-white/10 bg-background/50 px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="alloy">Alloy (Neutral, balanced)</option>
                  <option value="echo">Echo (Warm, approachable)</option>
                  <option value="fable">Fable (Expressive, animated)</option>
                  <option value="onyx">Onyx (Deep, authoritative)</option>
                  <option value="nova">Nova (Energetic, bright)</option>
                  <option value="shimmer">Shimmer (Clear, articulate)</option>
                </select>
                {isIndian(watchedLanguage) && (
                  <p className="text-xs text-indigo-400">
                    Voice overridden by <strong>Sarvam Bulbul V3</strong> when an Indian language is active.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Personality</label>
                <select
                  {...form.register("personality")}
                  className="w-full flex h-10 items-center justify-between rounded-md border border-white/10 bg-background/50 px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="professional">Professional &amp; Direct</option>
                  <option value="friendly">Friendly &amp; Conversational</option>
                  <option value="energetic">Energetic &amp; Enthusiastic</option>
                  <option value="calm">Calm &amp; Reassuring</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Default Greeting (Inbound Calls)</label>
              <Textarea
                {...form.register("greeting")}
                className="bg-background/50 border-white/10 min-h-[100px]"
                placeholder="Hi, you've reached Dialog. I'm Alex, how can I help you today?"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Voicemail Message</label>
              <Textarea
                {...form.register("voicemailMessage")}
                className="bg-background/50 border-white/10"
                placeholder="Please leave a message and our team will get back to you."
              />
            </div>
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="w-5 h-5 text-primary" /> AI Model
            </CardTitle>
            <CardDescription>Choose the AI model powering your agent's responses.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Conversation Model</label>
              <select
                {...form.register("aiModel")}
                className="w-full flex h-10 items-center justify-between rounded-md border border-white/10 bg-background/50 px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {!CURRENT_MODELS.includes(form.watch("aiModel")) && (
                  <option value={form.watch("aiModel")} disabled>
                    Legacy model ({form.watch("aiModel")}) — please select a new model
                  </option>
                )}
                <option value="gemini-1.5-pro">Gemini 1.5 Pro — Google's multimodal flagship</option>
                <option value="llama-3.3-8b-private">Llama 3.3 (8B) — Private Hosting</option>
                <option value="bharatgpt">BharatGPT — India-first multilingual LLM</option>
                <option value="bolna-ai">Bolna AI — Voice-native conversational agent</option>
              </select>
              {!CURRENT_MODELS.includes(form.watch("aiModel")) && (
                <p className="text-xs text-amber-400 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  Legacy model — please select a supported model above and save.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-center">
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
                <div className="font-semibold text-blue-400">Gemini 1.5 Pro</div>
                <div className="text-muted-foreground mt-1">Google Cloud</div>
                <div className="text-muted-foreground">Multilingual</div>
              </div>
              <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-3">
                <div className="font-semibold text-orange-400">Llama 3.3 8B</div>
                <div className="text-muted-foreground mt-1">Private Hosting</div>
                <div className="text-muted-foreground">Data stays on-prem</div>
              </div>
              <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3">
                <div className="font-semibold text-green-400">BharatGPT</div>
                <div className="text-muted-foreground mt-1">India-native</div>
                <div className="text-muted-foreground">22 Indian languages</div>
              </div>
              <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-3">
                <div className="font-semibold text-purple-400">Bolna AI</div>
                <div className="text-muted-foreground mt-1">Voice-native</div>
                <div className="text-muted-foreground">Low-latency calls</div>
              </div>
            </div>

            {isIndian(watchedLanguage) && (
              <SplitModelPanel language={watchedLanguage} />
            )}
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Phone className="w-5 h-5 text-primary" /> Telephony Integration
            </CardTitle>
            <CardDescription>
              {isSuperadmin
                ? "Configure Twilio credentials for this tenant."
                : "Telephony is managed by your platform administrator."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {isSuperadmin ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Twilio Phone Number</label>
                  <Input {...form.register("phoneNumber")} placeholder="+1234567890" className="bg-background/50 border-white/10" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Twilio Account SID</label>
                  <Input {...form.register("twilioAccountSid")} className="bg-background/50 border-white/10" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Twilio Auth Token</label>
                  <Input
                    {...form.register("twilioAuthToken")}
                    type="password"
                    placeholder={agent?.twilioConfigured ? "•••••••••••••••• (Configured)" : "Enter token"}
                    className="bg-background/50 border-white/10"
                  />
                </div>
              </div>
            ) : (
              <TelephonyReadOnly configured={!!agent?.twilioConfigured} phoneNumber={agent?.phoneNumber} />
            )}
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Webhook className="w-5 h-5 text-primary" /> Twilio Webhook URLs
            </CardTitle>
            <CardDescription>
              Copy these URLs into your Twilio phone number configuration.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-sm text-amber-200">
              <strong>Setup:</strong> Go to your Twilio Console → Phone Numbers → Active Numbers → select your number → configure Voice webhooks with the URLs below (HTTP POST).
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
