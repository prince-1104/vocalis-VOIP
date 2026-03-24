import React, { useState } from "react";
import { useContactsList, useCreateContactMutation } from "@/hooks/use-contacts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui-custom/StatusBadge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { format } from "date-fns";
import { Search, Plus, Upload, UserPlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Contacts() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useContactsList({ limit: 50, search: search || undefined });
  const createContact = useCreateContactMutation();
  const { toast } = useToast();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    company: ""
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createContact.mutateAsync(formData);
      toast({ title: "Contact added successfully" });
      setIsDialogOpen(false);
      setFormData({ firstName: "", lastName: "", phone: "", email: "", company: "" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Contacts</h1>
          <p className="text-muted-foreground mt-1">Manage your leads and call lists.</p>
        </div>
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="Search contacts..." 
              className="pl-9 bg-card border-white/10"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button variant="outline" className="bg-card border-white/10">
            <Upload className="w-4 h-4 mr-2" /> Import
          </Button>
          
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/25">
                <Plus className="w-4 h-4 mr-2" /> Add Contact
              </Button>
            </DialogTrigger>
            <DialogContent className="glass-panel sm:max-w-[425px] border-white/10">
              <DialogHeader>
                <DialogTitle>Add New Contact</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">First Name</label>
                    <Input 
                      value={formData.firstName} 
                      onChange={e => setFormData({...formData, firstName: e.target.value})} 
                      className="bg-background/50 border-white/10" 
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Last Name</label>
                    <Input 
                      value={formData.lastName} 
                      onChange={e => setFormData({...formData, lastName: e.target.value})} 
                      className="bg-background/50 border-white/10" 
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Phone Number *</label>
                  <Input 
                    required 
                    value={formData.phone} 
                    onChange={e => setFormData({...formData, phone: e.target.value})} 
                    className="bg-background/50 border-white/10" 
                    placeholder="+1 (555) 000-0000"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Email</label>
                  <Input 
                    type="email" 
                    value={formData.email} 
                    onChange={e => setFormData({...formData, email: e.target.value})} 
                    className="bg-background/50 border-white/10" 
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Company</label>
                  <Input 
                    value={formData.company} 
                    onChange={e => setFormData({...formData, company: e.target.value})} 
                    className="bg-background/50 border-white/10" 
                  />
                </div>
                <Button type="submit" className="w-full mt-4" disabled={createContact.isPending}>
                  {createContact.isPending ? "Adding..." : "Save Contact"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card className="glass-panel border-white/5">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground animate-pulse">Loading contacts...</div>
          ) : data?.contacts && data.contacts.length > 0 ? (
            <Table>
              <TableHeader className="bg-white/5">
                <TableRow className="border-white/5 hover:bg-transparent">
                  <TableHead className="text-muted-foreground">Name</TableHead>
                  <TableHead className="text-muted-foreground">Phone</TableHead>
                  <TableHead className="text-muted-foreground">Company</TableHead>
                  <TableHead className="text-muted-foreground">Status</TableHead>
                  <TableHead className="text-muted-foreground text-right">Added</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.contacts.map((contact) => (
                  <TableRow key={contact.id} className="border-white/5 hover:bg-white/5 transition-colors">
                    <TableCell className="font-medium text-foreground">
                      {contact.firstName || contact.lastName ? `${contact.firstName || ''} ${contact.lastName || ''}` : 'Unknown'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{contact.phone}</TableCell>
                    <TableCell className="text-muted-foreground">{contact.company || '-'}</TableCell>
                    <TableCell><StatusBadge status={contact.status} /></TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {format(new Date(contact.createdAt), 'MMM d, yyyy')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-16 text-center flex flex-col items-center justify-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <UserPlus className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-xl font-medium text-foreground">No contacts yet</h3>
              <p className="text-muted-foreground mt-2 max-w-sm">
                Add your first contact manually or import a CSV to start building your campaign list.
              </p>
              <Button className="mt-6" onClick={() => setIsDialogOpen(true)}>
                Add First Contact
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
