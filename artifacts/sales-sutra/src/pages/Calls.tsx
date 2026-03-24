import React from "react";
import { useCallsList } from "@/hooks/use-calls";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/ui-custom/StatusBadge";
import { format } from "date-fns";
import { Phone, PhoneIncoming, PhoneOutgoing, Clock, Mic } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export default function Calls() {
  const { data, isLoading } = useCallsList({ limit: 50 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold">Call Logs</h1>
        <p className="text-muted-foreground mt-1">Review transcripts and AI summaries of all conversations.</p>
      </div>

      <Card className="glass-panel border-white/5">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground animate-pulse">Loading calls...</div>
          ) : data?.calls && data.calls.length > 0 ? (
            <Table>
              <TableHeader className="bg-white/5">
                <TableRow className="border-white/5 hover:bg-transparent">
                  <TableHead className="w-[50px]"></TableHead>
                  <TableHead className="text-muted-foreground">Contact</TableHead>
                  <TableHead className="text-muted-foreground">Date & Time</TableHead>
                  <TableHead className="text-muted-foreground">Duration</TableHead>
                  <TableHead className="text-muted-foreground">Outcome</TableHead>
                  <TableHead className="text-right text-muted-foreground">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.calls.map((call) => (
                  <TableRow key={call.id} className="border-white/5 hover:bg-white/5 transition-colors">
                    <TableCell>
                      {call.direction === 'inbound' ? (
                        <PhoneIncoming className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <PhoneOutgoing className="w-4 h-4 text-primary" />
                      )}
                    </TableCell>
                    <TableCell className="font-medium text-foreground">
                      <div>
                        {call.contact?.firstName || call.contact?.lastName 
                          ? `${call.contact?.firstName || ''} ${call.contact?.lastName || ''}` 
                          : 'Unknown'}
                      </div>
                      <div className="text-xs text-muted-foreground font-normal">{call.phone}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(call.startedAt), 'MMM d, yyyy h:mm a')}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <div className="flex items-center">
                        <Clock className="w-3 h-3 mr-1" />
                        {call.duration}s
                      </div>
                    </TableCell>
                    <TableCell><StatusBadge status={call.outcome || 'unknown'} /></TableCell>
                    <TableCell className="text-right">
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="sm" className="hover:bg-white/10">View details</Button>
                        </DialogTrigger>
                        <DialogContent className="glass-panel sm:max-w-[600px] border-white/10 max-h-[80vh] overflow-y-auto">
                          <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                              <Phone className="w-5 h-5 text-primary" /> 
                              Call Details
                            </DialogTitle>
                          </DialogHeader>
                          <div className="space-y-6 mt-4">
                            <div className="grid grid-cols-2 gap-4 p-4 bg-white/5 rounded-xl border border-white/5">
                              <div>
                                <p className="text-xs text-muted-foreground">Contact</p>
                                <p className="font-medium">{call.phone}</p>
                              </div>
                              <div>
                                <p className="text-xs text-muted-foreground">Outcome</p>
                                <StatusBadge status={call.outcome || 'unknown'} className="mt-1" />
                              </div>
                              <div>
                                <p className="text-xs text-muted-foreground">Duration</p>
                                <p className="font-medium">{call.duration}s</p>
                              </div>
                              <div>
                                <p className="text-xs text-muted-foreground">Time</p>
                                <p className="font-medium">{format(new Date(call.startedAt), 'PPp')}</p>
                              </div>
                            </div>
                            
                            {call.aiSummary && (
                              <div className="space-y-2">
                                <h4 className="font-semibold flex items-center gap-2">
                                  <Bot className="w-4 h-4 text-primary" /> AI Summary
                                </h4>
                                <div className="p-4 bg-primary/5 border border-primary/20 rounded-xl text-sm leading-relaxed">
                                  {call.aiSummary}
                                </div>
                              </div>
                            )}

                            {call.transcript && (
                              <div className="space-y-2">
                                <h4 className="font-semibold flex items-center gap-2">
                                  <Mic className="w-4 h-4" /> Full Transcript
                                </h4>
                                <div className="p-4 bg-black/40 border border-white/5 rounded-xl text-sm leading-relaxed font-mono text-muted-foreground whitespace-pre-wrap">
                                  {call.transcript}
                                </div>
                              </div>
                            )}
                          </div>
                        </DialogContent>
                      </Dialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-16 text-center">
              <Phone className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">No calls logged yet</p>
              <p className="text-muted-foreground mt-1">When your agent makes or receives calls, they will appear here.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
