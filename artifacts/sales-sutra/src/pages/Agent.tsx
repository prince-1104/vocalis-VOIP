import React, { useEffect, useState } from "react";
import { useAgentConfig, useUpdateAgentMutation } from "@/hooks/use-agent";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Bot, Phone, Settings2, AlertCircle, Copy, CheckCircle2, Webhook, Cpu, Lock } from "lucide-react";
import { useForm } from "react-hook-form";
import { useAuth } from "@/hooks/use-auth";

interface AgentFormValues {
  agentName: string;
  voice: string;
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

export default function AgentSettings() {
  const { data: agent, isLoading } = useAgentConfig();
  const updateAgent = useUpdateAgentMutation();
  const { toast } = useToast();
  const { isSuperadmin } = useAuth();

  const agentWithModel = agent as (typeof agent & { aiModel?: string }) | undefined;

  const form = useForm<AgentFormValues>({
    defaultValues: {
      agentName: "",
      voice: "nova",
      personality: "professional",
      aiModel: "gpt-4o-mini",
      greeting: "",
      voicemailMessage: "",
      phoneNumber: "",
      twilioAccountSid: "",
      twilioAuthToken: ""
    }
  });

  useEffect(() => {
    if (agent) {
      form.reset({
        agentName: agent.agentName || "",
        voice: agent.voice || "nova",
        personality: agent.personality || "professional",
        aiModel: agentWithModel?.aiModel || "gpt-4o-mini",
        greeting: agent.greeting || "",
        voicemailMessage: agent.voicemailMessage || "",
        phoneNumber: agent.phoneNumber || "",
        twilioAccountSid: agent.twilioAccountSid || "",
        twilioAuthToken: ""
      });
    }
  }, [agent, form, agentWithModel?.aiModel]);

  const onSubmit = async (data: AgentFormValues) => {
    try {
      const payload: Partial<AgentFormValues> = {
        agentName: data.agentName,
        voice: data.voice,
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
                <label className="text-sm font-medium">AI Voice Model</label>
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
                placeholder="Hi, you've reached SalesSutra. I'm Alex, how can I help you today?"
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
            <CardDescription>Choose the AI model for your agent's responses.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Conversation Model</label>
              <select
                {...form.register("aiModel")}
                className="w-full flex h-10 items-center justify-between rounded-md border border-white/10 bg-background/50 px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="gpt-4o-mini">GPT-4o Mini — fastest &amp; cheapest (~$0.001/call)</option>
                <option value="gpt-4o">GPT-4o — balanced quality &amp; cost (~$0.01/call)</option>
                <option value="gpt-5.2">GPT-5.2 — highest quality (~$0.05/call)</option>
              </select>
            </div>
            <div className="grid grid-cols-3 gap-3 text-xs text-center">
              <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3">
                <div className="font-semibold text-green-400">GPT-4o Mini</div>
                <div className="text-muted-foreground mt-1">~$0.001 / call</div>
                <div className="text-muted-foreground">Best for scripts</div>
              </div>
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
                <div className="font-semibold text-blue-400">GPT-4o</div>
                <div className="text-muted-foreground mt-1">~$0.01 / call</div>
                <div className="text-muted-foreground">Balanced</div>
              </div>
              <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-3">
                <div className="font-semibold text-purple-400">GPT-5.2</div>
                <div className="text-muted-foreground mt-1">~$0.05 / call</div>
                <div className="text-muted-foreground">Premium quality</div>
              </div>
            </div>
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
