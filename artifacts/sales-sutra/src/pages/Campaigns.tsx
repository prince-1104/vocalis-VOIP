import React, { useState } from "react";
import { useCampaignsList, useCreateCampaignMutation, useStartCampaignMutation, usePauseCampaignMutation, useUpdateCampaignMutation } from "@/hooks/use-campaigns";
import { useScriptsList } from "@/hooks/use-scripts";
import { useContactsList } from "@/hooks/use-contacts";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui-custom/StatusBadge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Megaphone, Play, Pause, PhoneCall, Loader2, Activity, Users, Edit } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export default function Campaigns() {
  const { data: campaigns, isLoading } = useCampaignsList();
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
    isAutomatic: false,
    contactIds: [] as number[]
  });

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    scriptId: 0,
    maxConcurrentCalls: 1,
    isAutomatic: false,
    contactIds: [] as number[]
  });

  const handleEditClick = (campaign: any) => {
    setEditingCampaign(campaign);
    setEditFormData({
      name: campaign.name,
      description: campaign.description || "",
      scriptId: campaign.scriptId || 0,
      maxConcurrentCalls: campaign.maxConcurrentCalls || 1,
      isAutomatic: campaign.isAutomatic || false,
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
      setFormData({ name: "", description: "", scriptId: 0, maxConcurrentCalls: 1, isAutomatic: false, contactIds: [] });
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
        await startCampaign.mutateAsync(id);
        toast({ title: "Campaign activated — use Dial Next to start calling." });
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
                  <p className="text-xs text-muted-foreground">Automatically call the next contact sequentially.</p>
                </div>
                <input
                  type="checkbox"
                  checked={formData.isAutomatic}
                  onChange={e => setFormData({ ...formData, isAutomatic: e.target.checked })}
                  className="h-5 w-9 rounded-full bg-white/10 border border-white/10 checked:bg-primary transition-colors cursor-pointer appearance-none relative before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:transition-transform checked:before:translate-x-4"
                />
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
                      <p className="text-xs font-semibold text-primary mt-1">{campaign.isAutomatic ? "Auto" : "Manual"}</p>
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="pt-2 border-t border-white/5 gap-2">
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
                  {campaign.status === 'active' && (
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
                  <p className="text-xs text-muted-foreground">Automatically call the next contact sequentially.</p>
                </div>
                <input
                  type="checkbox"
                  checked={editFormData.isAutomatic}
                  onChange={e => setEditFormData({ ...editFormData, isAutomatic: e.target.checked })}
                  className="h-5 w-9 rounded-full bg-white/10 border border-white/10 checked:bg-primary transition-colors cursor-pointer appearance-none relative before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:h-3.5 before:w-3.5 before:rounded-full before:bg-white before:transition-transform checked:before:translate-x-4"
                />
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
    </div>
  );
}
