import { useState } from "react";
import { ArrowLeft, CircleHelp, Save } from "lucide-react";
import { PreparationTools } from "@/preparation-tools";
import { useWorkbench } from "@/workbench-context";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/workbench-controls";
export function ToolsWorkspace() {
  const {
    job,
    state,
    online,
    pending,
    dirty,
    post,
    section,
    navigate,
    openUtility,
    jobGeneration,
    savePackage,
  } = useWorkbench();
  const [message, setMessage] = useState("");
  return (
    <div className="page-scroll tools-workspace">
      <div className="page-heading">
        <div>
          <h1>Workshop tools</h1>
          <p>Optional checks and calculations for the job you are preparing.</p>
        </div>
        <div className="actions">
          <Button
            variant="outline"
            disabled={!online || pending || dirty || !job?.hasContent}
            onClick={() => void savePackage()}
          >
            <Save />
            Save job package
          </Button>
          <Button variant="ghost" onClick={() => navigate("guide")}>
            <ArrowLeft />
            Back to job
          </Button>
        </div>
      </div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          {job?.name || "Current job"} · Records are saved in the job package.
        </span>
        <Button variant="ghost" size="sm" onClick={() => openUtility("help")}>
          <CircleHelp />
          When to use these tools
        </Button>
      </div>
      {state?.offline && (
        <Notice>
          Offline preparation: calculations and planning records are available.
          Machine-dependent draft generation requires a configured machine
          workspace.
        </Notice>
      )}
      {dirty && (
        <Notice tone="warning">
          Apply the pending job edits before running a calculation against the
          saved setup.
        </Notice>
      )}
      <PreparationTools
        key={jobGeneration}
        job={job}
        disabled={!online || pending || !!state?.busy || dirty}
        post={post}
        section={section}
        onMessage={setMessage}
      />
      <p role="status" className="sr-only">
        {message}
      </p>
    </div>
  );
}
