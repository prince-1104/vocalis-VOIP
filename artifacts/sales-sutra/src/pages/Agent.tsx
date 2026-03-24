import React, { useEffect } from "react";
import { useAgentConfig, useUpdateAgentMutation } from "@/hooks/use-agent";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Bot, Phone, Settings2, AlertCircle } from "lucide-react";
import { useForm } from "react-hook-form";

export default function AgentSettings() {
  const { data: agent, isLoading } = useAgentConfig();
  const updateAgent = useUpdateAgentMutation();
  const { toast } = useToast();

  const form = useForm({
    defaultValues: {
      agentName: "",
      voice: "alloy",
      personality: "professional",
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
        voice: agent.voice || "alloy",
        personality: agent.personality || "professional",
        greeting: agent.greeting || "",
        voicemailMessage: agent.voicemailMessage || "",
        phoneNumber: agent.phoneNumber || "",
        twilioAccountSid: agent.twilioAccountSid || "",
        twilioAuthToken: "" // keep empty for security
      });
    }
  }, [agent, form]);

  const onSubmit = async (data: any) => {
    try {
      await updateAgent.mutateAsync(data);
      toast({ title: "Agent configuration updated" });
    } catch (err: any) {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
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
            Google Voice does not permit direct API programmatic calling. To use your Google Voice number, set up Twilio below, then configure your Google Voice account to forward calls to your new Twilio number.
          </p>
        </div>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        <Card className="glass-panel border-white/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" /> Persona & Voice
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
                  <option value="professional">Professional & Direct</option>
                  <option value="friendly">Friendly & Conversational</option>
                  <option value="energetic">Energetic & Enthusiastic</option>
                  <option value="calm">Calm & Reassuring</option>
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
              <Phone className="w-5 h-5 text-primary" /> Telephony Integration
            </CardTitle>
            <CardDescription>Connect your Twilio account to enable calling capabilities.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
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
