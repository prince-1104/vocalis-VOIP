import React, { useState } from "react";
import { useCampaignsList, useCreateCampaignMutation, useStartCampaignMutation, usePauseCampaignMutation, useUpdateCampaignMutation } from "@/hooks/use-campaigns";
import { useScriptsList } from "@/hooks/use-scripts";
import { useContactsList } from "@/hooks/use-contacts";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui-custom/StatusBadge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Megaphone, Play, Pause, PhoneCall, Loader2, Activity, Users, Edit, Clock, Mic, DollarSign, Bot, PhoneOutgoing, PhoneIncoming, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export default function Campaigns() {
  const { data: campaigns, isLoading, refetch, isFetching } = useCampaignsList();

  // Auto-refresh/poll the campaigns list every 5 seconds if any campaign is active
  React.useEffect(() => {
    const hasActiveCampaign = campaigns?.some(c => c.status === "active");
    if (!hasActiveCampaign) return;

    const interval = setInterval(() => {
      refetch();
    }, 5000);
    return () => clearInterval(interval);
  }, [campaigns, refetch]);
  const { data: scripts } = useScriptsList();
  const { data: contactsData } = useContactsList({ limit: 100 });
  const contacts = contactsData?.contacts || [];
  const createCampaign = useCreateCampaignMutation();
  const startCampaign = useStartCampaignMutation();
  const pauseCampaign = usePauseCampaignMutation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [dialingCampaignId, setDialingCampaignId] = useState<number | null>(null);
  
  const updateCampaign = useUpdateCampaignMutation();
  const [editingCampaign, setEditingCampaign] = useState<any | null>(null);
  const [editFormData, setEditFormData] = useState({
    name: "",
    description: "",
    scriptId: 0,
    maxConcurrentCalls: 1,
    dialParallel: false,
    isAutomatic: false,
    maxRetries: 0,
    retryIntervalMinutes: 10,
    contactIds: [] as number[]
  });

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    scriptId: 0,
    maxConcurrentCalls: 1,
    dialParallel: false,
    isAutomatic: false,
    maxRetries: 0,
    retryIntervalMinutes: 10,
    contactIds: [] as number[]
  });

  // State variables for campaign performance call log viewer
  const [selectedPerformanceCampaign, setSelectedPerformanceCampaign] = useState<any | null>(null);
  const [campaignCalls, setCampaignCalls] = useState<any[]>([]);
  const [loadingCalls, setLoadingCalls] = useState(false);
  const [selectedCallDetails, setSelectedCallDetails] = useState<any | null>(null);

  const fetchCampaignCalls = async (campaignId: number) => {
    setLoadingCalls(true);
    try {
      const token = localStorage.getItem("ss_auth_token");
      const response = await fetch(`/api/calls?campaignId=${campaignId}&limit=100`, {
        headers: {
          ...(token ? { "Authorization": `Bearer ${token}` } : {})
        }
      });
      const data = await response.json();
      setCampaignCalls(data.calls || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingCalls(false);
    }
  };

  React.useEffect(() => {
    if (!selectedPerformanceCampaign) return;

    fetchCampaignCalls(selectedPerformanceCampaign.id);
    
    const interval = setInterval(() => {
      fetchCampaignCalls(selectedPerformanceCampaign.id);
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedPerformanceCampaign]);

  React.useEffect(() => {
    if (selectedCallDetails && campaignCalls.length > 0) {
      const updatedCall = campaignCalls.find(c => c.id === selectedCallDetails.id);
      if (updatedCall) {
        setSelectedCallDetails(updatedCall);
      }
    }
  }, [campaignCalls, selectedCallDetails?.id]);

  const handleEditClick = (campaign: any) => {
    setEditingCampaign(campaign);
    setEditFormData({
      name: campaign.name,
      description: campaign.description || "",
      scriptId: campaign.scriptId || 0,
      maxConcurrentCalls: campaign.maxConcurrentCalls || 1,
      dialParallel: campaign.dialParallel || false,
      isAutomatic: campaign.isAutomatic || false,
      maxRetries: campaign.maxRetries || 0,
      retryIntervalMinutes: campaign.retryIntervalMinutes || 10,
      contactIds: campaign.contactIds || []
    });
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editFormData.scriptId && scripts && scripts.length > 0) {
      editFormData.scriptId = scripts[0].id;
    }
    try {
      await updateCampaign.mutateAsync({ id: editingCampaign.id, data: editFormData });
      toast({ title: "Campaign updated" });
      setEditingCampaign(null);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.scriptId && scripts && scripts.length > 0) {
       formData.scriptId = scripts[0].id;
    }
    try {
      await createCampaign.mutateAsync(formData);
      toast({ title: "Campaign created" });
      setIsDialogOpen(false);
      setFormData({ name: "", description: "", scriptId: 0, maxConcurrentCalls: 1, dialParallel: false, isAutomatic: false, maxRetries: 0, retryIntervalMinutes: 10, contactIds: [] });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleAction = async (id: number, status: string) => {
    try {
      if (status === 'active') {
        await pauseCampaign.mutateAsync(id);
        toast({ title: "Campaign paused" });
      } else {
        const campaign = campaigns?.find(c => c.id === id);
        await startCampaign.mutateAsync(id);
        if (campaign?.isAutomatic) {
          toast({ title: "Campaign activated — automated dialing started." });
        } else {
          toast({ title: "Campaign activated — use Dial Next to start calling." });
        }
      }
    } catch (err: any) {
      toast({ title: "Action failed", description: err.message, variant: "destructive" });
    }
  };

  const handleDialNext = async (campaignId: number) => {
    setDialingCampaignId(campaignId);
    try {
      const token = localStorage.getItem("ss_auth_token");
      const response = await fetch(`/api/campaigns/${campaignId}/dial-next`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {})
        },
        body: JSON.stringify({}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to dial");
      if (result.done) {
        toast({ title: "Campaign complete", description: result.message });
      } else {
        const name = result.contact 
          ? `${result.contact.firstName || ""} ${result.contact.lastName || ""}`.trim() || result.contact.phone
          : "next contact";
        toast({
          title: `Dialing ${name}`,
          description: `${result.remaining} contacts remaining in campaign.`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      queryClient.invalidateQueries({ queryKey: ["call-logs"] });
    } catch (err: any) {
      toast({ title: "Dial failed", description: err.message, variant: "destructive" });
    } finally {
      setDialingCampaignId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-display font-bold">Campaigns</h1>
          <p className="text-muted-foreground mt-1">Manage your automated outbound dialing operations.</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/25">
              <Megaphone className="w-4 h-4 mr-2" /> New Campaign
            </Button>
          </DialogTrigger>
          <DialogContent className="glass-panel sm:max-w-[500px] border-white/10">
            <DialogHeader>
              <DialogTitle>Create Campaign</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4 mt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Campaign Name</label>
                <Input 
                  required 
                  value={formData.name} 
                  onChange={e => setFormData({...formData, name: e.target.value})} 
                  className="bg-background/50 border-white/10" 
                  placeholder="Q4 Outreach"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Description</label>
                <Input 
                  value={formData.description} 
                  onChange={e => setFormData({...formData, description: e.target.value})} 
                  className="bg-background/50 border-white/10" 
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Calling Script</label>
                <select 
                  className="w-full flex h-10 w-full items-center justify-between rounded-md border border-white/10 bg-background/50 px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  value={formData.scriptId}
                  onChange={e => setFormData({...formData, scriptId: parseInt(e.target.value)})}
                  required
                >
                  <option value={0} disabled>Select a script...</option>
                  {scripts?.map(script => (
                    <option key={script.id} value={script.id}>{script.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Max Concurrent Calls</label>
                <Input 
                  type="number"
                  min="1"
                  max="10"
                  value={formData.maxConcurrentCalls} 
                  onChange={e => setFormData({...formData, maxConcurrentCalls: parseInt(e.target.value)})} 
                  className="bg-background/50 border-white/10" 
                />
                <p className="text-xs text-muted-foreground">Determines how many calls the agent can handle simultaneously.</p>
              </div>
              <div className="flex items-center justify-between p-3 border border-white/10 rounded-md bg-background/50">
                <div className="space-y-0.5">
                  <label className="text-sm font-medium">Automatic Dialing</label>
                  <p className="text-xs text-muted-foreground">Automatically call contacts without manual interaction.</p>
                </div>
                <input
                  type="checkbox"
                  checked={formData.isAutomatic}
                  onChange={e => setFormData({ ...formData, isAutomatic: e.target.checked })}
                  className="h-5 w-9 rounded-full bg-white/10 border border-white/10 checked:bg-primary transition-colors cursor-pointer appearance-none relative before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:transition-transform checked:before:translate-x-4"
                />
              </div>
              {formData.isAutomatic && (
                <div className="flex items-center justify-between p-3 border border-white/10 rounded-md bg-background/50">
                  <div className="space-y-0.5">
                    <label className="text-sm font-medium">Parallel Dialing</label>
                    <p className="text-xs text-muted-foreground">Call multiple contacts simultaneously up to the maximum concurrent calls limit.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={formData.dialParallel}
                    onChange={e => setFormData({ ...formData, dialParallel: e.target.checked })}
                    className="h-5 w-9 rounded-full bg-white/10 border border-white/10 checked:bg-primary transition-colors cursor-pointer appearance-none relative before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:transition-transform checked:before:translate-x-4"
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Max Retries</label>
                  <Input 
                    type="number"
                    min="0"
                    max="10"
                    value={formData.maxRetries} 
                    onChange={e => setFormData({...formData, maxRetries: parseInt(e.target.value) || 0})} 
                    className="bg-background/50 border-white/10" 
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Interval (minutes)</label>
                  <Input 
                    type="number"
                    min="1"
                    value={formData.retryIntervalMinutes} 
                    onChange={e => setFormData({...formData, retryIntervalMinutes: parseInt(e.target.value) || 1})} 
                    className="bg-background/50 border-white/10" 
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Select Contacts</label>
                <div className="border border-white/10 rounded-md p-3 max-h-40 overflow-y-auto space-y-2 bg-background/50">
                  {contacts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No contacts found. Please add contacts first.</p>
                  ) : (
                    contacts.map((contact) => {
                      const isChecked = formData.contactIds.includes(contact.id);
                      return (
                        <label key={contact.id} className="flex items-center space-x-2 text-sm cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              const newIds = isChecked
                                ? formData.contactIds.filter(id => id !== contact.id)
                                : [...formData.contactIds, contact.id];
                              setFormData({ ...formData, contactIds: newIds });
                            }}
                            className="rounded border-white/10 bg-background/50 text-primary focus:ring-primary focus:ring-offset-background"
                          />
                          <span>
                            {`${contact.firstName || ""} ${contact.lastName || ""}`.trim() || contact.phone}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
              <Button type="submit" className="w-full mt-4" disabled={createCampaign.isPending}>
                {createCampaign.isPending ? "Creating..." : "Create Campaign"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => <div key={i} className="h-64 bg-card border border-white/5 rounded-xl animate-pulse"></div>)}
        </div>
      ) : campaigns && campaigns.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {campaigns.map((campaign) => {
            const progress = campaign.totalContacts 
              ? Math.round(((campaign.calledCount || 0) / campaign.totalContacts) * 100) 
              : 0;

            return (
              <Card key={campaign.id} className="glass-panel border-white/5 hover:border-white/10 transition-all duration-300 group">
                <CardHeader className="pb-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-lg font-display">{campaign.name}</CardTitle>
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-1">{campaign.description || 'No description'}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={campaign.status} />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="w-8 h-8 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
                        onClick={async () => {
                          await refetch();
                          toast({ title: "Campaigns refreshed", description: "Fetched latest campaign metrics." });
                        }}
                        title="Refresh campaigns"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin text-primary" : ""}`} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="w-8 h-8 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
                        onClick={() => handleEditClick(campaign)}
                      >
                        <Edit className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground flex items-center"><Activity className="w-4 h-4 mr-1"/> Progress</span>
                      <span className="font-medium">{progress}%</span>
                    </div>
                    <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-primary transition-all duration-500" 
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-2.5 pt-2">
                    <div className="bg-white/5 rounded-lg p-2 text-center">
                      <p className="text-[10px] text-muted-foreground mb-1">Contacts</p>
                      <p className="text-base font-semibold">{campaign.totalContacts || 0}</p>
                    </div>
                    <div className="bg-white/5 rounded-lg p-2 text-center">
                      <p className="text-[10px] text-muted-foreground mb-1">Connected</p>
                      <p className="text-base font-semibold">{campaign.answeredCount || 0}</p>
                    </div>
                    <div className="bg-white/5 rounded-lg p-2 text-center">
                      <p className="text-[10px] text-muted-foreground mb-1">Dial Mode</p>
                      <p className="text-xs font-semibold text-primary mt-1">
                        {campaign.isAutomatic 
                          ? (campaign.dialParallel ? "Auto (Parallel)" : "Auto (Seq)") 
                          : "Manual"}
                      </p>
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="pt-2 border-t border-white/5 flex flex-col gap-2">
                  <div className="flex gap-2 w-full">
                    <Button 
                      variant={campaign.status === 'active' ? "outline" : "default"} 
                      className="flex-1 shadow-md"
                      onClick={() => handleAction(campaign.id, campaign.status)}
                      disabled={startCampaign.isPending || pauseCampaign.isPending}
                    >
                      {campaign.status === 'active' ? (
                        <><Pause className="w-4 h-4 mr-2" /> Pause</>
                      ) : (
                        <><Play className="w-4 h-4 mr-2" /> Activate</>
                      )}
                    </Button>
                    {campaign.status === 'active' && !campaign.isAutomatic && (
                      <Button
                        variant="default"
                        className="flex-1 bg-green-600 hover:bg-green-700 shadow-md"
                        onClick={() => handleDialNext(campaign.id)}
                        disabled={dialingCampaignId === campaign.id}
                      >
                        {dialingCampaignId === campaign.id ? (
                          <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Dialing...</>
                        ) : (
                          <><PhoneCall className="w-4 h-4 mr-2" /> Dial Next</>
                        )}
                      </Button>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    className="w-full shadow-md bg-white/5 border-white/10 hover:bg-white/10 gap-1.5"
                    onClick={() => {
                      setSelectedPerformanceCampaign(campaign);
                      setSelectedCallDetails(null);
                    }}
                  >
                    <Activity className="w-4 h-4" /> Performance &amp; Logs
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="glass-panel border-white/5">
          <div className="p-16 text-center flex flex-col items-center justify-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Megaphone className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-xl font-medium text-foreground">No active campaigns</h3>
            <p className="text-muted-foreground mt-2 max-w-sm">
              Create a campaign, assign a script and contact list, and let your AI agent start dialing.
            </p>
            <Button className="mt-6" onClick={() => setIsDialogOpen(true)}>
              Create First Campaign
            </Button>
          </div>
        </Card>
      )}

      <Dialog open={editingCampaign !== null} onOpenChange={(open) => !open && setEditingCampaign(null)}>
        <DialogContent className="glass-panel sm:max-w-[500px] border-white/10">
          <DialogHeader>
            <DialogTitle>Edit Campaign</DialogTitle>
          </DialogHeader>
          {editingCampaign && (
            <form onSubmit={handleEditSubmit} className="space-y-4 mt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Campaign Name</label>
                <Input 
                  required 
                  value={editFormData.name} 
                  onChange={e => setEditFormData({...editFormData, name: e.target.value})} 
                  className="bg-background/50 border-white/10" 
                  placeholder="Q4 Outreach"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Description</label>
                <Input 
                  value={editFormData.description} 
                  onChange={e => setEditFormData({...editFormData, description: e.target.value})} 
                  className="bg-background/50 border-white/10" 
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Calling Script</label>
                <select 
                  className="w-full flex h-10 w-full items-center justify-between rounded-md border border-white/10 bg-background/50 px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  value={editFormData.scriptId}
                  onChange={e => setEditFormData({...editFormData, scriptId: parseInt(e.target.value)})}
                  required
                >
                  <option value={0} disabled>Select a script...</option>
                  {scripts?.map(script => (
                    <option key={script.id} value={script.id}>{script.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Max Concurrent Calls</label>
                <Input 
                  type="number"
                  min="1"
                  max="10"
                  value={editFormData.maxConcurrentCalls} 
                  onChange={e => setEditFormData({...editFormData, maxConcurrentCalls: parseInt(e.target.value)})} 
                  className="bg-background/50 border-white/10" 
                />
                <p className="text-xs text-muted-foreground">Determines how many calls the agent can handle simultaneously.</p>
              </div>
              <div className="flex items-center justify-between p-3 border border-white/10 rounded-md bg-background/50">
                <div className="space-y-0.5">
                  <label className="text-sm font-medium">Automatic Dialing</label>
                  <p className="text-xs text-muted-foreground">Automatically call contacts without manual interaction.</p>
                </div>
                <input
                  type="checkbox"
                  checked={editFormData.isAutomatic}
                  onChange={e => setEditFormData({ ...editFormData, isAutomatic: e.target.checked })}
                  className="h-5 w-9 rounded-full bg-white/10 border border-white/10 checked:bg-primary transition-colors cursor-pointer appearance-none relative before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:transition-transform checked:before:translate-x-4"
                />
              </div>
              {editFormData.isAutomatic && (
                <div className="flex items-center justify-between p-3 border border-white/10 rounded-md bg-background/50">
                  <div className="space-y-0.5">
                    <label className="text-sm font-medium">Parallel Dialing</label>
                    <p className="text-xs text-muted-foreground">Call multiple contacts simultaneously up to the maximum concurrent calls limit.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={editFormData.dialParallel}
                    onChange={e => setEditFormData({ ...editFormData, dialParallel: e.target.checked })}
                    className="h-5 w-9 rounded-full bg-white/10 border border-white/10 checked:bg-primary transition-colors cursor-pointer appearance-none relative before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:transition-transform checked:before:translate-x-4"
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Max Retries</label>
                  <Input 
                    type="number"
                    min="0"
                    max="10"
                    value={editFormData.maxRetries} 
                    onChange={e => setEditFormData({...editFormData, maxRetries: parseInt(e.target.value) || 0})} 
                    className="bg-background/50 border-white/10" 
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Interval (minutes)</label>
                  <Input 
                    type="number"
                    min="1"
                    value={editFormData.retryIntervalMinutes} 
                    onChange={e => setEditFormData({...editFormData, retryIntervalMinutes: parseInt(e.target.value) || 1})} 
                    className="bg-background/50 border-white/10" 
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Select Contacts</label>
                <div className="border border-white/10 rounded-md p-3 max-h-40 overflow-y-auto space-y-2 bg-background/50">
                  {contacts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No contacts found. Please add contacts first.</p>
                  ) : (
                    contacts.map((contact) => {
                      const isChecked = editFormData.contactIds.includes(contact.id);
                      return (
                        <label key={contact.id} className="flex items-center space-x-2 text-sm cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              const newIds = isChecked
                                ? editFormData.contactIds.filter(id => id !== contact.id)
                                : [...editFormData.contactIds, contact.id];
                              setEditFormData({ ...editFormData, contactIds: newIds });
                            }}
                            className="rounded border-white/10 bg-background/50 text-primary focus:ring-primary focus:ring-offset-background"
                          />
                          <span>
                            {`${contact.firstName || ""} ${contact.lastName || ""}`.trim() || contact.phone}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
              <Button type="submit" className="w-full mt-4" disabled={updateCampaign.isPending}>
                {updateCampaign.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Campaign Performance & Logs Dialog */}
      <Dialog 
        open={selectedPerformanceCampaign !== null} 
        onOpenChange={(open) => {
          if (!open) {
            setSelectedPerformanceCampaign(null);
            setSelectedCallDetails(null);
          }
        }}
      >
        <DialogContent className="glass-panel max-w-6xl border-white/10 h-[85vh] flex flex-col p-6 overflow-hidden">
          <DialogHeader className="pb-4 border-b border-white/5 flex flex-row items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-lg text-primary">
                <Activity className="w-5 h-5" />
              </div>
              <div>
                <DialogTitle className="text-xl font-display font-semibold flex items-center gap-2">
                  {selectedPerformanceCampaign?.name} Performance
                  {selectedPerformanceCampaign && (
                    <StatusBadge status={selectedPerformanceCampaign.status} />
                  )}
                </DialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {selectedPerformanceCampaign?.description || "No description"}
                </p>
              </div>
            </div>
            
            {/* Quick Metrics Header Row */}
            <div className="flex gap-6 text-sm mr-6">
              <div className="text-center">
                <span className="text-xs text-muted-foreground block">Total Contacts</span>
                <span className="font-semibold">{selectedPerformanceCampaign?.totalContacts || 0}</span>
              </div>
              <div className="text-center">
                <span className="text-xs text-muted-foreground block">Dialed</span>
                <span className="font-semibold text-amber-400">{selectedPerformanceCampaign?.calledCount || 0}</span>
              </div>
              <div className="text-center">
                <span className="text-xs text-muted-foreground block">Connected</span>
                <span className="font-semibold text-emerald-400">{selectedPerformanceCampaign?.answeredCount || 0}</span>
              </div>
              <div className="text-center">
                <span className="text-xs text-muted-foreground block">Mode</span>
                <span className="font-semibold text-primary">{selectedPerformanceCampaign?.isAutomatic ? "Auto" : "Manual"}</span>
              </div>
            </div>
          </DialogHeader>

          {/* Dialog Body - Split Pane */}
          <div className="flex flex-1 gap-6 min-h-0 mt-4">
            {/* Left Pane: Calls List */}
            <div className="w-1/3 border-r border-white/5 pr-4 flex flex-col min-h-0">
              <h3 className="text-sm font-semibold mb-3 flex items-center justify-between text-muted-foreground">
                <span>Call Logs</span>
                {loadingCalls && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
              </h3>
              
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {campaignCalls.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-4">
                    <PhoneOutgoing className="w-8 h-8 text-muted-foreground/30 mb-2" />
                    <p className="text-sm text-muted-foreground font-medium">No calls placed yet</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">
                      {selectedPerformanceCampaign?.status === 'active' 
                        ? "Waiting for the first dial..."
                        : "Activate the campaign to start dialing."}
                    </p>
                  </div>
                ) : (
                  campaignCalls.map((call) => {
                    const isSelected = selectedCallDetails?.id === call.id;
                    const contactName = call.displayName || call.phone;
                    const dateStr = new Date(call.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const isActive = !call.endedAt;
                    
                    return (
                      <div
                        key={call.id}
                        onClick={() => setSelectedCallDetails(call)}
                        className={`p-3 rounded-lg border transition-all cursor-pointer flex justify-between items-center ${
                          isSelected
                            ? "bg-primary/10 border-primary/30 text-white"
                            : "bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/10 text-muted-foreground hover:text-white"
                        }`}
                      >
                        <div className="space-y-1">
                          <p className="text-sm font-medium line-clamp-1">{contactName}</p>
                          <div className="flex items-center gap-1.5 text-xs">
                            <span>{dateStr}</span>
                            {call.duration && <span>· {call.duration}s</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isActive ? (
                            <span className="flex h-2 w-2 relative">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                            </span>
                          ) : (
                            <StatusBadge status={call.outcome || 'unknown'} className="text-[10px] px-1.5 py-0.5" />
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right Pane: Selected Call Details */}
            <div className="flex-1 flex flex-col min-h-0">
              {!selectedCallDetails ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 bg-white/5 rounded-xl border border-white/5">
                  <Bot className="w-12 h-12 text-primary/30 mb-3" />
                  <p className="text-base font-semibold">No Call Selected</p>
                  <p className="text-sm text-muted-foreground mt-1 max-w-xs">
                    Select a call from the log list on the left to view the live transcript, summary, and cost breakdown.
                  </p>
                </div>
              ) : (
                <div className="flex-1 flex flex-col min-h-0 space-y-4">
                  {/* Call Stats Grid */}
                  <div className="grid grid-cols-4 gap-4 p-4 bg-white/5 rounded-xl border border-white/5 font-sans">
                    <div>
                      <p className="text-[10px] text-muted-foreground font-medium">Phone Number</p>
                      <p className="text-sm font-medium mt-0.5">{selectedCallDetails.phone}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground font-medium">Call Status</p>
                      <div className="mt-0.5 flex items-center gap-2">
                        {!selectedCallDetails.endedAt ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse"></span>
                            Live Call
                          </span>
                        ) : (
                          <StatusBadge status={selectedCallDetails.outcome || 'unknown'} className="text-[10px]" />
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground font-medium">Duration</p>
                      <p className="text-sm font-medium mt-0.5">
                        {selectedCallDetails.duration ? `${selectedCallDetails.duration}s` : "In progress..."}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground font-medium">Estimated Cost</p>
                      <p className="text-sm font-mono font-semibold text-emerald-400 mt-0.5">
                        {selectedCallDetails.estimatedCostUsd 
                          ? `$${parseFloat(selectedCallDetails.estimatedCostUsd).toFixed(4)}`
                          : "$0.0000"}
                      </p>
                    </div>
                  </div>

                  {/* Transcript and Live Chat view */}
                  <div className="flex-1 flex flex-col min-h-0 bg-white/5 rounded-xl border border-white/5 overflow-hidden">
                    <div className="p-4 border-b border-white/5 bg-black/20 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Mic className="w-4 h-4 text-primary" />
                        <h4 className="text-sm font-semibold font-display">
                          {!selectedCallDetails.endedAt ? "Live Call Transcript" : "Call Transcript"}
                        </h4>
                      </div>
                      {!selectedCallDetails.endedAt && (
                        <span className="text-xs text-primary animate-pulse flex items-center gap-1.5 font-medium font-sans">
                          <Loader2 className="w-3 h-3 animate-spin" /> Stream active
                        </span>
                      )}
                    </div>
                    
                    <div className="flex-1 overflow-y-auto p-4 space-y-4 font-sans text-sm min-h-0 bg-black/40">
                      {selectedCallDetails.liveTranscript && Array.isArray(selectedCallDetails.liveTranscript) && selectedCallDetails.liveTranscript.length > 0 ? (
                        selectedCallDetails.liveTranscript.map((turn: any, index: number) => {
                          const isAgent = turn.role === "agent" || turn.role === "assistant" || turn.role === "system";
                          return (
                            <div key={index} className={`flex ${isAgent ? "justify-start" : "justify-end"}`}>
                              <div className={`max-w-[80%] rounded-xl px-4 py-2.5 ${
                                isAgent 
                                  ? "bg-primary/20 text-white border border-primary/20 rounded-tl-none" 
                                  : "bg-white/10 text-white border border-white/5 rounded-tr-none"
                              }`}>
                                <p className="text-[10px] text-muted-foreground mb-1 font-semibold">
                                  {isAgent ? "AI Agent" : "Customer"}
                                </p>
                                <p className="leading-relaxed font-sans">{turn.content}</p>
                              </div>
                            </div>
                          );
                        })
                      ) : selectedCallDetails.transcript ? (
                        <div className="p-3 bg-black/30 rounded border border-white/5 font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
                          {selectedCallDetails.transcript}
                        </div>
                      ) : (
                        <div className="h-full flex flex-col items-center justify-center text-center p-6">
                          <Mic className="w-8 h-8 text-muted-foreground/30 mb-2 animate-pulse" />
                          <p className="text-sm text-muted-foreground font-sans">Transcript is empty</p>
                          <p className="text-xs text-muted-foreground/60 mt-1 font-sans">
                            {!selectedCallDetails.endedAt 
                              ? "Waiting for caller to speak..." 
                              : "No transcript recorded for this call."}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
