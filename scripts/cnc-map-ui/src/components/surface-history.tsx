import { useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { NativeSelectOption } from "@/components/ui/native-select";
import { CheckField, SelectField } from "@/components/workbench-controls";
import { useWorkbench } from "@/workbench-context";

export function SurfaceHistory({ preview, onPreview }: { preview: any; onPreview: (record: any) => void }) {
  const { state, call, online, pending } = useWorkbench();
  const [open, setOpen] = useState(!!preview);
  const [chosen, setChosen] = useState(preview?.id ?? "");
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [state?.sessionId]);
  const records = state?.surfaceHistory ?? [];
  const locked = !online || pending || state?.busy || !!state?.agent?.prepareEnabled;
  return <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card" aria-label="Surface history">
    <CollapsibleTrigger asChild><Button id="historyToggle" variant="ghost" className="w-full justify-between">Previous teaching & scans <span className="text-muted-foreground">{records.length} saved{preview ? " · viewing history" : ""}</span></Button></CollapsibleTrigger>
    <CollapsibleContent className="p-4 pt-1 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="text-xs text-muted-foreground">Corners and partial measurements are saved automatically. Previewing never moves the machine.</p></div>
      {preview && <Button variant="outline" onClick={() => { onPreview(null); setConfirmed(false); }}>Return to current setup</Button>}
    </div>
    {state?.historyError && <p role="alert" className="text-sm text-destructive">{state.historyError}</p>}
    {records.length ? <div className="flex flex-wrap items-end gap-3">
      <SelectField id="surfaceHistory" label="Saved session" value={chosen} onChange={event => { setChosen(event.target.value); setConfirmed(false); }}>
        <NativeSelectOption value="">Choose a session…</NativeSelectOption>
        {records.map((record: any) => <NativeSelectOption key={record.id} value={record.id}>
          {new Date(record.updatedAt * 1000).toLocaleString()} · {record.phase} · {record.cornerCount} corners · {record.measurementCount} contacts{record.demo ? " · simulation" : ""}
        </NativeSelectOption>)}
      </SelectField>
      <Button id="previewHistory" variant="outline" disabled={locked || !chosen} onClick={() => void call("history-read", { id: chosen }, record => { onPreview(record); setConfirmed(false); setOpen(false); })}>Show on working area</Button>
    </div> : <p className="text-xs text-muted-foreground">Your first recorded corner will appear here. Simulation history lasts only for this server run.</p>}
    {preview && <div className="space-y-3 border-t pt-3">
      <p className="text-sm font-medium">Viewing saved {preview.phase} session · {preview.measurementCount} historical contacts</p>
      <p className="text-xs text-muted-foreground">This view is read-only. Reuse copies XY boundaries at the current Z; it does not restore a scan, work zero or verified alignment. After a reset or lost position, re-establish the original machine reference first.</p>
      <CheckField id="confirmHistory" label="Same workpiece and workholding; I have verified the same machine XY reference." checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} />
      <Button id="restoreHistory" disabled={locked || !confirmed || state?.phase !== "teach" || !state?.armed} onClick={() => void call("history-restore", { id: preview.id, confirmed }, () => { onPreview(null); setConfirmed(false); })}>Reuse these XY boundaries</Button>
      {state?.phase !== "teach" && <p className="text-xs text-muted-foreground">Start and enable a fresh teaching setup to reuse these boundaries.</p>}
    </div>}
  </CollapsibleContent></Collapsible>;
}
