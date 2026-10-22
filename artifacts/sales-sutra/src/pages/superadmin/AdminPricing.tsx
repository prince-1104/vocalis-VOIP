import { useEffect, useState, useCallback } from "react";
import { DollarSign, Save, Loader2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("ss_auth_token");
  const h: Record<string, string> = {};
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export default function AdminPricing() {
  const [rates, setRates] = useState<Record<string, number>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  const fetchRates = useCallback(async () => {
    try {
      const res = await fetch("/api/superadmin/costs/rates", { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setRates(data);
        const formInit: Record<string, string> = {};
        for (const [k, v] of Object.entries(data)) {
          formInit[k] = String(v);
        }
        setForm(formInit);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchRates(); }, [fetchRates]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Blank fields are left unset (usage needing them waits for reconciliation) rather than priced at zero.
      const payload: Record<string, number> = {};
      for (const [k, v] of Object.entries(form)) {
        const value = parseFloat(v);
        if (v.trim() !== "" && Number.isFinite(value) && value >= 0 && value !== rates[k]) payload[k] = value;
      }
      if (Object.keys(payload).length === 0) {
        toast({ title: "No rate changes to save" });
        return;
      }
      const res = await fetch("/api/superadmin/costs/rates", {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        toast({ title: "Pricing rates updated" });
        await fetchRates();
      } else {
        throw new Error("Failed to update");
      }
    } catch {
      toast({ title: "Failed to save rates", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const rateConfig = [
    { key: "llm:gpt-4o-mini:input", label: "gpt-4o-mini input", unit: "per 1M tokens" },
    { key: "llm:gpt-4o-mini:output", label: "gpt-4o-mini output", unit: "per 1M tokens" },
    { key: "llm:deepseek-chat:input", label: "deepseek-chat input", unit: "per 1M tokens" },
    { key: "llm:deepseek-chat:output", label: "deepseek-chat output", unit: "per 1M tokens" },
    { key: "llm:sarvam-m:input", label: "sarvam-m input", unit: "per 1M tokens" },
    { key: "llm:sarvam-m:output", label: "sarvam-m output", unit: "per 1M tokens" },
    { key: "tts:sarvam", label: "Sarvam TTS (Bulbul v3)", unit: "per 1M chars" },
    { key: "tts:openai", label: "OpenAI TTS", unit: "per 1M chars" },
    { key: "stt:whisper", label: "STT (Whisper)", unit: "per minute" },
    { key: "llm:gpt-4o:input", label: "gpt-4o input", unit: "per 1M tokens" },
    { key: "llm:gpt-4o:output", label: "gpt-4o output", unit: "per 1M tokens" },
    { key: "llm:gpt-4o-mini:cached_input", label: "gpt-4o-mini cached input", unit: "per 1M tokens" },
    { key: "llm:gpt-4o:cached_input", label: "gpt-4o cached input", unit: "per 1M tokens" },
    { key: "llm:deepseek-chat:cached_input", label: "deepseek-chat cached input", unit: "per 1M tokens" },
    { key: "stt:sarvam", label: "STT (Sarvam Saaras)", unit: "per minute" },
    { key: "stt:twilio-gather", label: "Twilio Gather speech", unit: "per request" },
    { key: "telephony:twilio:outbound", label: "Twilio outbound call", unit: "per started minute" },
    { key: "telephony:twilio:inbound", label: "Twilio inbound call", unit: "per started minute" },
    { key: "telephony:twilio:client", label: "Twilio browser voice", unit: "per started minute" },
    { key: "telephony:twilio:conference", label: "Twilio conference participant", unit: "per started minute" },
    { key: "telephony:twilio-sip:outbound", label: "SIP trunk outbound", unit: "per started minute" },
    { key: "telephony:exotel:outbound", label: "Exotel outbound call", unit: "per started minute" },
    { key: "telephony:exotel:inbound", label: "Exotel inbound call", unit: "per started minute" },
  ];

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Pricing Configuration</h1>
        <p className="text-muted-foreground mt-1">Configure the base rates used for calculating tenant API consumption costs.</p>
      </div>

      <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-green-400" /> Base API Rates
          </h2>
          <Button onClick={handleSave} disabled={isSaving} size="sm" className="gap-2">
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Changes
          </Button>
        </div>

        <div className="p-6">
          <div className="flex items-start gap-3 p-4 rounded-lg bg-blue-500/10 text-blue-400 text-sm mb-6 border border-blue-500/20">
            <Info className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p>
              Rates apply to usage recorded after saving (within about five minutes on every server). Each change creates a new rate version;
              recorded usage keeps the version it was priced with. A blank rate is not treated as free: usage that needs it waits for reconciliation.
            </p>
          </div>

          <div className="grid grid-cols-[1fr_120px_150px] gap-4 px-4 py-2 text-xs font-medium text-muted-foreground border-b border-white/5">
            <div>API Item</div>
            <div>Unit</div>
            <div className="text-right">Current Rate (USD)</div>
          </div>

          <div className="divide-y divide-white/5">
            {rateConfig.map((item) => (
              <div key={item.key} className="grid grid-cols-[1fr_120px_150px] gap-4 px-4 py-3 items-center">
                <div className="text-sm font-medium text-foreground">{item.label}</div>
                <div className="text-sm text-muted-foreground">{item.unit}</div>
                <div className="flex justify-end">
                  <div className="relative w-28">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                    <Input
                      type="number"
                      step="0.0001"
                      min="0"
                      className="pl-7 h-9 bg-white/5 border-white/10 text-right pr-3"
                      value={form[item.key] ?? ""}
                      onChange={(e) => setForm({ ...form, [item.key]: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
