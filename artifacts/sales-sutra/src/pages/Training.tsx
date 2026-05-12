import React, { useState, useRef, useCallback } from "react";
import { useTrainingList, useAddTrainingDataMutation, useDeleteTrainingDataMutation, useDeleteAllTrainingDataMutation } from "@/hooks/use-training";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, BrainCircuit, FileText, Upload, Loader2, CheckCircle2, FileJson, File, Eye, ExternalLink, Video, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";

const TYPE_LABELS: Record<string, string> = {
  product_info: "Product Info",
  faq: "FAQ",
  objection_handling: "Objection Handling",
  competitor_info: "Competitor Info",
  video_link: "Video Link",
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

// Extract YouTube links from content text
function extractYouTubeLinks(content: string): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  const regex = /(Suggested YouTube \(([^)]+)\):\s*)?(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+)/gi;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const label = match[2] || "YouTube";
    links.push({ label: label.trim(), url: match[3] });
  }
  return links;
}

// Strip YouTube suggestion lines from the display content
function stripVideoLines(content: string): string {
  return content
    .replace(/Suggested YouTube \([^)]+\):\s*https?:\/\/\S+/gi, "")
    .replace(/Rule: Suggest at most one best-fit video[^\n]*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Parse video_link JSON content for display
function parseVideoLinkContent(content: string): { title: string; link_en: string; link_kn: string; search_terms: string[] } | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.title === "string") return parsed;
  } catch { }
  return null;
}

