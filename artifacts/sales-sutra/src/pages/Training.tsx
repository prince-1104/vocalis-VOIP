import React, { useState, useRef, useCallback } from "react";
import { useTrainingList, useAddTrainingDataMutation, useDeleteTrainingDataMutation } from "@/hooks/use-training";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Trash2, Plus, BrainCircuit, FileText, Upload, Loader2, CheckCircle2, FileJson, File } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";

const TYPE_LABELS: Record<string, string> = {
  product_info: "Product Info",
  faq: "FAQ",
  objection_handling: "Objection Handling",
  competitor_info: "Competitor Info",
  custom: "Custom",
};

function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "json") return <FileJson className="w-8 h-8 text-yellow-400" />;
  if (ext === "pdf") return <File className="w-8 h-8 text-rose-400" />;
  if (ext === "docx") return <File className="w-8 h-8 text-blue-400" />;
  return <FileText className="w-8 h-8 text-primary" />;
}

function UploadZone({ onUploaded }: { onUploaded: () => void }) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadType, setUploadType] = useState("product_info");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) setPendingFile(file);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setPendingFile(file);
  };

  const handleUpload = async () => {
    if (!pendingFile) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", pendingFile);
      form.append("type", uploadType);

      const token = localStorage.getItem("ss_auth_token");
      const res = await fetch("/api/training/upload", {
        method: "POST",
        body: form,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Upload failed");

      toast({
        title: "File imported!",
        description: result.message,
      });
      setPendingFile(null);
      if (inputRef.current) inputRef.current.value = "";
      onUploaded();
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const clearFile = () => {
    setPendingFile(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <Card className="glass-panel border-white/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Upload className="w-4 h-4 text-primary" /> Import from File
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          onClick={() => !pendingFile && inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`
            relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 transition-all duration-200 cursor-pointer select-none
            ${dragOver ? "border-primary bg-primary/10 scale-[1.01]" : "border-white/10 hover:border-primary/40 hover:bg-white/5"}
            ${pendingFile ? "pointer-events-none" : ""}
          `}
        >
          {pendingFile ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <FileIcon name={pendingFile.name} />
              <p className="font-medium text-foreground text-sm">{pendingFile.name}</p>
              <p className="text-xs text-muted-foreground">{(pendingFile.size / 1024).toFixed(1)} KB</p>
            </div>
          ) : (
            <>
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Upload className="w-5 h-5 text-primary" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">Drop a file here or click to browse</p>
                <p className="text-xs text-muted-foreground mt-1">Supports PDF, DOCX, JSON, TXT · Max 20 MB</p>
              </div>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,.json,.txt"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {pendingFile && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Classify as</label>
              <select
                value={uploadType}
                onChange={e => setUploadType(e.target.value)}
                className="w-full h-10 rounded-md border border-white/10 bg-background/50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="product_info">Product / Service Info</option>
                <option value="faq">FAQ</option>
                <option value="objection_handling">Objection Handling</option>
                <option value="competitor_info">Competitor Information</option>
                <option value="custom">Custom Instruction</option>
              </select>
            </div>
            <div className="flex gap-2">
              <Button
                className="flex-1 bg-primary hover:bg-primary/90"
                onClick={handleUpload}
                disabled={uploading}
              >
                {uploading ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing...</>
                ) : (
                  <><CheckCircle2 className="w-4 h-4 mr-2" /> Import File</>
                )}
              </Button>
              <Button variant="outline" className="border-white/10" onClick={clearFile} disabled={uploading}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Training() {
  const { data: trainingData, isLoading } = useTrainingList();
  const addTraining = useAddTrainingDataMutation();
  const deleteTraining = useDeleteTrainingDataMutation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
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

  const handleUploaded = () => {
    queryClient.invalidateQueries({ queryKey: ["training"] });
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
              <Plus className="w-4 h-4 mr-2" /> Add Manually
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

      <UploadZone onUploaded={handleUploaded} />

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
                  <div className="min-w-0 flex-1 pr-2">
                    <div className="text-xs uppercase tracking-wider text-primary font-semibold mb-1">
                      {TYPE_LABELS[item.type] ?? item.type.replace(/_/g, " ")}
                    </div>
                    <CardTitle className="text-base leading-snug">{item.title}</CardTitle>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-rose-400 hover:bg-rose-400/10 shrink-0"
                    onClick={() => deleteTraining.mutateAsync(item.id)}
                    disabled={deleteTraining.isPending}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground line-clamp-4 leading-relaxed whitespace-pre-line">
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
              Upload a PDF, DOCX, or JSON file — or add entries manually — to train your AI agent.
            </p>
            <div className="flex gap-3 mt-6">
              <Button onClick={() => setIsDialogOpen(true)}>
                <Plus className="w-4 h-4 mr-2" /> Add Manually
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
