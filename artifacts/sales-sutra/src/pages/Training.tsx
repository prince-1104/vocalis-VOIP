import React, { useState } from "react";
import { useTrainingList, useAddTrainingDataMutation, useDeleteTrainingDataMutation } from "@/hooks/use-training";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Trash2, Plus, BrainCircuit, FileText } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

export default function Training() {
  const { data: trainingData, isLoading } = useTrainingList();
  const addTraining = useAddTrainingDataMutation();
  const deleteTraining = useDeleteTrainingDataMutation();
  const { toast } = useToast();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const [formData, setFormData] = useState({
    type: "product_info",
    title: "",
    content: ""
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await addTraining.mutateAsync(formData as any);
      toast({ title: "Training data added" });
      setIsDialogOpen(false);
      setFormData({ type: "product_info", title: "", content: "" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-display font-bold">Knowledge Base</h1>
          <p className="text-muted-foreground mt-1">Train your AI agent on your products, FAQs, and handling objections.</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/25">
              <Plus className="w-4 h-4 mr-2" /> Add Knowledge
            </Button>
          </DialogTrigger>
          <DialogContent className="glass-panel sm:max-w-[600px] border-white/10">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <BrainCircuit className="w-5 h-5 text-primary" /> Train Agent
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4 mt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Information Type</label>
                <select 
                  value={formData.type}
                  onChange={e => setFormData({...formData, type: e.target.value})}
                  className="w-full flex h-10 items-center justify-between rounded-md border border-white/10 bg-background/50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="product_info">Product/Service Info</option>
                  <option value="faq">Frequently Asked Question (FAQ)</option>
                  <option value="objection_handling">Objection Handling</option>
                  <option value="competitor_info">Competitor Information</option>
                  <option value="custom">Custom Instruction</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Title / Question</label>
                <Input 
                  required 
                  value={formData.title} 
                  onChange={e => setFormData({...formData, title: e.target.value})} 
                  className="bg-background/50 border-white/10" 
                  placeholder="e.g. What is our refund policy?"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Content / Answer</label>
                <Textarea 
                  required
                  value={formData.content} 
                  onChange={e => setFormData({...formData, content: e.target.value})} 
                  className="bg-background/50 border-white/10 min-h-[150px]" 
                  placeholder="We offer a 30-day money-back guarantee no questions asked..."
                />
              </div>
              <Button type="submit" className="w-full mt-4" disabled={addTraining.isPending}>
                {addTraining.isPending ? "Saving..." : "Add to Knowledge Base"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-40 bg-card border border-white/5 rounded-xl animate-pulse"></div>)}
        </div>
      ) : trainingData && trainingData.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {trainingData.map((item) => (
            <Card key={item.id} className="glass-panel border-white/5 hover:border-white/10 transition-colors group">
              <CardHeader className="pb-2">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-primary font-semibold mb-1">
                      {item.type.replace('_', ' ')}
                    </div>
                    <CardTitle className="text-lg">{item.title}</CardTitle>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-rose-400 hover:bg-rose-400/10"
                    onClick={() => deleteTraining.mutateAsync(item.id)}
                    disabled={deleteTraining.isPending}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground line-clamp-3 leading-relaxed">
                  {item.content}
                </p>
                <p className="text-xs text-muted-foreground/50 mt-4">
                  Added {format(new Date(item.createdAt), 'MMM d, yyyy')}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="glass-panel border-white/5">
          <div className="p-16 text-center flex flex-col items-center justify-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <FileText className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-xl font-medium text-foreground">Knowledge Base is Empty</h3>
            <p className="text-muted-foreground mt-2 max-w-sm">
              Your AI agent needs to learn about your business. Add product details, FAQs, and sales scripts to get started.
            </p>
            <Button className="mt-6" onClick={() => setIsDialogOpen(true)}>
              Add First Document
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