export default function Training() {
  const { data: trainingData, isLoading } = useTrainingList();
  const addTraining = useAddTrainingDataMutation();
  const deleteTraining = useDeleteTrainingDataMutation();
  const deleteAll = useDeleteAllTrainingDataMutation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any | null>(null);
  const [isDeleteAllOpen, setIsDeleteAllOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const CONFIRM_PHRASE = "delete all training data";
  const canConfirmDelete = deleteConfirmText.trim().toLowerCase() === CONFIRM_PHRASE;

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
        <div className="flex items-center gap-3">
          {trainingData && trainingData.length > 0 && (
            <Button
              variant="outline"
              className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
              onClick={() => { setDeleteConfirmText(""); setIsDeleteAllOpen(true); }}
            >
              <Trash2 className="w-4 h-4 mr-2" /> Delete All ({trainingData.length})
            </Button>
          )}
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
      </div>

      <UploadZone onUploaded={handleUploaded} />

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-40 bg-card border border-white/5 rounded-xl animate-pulse"></div>)}
        </div>
      ) : trainingData && trainingData.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {trainingData.map((item) => (
            <Card
              key={item.id}
              className="glass-panel border-white/5 hover:border-primary/30 transition-all duration-200 group cursor-pointer hover:shadow-lg hover:shadow-primary/5"
              onClick={() => setViewItem(item)}
            >
              <CardHeader className="pb-2">
                <div className="flex justify-between items-start">
                  <div className="min-w-0 flex-1 pr-2">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="text-xs uppercase tracking-wider text-primary font-semibold">
                        {TYPE_LABELS[item.type] ?? item.type.replace(/_/g, " ")}
                      </div>
                      {item.type === "video_link" && (
                        <Video className="w-3 h-3 text-rose-400" />
                      )}
                    </div>
                    <CardTitle className="text-base leading-snug">{item.title}</CardTitle>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/60">
                      <Eye className="w-4 h-4" />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-rose-400 hover:bg-rose-400/10"
                      onClick={(e) => { e.stopPropagation(); deleteTraining.mutateAsync(item.id); }}
                      disabled={deleteTraining.isPending}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {item.type === "video_link" ? (() => {
                  const vl = parseVideoLinkContent(item.content);
                  return vl ? (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">Video tutorial: <span className="text-foreground font-medium">{vl.title}</span></p>
                      <div className="flex flex-wrap gap-1.5">
                        {vl.link_en && <Badge variant="secondary" className="text-xs gap-1"><Video className="w-3 h-3" /> EN</Badge>}
                        {vl.link_kn && <Badge variant="secondary" className="text-xs gap-1"><Video className="w-3 h-3" /> KN</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground/60">{(vl.search_terms || []).length} search terms</p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground line-clamp-4 leading-relaxed whitespace-pre-line">{item.content}</p>
                  );
                })() : (
                  <>
                    <p className="text-sm text-muted-foreground line-clamp-4 leading-relaxed whitespace-pre-line">
                      {item.content}
                    </p>
                    {extractYouTubeLinks(item.content).length > 0 && (
                      <div className="flex items-center gap-1.5 mt-2">
                        <Video className="w-3.5 h-3.5 text-rose-400" />
                        <span className="text-xs text-rose-400 font-medium">{extractYouTubeLinks(item.content).length} video{extractYouTubeLinks(item.content).length > 1 ? "s" : ""} attached</span>
                      </div>
                    )}
                  </>
                )}
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
      {/* ── Delete All Confirmation (GitHub-style) ────────────────────── */}
      <Dialog open={isDeleteAllOpen} onOpenChange={setIsDeleteAllOpen}>
        <DialogContent className="glass-panel sm:max-w-[480px] border-rose-500/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-400">
              <AlertTriangle className="w-5 h-5" />
              Delete all training data
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 p-3">
              <p className="text-sm text-rose-300 font-medium">
                This action cannot be undone. This will permanently delete{" "}
                <span className="font-bold text-rose-200">
                  {trainingData?.length ?? 0} training {(trainingData?.length ?? 0) === 1 ? "entry" : "entries"}
                </span>{" "}
                including all FAQs, video links, and knowledge base content.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">
                To confirm, type <span className="font-mono font-bold text-foreground">delete all training data</span> below:
              </label>
              <Input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="delete all training data"
                className="border-white/10 bg-background/50 font-mono text-sm"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button
                variant="outline"
                className="border-white/10"
                onClick={() => setIsDeleteAllOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={!canConfirmDelete || deleteAll.isPending}
                className={!canConfirmDelete ? "opacity-50 cursor-not-allowed" : ""}
                onClick={async () => {
                  try {
                    const result = await deleteAll.mutateAsync();
                    toast({
                      title: "All training data deleted",
                      description: `Removed ${result.deleted} entries.`,
                    });
                    setIsDeleteAllOpen(false);
                    setDeleteConfirmText("");
                  } catch (err: any) {
                    toast({
                      title: "Error",
                      description: err.message,
                      variant: "destructive",
                    });
                  }
                }}
              >
                {deleteAll.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting...</>
                ) : (
                  <><Trash2 className="w-4 h-4 mr-2" /> Delete all training data</>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Detail View Modal ────────────────────────────────────── */}
      <Dialog open={!!viewItem} onOpenChange={(open) => { if (!open) setViewItem(null); }}>
        <DialogContent className="glass-panel sm:max-w-[700px] border-white/10 max-h-[85vh] flex flex-col">
          {viewItem && (() => {
            const isVideoLink = viewItem.type === "video_link";
            const videoLinkData = isVideoLink ? parseVideoLinkContent(viewItem.content) : null;
            const ytLinks = !isVideoLink ? extractYouTubeLinks(viewItem.content) : [];
            const cleanContent = !isVideoLink ? stripVideoLines(viewItem.content) : viewItem.content;

            return (
              <>
                <DialogHeader className="shrink-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-xs border-primary/30 text-primary uppercase tracking-wider">
                      {TYPE_LABELS[viewItem.type] ?? viewItem.type.replace(/_/g, " ")}
                    </Badge>
                    {isVideoLink && <Badge variant="secondary" className="text-xs gap-1"><Video className="w-3 h-3" /> Video</Badge>}
                    <span className="text-xs text-muted-foreground/50 ml-auto">
                      Added {format(new Date(viewItem.createdAt), 'MMM d, yyyy')}
                    </span>
                  </div>
                  <DialogTitle className="text-lg leading-snug pr-6">
                    {viewItem.title}
                  </DialogTitle>
                </DialogHeader>

                <ScrollArea className="flex-1 min-h-0 -mx-6 px-6">
                  <div className="space-y-4 pb-4">
                    {/* Video Link detail view */}
                    {isVideoLink && videoLinkData && (
                      <div className="space-y-4">
                        <div className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3">
                          <h4 className="text-sm font-semibold text-foreground">Video Links</h4>
                          <div className="space-y-2">
                            {videoLinkData.link_en && (
                              <a
                                href={videoLinkData.link_en}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-3 p-3 rounded-lg bg-white/5 hover:bg-primary/10 border border-white/10 hover:border-primary/30 transition-all group/link"
                              >
                                <div className="w-10 h-10 rounded-lg bg-rose-500/15 flex items-center justify-center shrink-0">
                                  <Video className="w-5 h-5 text-rose-400" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium text-foreground">English Video</p>
                                  <p className="text-xs text-muted-foreground truncate">{videoLinkData.link_en}</p>
                                </div>
                                <ExternalLink className="w-4 h-4 text-muted-foreground group-hover/link:text-primary transition-colors shrink-0" />
                              </a>
                            )}
                            {videoLinkData.link_kn && (
                              <a
                                href={videoLinkData.link_kn}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-3 p-3 rounded-lg bg-white/5 hover:bg-primary/10 border border-white/10 hover:border-primary/30 transition-all group/link"
                              >
                                <div className="w-10 h-10 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
                                  <Video className="w-5 h-5 text-amber-400" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium text-foreground">Kannada Video</p>
                                  <p className="text-xs text-muted-foreground truncate">{videoLinkData.link_kn}</p>
                                </div>
                                <ExternalLink className="w-4 h-4 text-muted-foreground group-hover/link:text-primary transition-colors shrink-0" />
                              </a>
                            )}
                          </div>
                        </div>

                        {(videoLinkData.search_terms?.length ?? 0) > 0 && (
                          <div className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-2">
                            <h4 className="text-sm font-semibold text-foreground">Search Terms ({videoLinkData.search_terms.length})</h4>
                            <div className="flex flex-wrap gap-1.5">
                              {videoLinkData.search_terms.map((term: string, i: number) => (
                                <Badge key={i} variant="secondary" className="text-xs font-normal">
                                  {term}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* FAQ / Knowledge content view */}
                    {!isVideoLink && (
                      <>
                        <div className="rounded-xl bg-white/5 border border-white/10 p-4">
                          <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-line">
                            {cleanContent}
                          </p>
                        </div>

                        {ytLinks.length > 0 && (
                          <div className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-2">
                            <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                              <Video className="w-4 h-4 text-rose-400" />
                              Attached Videos
                            </h4>
                            <div className="space-y-2">
                              {ytLinks.map((link, i) => (
                                <a
                                  key={i}
                                  href={link.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-3 p-3 rounded-lg bg-white/5 hover:bg-primary/10 border border-white/10 hover:border-primary/30 transition-all group/link"
                                >
                                  <div className="w-9 h-9 rounded-lg bg-rose-500/15 flex items-center justify-center shrink-0">
                                    <Video className="w-4 h-4 text-rose-400" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-foreground">{link.label} Video</p>
                                    <p className="text-xs text-muted-foreground truncate">{link.url}</p>
                                  </div>
                                  <ExternalLink className="w-4 h-4 text-muted-foreground group-hover/link:text-primary transition-colors shrink-0" />
                                </a>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </ScrollArea>

                <div className="flex justify-between items-center pt-3 border-t border-white/10 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-rose-400 hover:bg-rose-400/10"
                    onClick={() => { deleteTraining.mutateAsync(viewItem.id); setViewItem(null); }}
                    disabled={deleteTraining.isPending}
                  >
                    <Trash2 className="w-4 h-4 mr-2" /> Delete
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-white/10"
                    onClick={() => setViewItem(null)}
                  >
                    Close
                  </Button>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
