import React, { useState } from "react";
import { useScriptsList, useCreateScriptMutation, useDeleteScriptMutation } from "@/hooks/use-scripts";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollText, Trash2, Edit, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Scripts() {
  const { data: scripts, isLoading } = useScriptsList();
  const createScript = useCreateScriptMutation();
  const deleteScript = useDeleteScriptMutation();
  const { toast } = useToast();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    openingLine: "",
    fullScript: "",
    closingLine: ""
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createScript.mutateAsync(formData);
      toast({ title: "Script saved successfully" });
      setIsDialogOpen(false);
      setFormData({ name: "", description: "", openingLine: "", fullScript: "", closingLine: "" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-display font-bold">Calling Scripts</h1>
          <p className="text-muted-foreground mt-1">Design the conversation flow for your outbound campaigns.</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/25">
              <Plus className="w-4 h-4 mr-2" /> New Script
            </Button>
          </DialogTrigger>
          <DialogContent className="glass-panel sm:max-w-[700px] border-white/10 max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Script Designer</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-5 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Script Name</label>
                  <Input 
                    required 
                    value={formData.name} 
                    onChange={e => setFormData({...formData, name: e.target.value})} 
                    className="bg-background/50 border-white/10" 
                    placeholder="B2B Cold Outreach"
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
              </div>
              
              <div className="space-y-2">
                <label className="text-sm font-medium text-emerald-400">Opening Line (Hook)</label>
                <Input 
                  required 
                  value={formData.openingLine} 
                  onChange={e => setFormData({...formData, openingLine: e.target.value})} 
                  className="bg-emerald-500/5 border-emerald-500/20" 
                  placeholder="Hi [Name], this is Alex from SalesSutra. I noticed..."
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Core Script / Pitch</label>
                <Textarea 
                  required
                  value={formData.fullScript} 
                  onChange={e => setFormData({...formData, fullScript: e.target.value})} 
                  className="bg-background/50 border-white/10 min-h-[200px]" 
                  placeholder="Write the main body of the conversation here. The AI will use this as a structural guide to handle the call..."
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-amber-400">Call to Action (Closing)</label>
                <Input 
                  value={formData.closingLine} 
                  onChange={e => setFormData({...formData, closingLine: e.target.value})} 
                  className="bg-amber-500/5 border-amber-500/20" 
                  placeholder="Does it make sense to schedule a quick 10-minute demo next week?"
                />
              </div>
              
              <Button type="submit" className="w-full mt-6" disabled={createScript.isPending}>
                {createScript.isPending ? "Saving..." : "Save Script"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2].map(i => <div key={i} className="h-64 bg-card border border-white/5 rounded-xl animate-pulse"></div>)}
        </div>
      ) : scripts && scripts.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {scripts.map((script) => (
            <Card key={script.id} className="glass-panel border-white/5 flex flex-col h-full">
              <CardHeader className="pb-3 border-b border-white/5">
                <CardTitle className="text-lg font-display flex items-center gap-2">
                  <ScrollText className="w-5 h-5 text-primary" /> {script.name}
                </CardTitle>
                <p className="text-sm text-muted-foreground">{script.description}</p>
              </CardHeader>
              <CardContent className="pt-4 flex-1">
                <div className="space-y-3 text-sm">
                  <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-3">
                    <span className="font-semibold text-emerald-400 text-xs uppercase block mb-1">Opening</span>
                    <p className="text-foreground">{script.openingLine}</p>
                  </div>
                  <div className="bg-white/5 border border-white/5 rounded-lg p-3">
                    <span className="font-semibold text-muted-foreground text-xs uppercase block mb-1">Core Pitch</span>
                    <p className="text-muted-foreground line-clamp-3">{script.fullScript}</p>
                  </div>
                  {script.closingLine && (
                    <div className="bg-amber-500/5 border border-amber-500/10 rounded-lg p-3">
                      <span className="font-semibold text-amber-400 text-xs uppercase block mb-1">Closing</span>
                      <p className="text-foreground">{script.closingLine}</p>
                    </div>
                  )}
                </div>
              </CardContent>
              <CardFooter className="pt-4 border-t border-white/5 flex justify-end gap-2">
                <Button variant="ghost" size="sm" className="hover:bg-white/10">
                  <Edit className="w-4 h-4 mr-2" /> Edit
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="text-rose-400 hover:text-rose-300 hover:bg-rose-400/10"
                  onClick={() => deleteScript.mutateAsync(script.id)}
                  disabled={deleteScript.isPending}
                >
                  <Trash2 className="w-4 h-4 mr-2" /> Delete
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="glass-panel border-white/5">
          <div className="p-16 text-center flex flex-col items-center justify-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <ScrollText className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-xl font-medium text-foreground">No Scripts Created</h3>
            <p className="text-muted-foreground mt-2 max-w-sm">
              Design the exact conversation flow you want your AI agent to follow on calls.
            </p>
            <Button className="mt-6" onClick={() => setIsDialogOpen(true)}>
              Design First Script
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
