import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { useWorkbench } from "@/workbench-context";
import type { AgentRequest, AgentState } from "@/lib/machine-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckField, Notice, Panel } from "@/components/workbench-controls";

// Request prose is untrusted text. Never interpret HTML, render credentials or
// permit an approval if the complete action parameters cannot be inspected.
function bounded(value: unknown, limit: number) {
  let redacted = false;
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(
          value,
          (key, item) => {
            if (/token|secret|password|credential|authorization/i.test(key)) {
              redacted = true;
              return "[credential hidden]";
            }
            return item;
          },
          2,
        ) ?? "—");
  const safe = text.replace(
    /\bBearer\s+\S+|(?:--?(?:token|password|secret|api[-_]?key)|(?:token|password|secret|api[-_]?key)\s*[=:])\s*[^\s,}]+/gi,
    () => {
      redacted = true;
      return "[credential hidden]";
    },
  );
  return {
    text: safe.length > limit ? safe.slice(0, limit) + "… [truncated]" : safe,
    incomplete: redacted || safe.length > limit,
  };
}
function timestamp(value: string | number) {
  return typeof value === "number"
    ? value < 1e12
      ? value * 1000
      : value
    : Date.parse(value);
}
function dateLabel(value: string | number) {
  const time = timestamp(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleString()
    : "Unavailable";
}

export function AgentAccessBanner() {
  const { state, online, pending, call, openUtility } = useWorkbench();
  const agent = state?.agent as AgentState | undefined;
  const count =
    agent?.requests.filter((request) => request.status === "pending").length ??
    0;
  if (!agent?.prepareEnabled && !count) return null;
  return (
    <div className="border-b bg-muted/40 px-4 py-3" data-testid="agent-banner">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm">
          <Bot className="size-4 shrink-0" />
          {agent?.prepareEnabled
            ? "Agent preparation is active. Local job editing and machine controls are locked."
            : `${count} agent request${count === 1 ? "" : "s"} awaiting your review.`}
        </p>
        <div className="flex flex-wrap gap-2">
          {agent?.prepareEnabled && (
            <Button
              size="sm"
              variant="outline"
              disabled={!online || pending}
              onClick={() => void call("agent-access", { enabled: false })}
            >
              Pause agent editing
            </Button>
          )}
          {!!count && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => openUtility("agents")}
            >
              Review requests <Badge variant="secondary">{count}</Badge>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentAccess() {
  const { state, online, pending, dirty, activeHold, call } = useWorkbench();
  const agent = state?.agent as AgentState | undefined;
  const enabled = agent?.prepareEnabled === true;
  const enableLocked =
    !agent ||
    !online ||
    pending ||
    dirty ||
    !!activeHold ||
    !["setup", "stopped"].includes(state?.phase) ||
    !!state?.armed ||
    !!state?.busy ||
    !!state?.continuityActive;
  const requests = agent?.requests ?? [];
  return (
    <div className="space-y-5" id="agentAccess">
      <Panel
        title="Agent preparation"
        action={
          <Badge variant={enabled ? "secondary" : "outline"}>
            {enabled ? "Active" : "Paused"}
          </Badge>
        }
      >
        <div className="space-y-3 text-sm">
          <p>
            A local agent can use the CLI or MCP connection to inspect this
            workbench and request bounded actions. Preparation access starts
            off.
          </p>
          <p>
            Enable preparation to let the agent edit digital files and job
            configuration. This mode cannot move the machine. The job workspaces
            stay locked until you pause agent editing.
          </p>
          <p>
            Machine requests need your separate review here. Puck placement and
            probe-contact readiness stay in the existing human controls in Jog
            &amp; surface.
          </p>
          <Button
            id="agentPrepare"
            variant={enabled ? "outline" : "default"}
            disabled={enabled ? !online || pending : enableLocked}
            onClick={() => void call("agent-access", { enabled: !enabled })}
          >
            {enabled ? "Pause agent editing" : "Enable agent preparation"}
          </Button>
          {!enabled && enableLocked && (
            <p className="field-help">
              Enable only with an online, idle setup: apply or discard local
              edits, finish pending actions, and clear armed controls and
              reference continuity first.
            </p>
          )}
          {!agent && (
            <Notice>Agent access is unavailable from this server.</Notice>
          )}
        </div>
      </Panel>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Action requests</h3>
        <p className="text-sm text-muted-foreground">
          Inspect the exact action and parameters before approval. The server
          checks the current session, job revision and expiry again when you
          decide.
        </p>
        {!requests.length && (
          <p className="text-sm text-muted-foreground">
            No agent requests in this session.
          </p>
        )}
        {requests.map((request) => (
          <RequestReview key={request.requestId} request={request} />
        ))}
      </div>
    </div>
  );
}

function RequestReview({ request }: { request: AgentRequest }) {
  const { state, job, client, online, pending, dirty, activeHold, call } =
    useWorkbench();
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (request.status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.status]);
  const action = bounded(request.action, 160);
  const parameters = bounded(request.parameters, 8000);
  const reason = bounded(request.reason, 500);
  const reviewKey = JSON.stringify([
    request,
    state?.sessionId,
    state?.pcbRevision,
    state?.agent?.prepareEnabled,
    state?.busy,
    dirty,
    online,
    state?.phase,
    state?.status?.state,
    state?.status?.machineCoord,
    state?.planId,
    state?.corners,
    state?.probeMode,
    state?.jobSetupEpoch,
  ]);
  useEffect(() => setConfirmedFor(null), [reviewKey]);
  const confirmed = confirmedFor === reviewKey;
  const pendingRequest = request.status === "pending";
  const current =
    request.sessionId === state?.sessionId &&
    request.pcbRevision === state?.pcbRevision &&
    job?.revision === state?.pcbRevision;
  const expired =
    !Number.isFinite(timestamp(request.expiresAt)) ||
    now >= timestamp(request.expiresAt);
  const humanReadiness =
    /^(ready|surface[-_]?ready|puck[-_]?ready|contact[-_]?ready)$/i.test(
      request.action,
    );
  const approveLocked =
    !online ||
    pending ||
    dirty ||
    !!activeHold ||
    !!state?.agent?.prepareEnabled ||
    !!state?.busy ||
    !pendingRequest ||
    !current ||
    expired ||
    action.incomplete ||
    parameters.incomplete ||
    humanReadiness;
  async function decide(approve: boolean) {
    const fresh = client.getSnapshot();
    const latest = (
      fresh.state?.agent as AgentState | undefined
    )?.requests.find((item) => item.requestId === request.requestId);
    if (!fresh.online || fresh.pending || latest?.status !== "pending") return;
    if (
      approve &&
      (approveLocked ||
        !confirmed ||
        fresh.state?.busy ||
        fresh.activeHold ||
        fresh.state?.agent?.prepareEnabled ||
        fresh.state?.sessionId !== request.sessionId ||
        fresh.state?.pcbRevision !== request.pcbRevision ||
        Date.now() >= timestamp(request.expiresAt))
    )
      return;
    setConfirmedFor(null);
    // Browser session authentication only. Never submit decisions through AI tools.
    await call("agent-decide", {
      requestId: request.requestId,
      approve,
      operatorConfirmed: approve && confirmed,
    });
  }
  return (
    <article
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4"
      data-request-id={request.requestId}
      aria-label={`Request ${action.text}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="break-all font-mono text-sm font-semibold">
          {action.text}
        </h4>
        <Badge variant="outline" data-testid="request-status">
          {request.status === "interrupted"
            ? "Interrupted — inspect machine state"
            : request.status === "dispatched"
              ? "Submitted"
              : request.status}
        </Badge>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{reason.text}</p>
      <pre
        aria-label="Exact action parameters"
        className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"
      >
        {parameters.text}
      </pre>
      <dl className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        <dt>Job revision</dt>
        <dd>{request.pcbRevision}</dd>
        <dt>Created</dt>
        <dd>{dateLabel(request.createdAt)}</dd>
        <dt>Expires</dt>
        <dd>{dateLabel(request.expiresAt)}</dd>
      </dl>
      {request.error && (
        <Notice tone="error">
          {
            bounded(
              typeof request.error === "string"
                ? request.error
                : request.error.message,
              1600,
            ).text
          }
        </Notice>
      )}
      {request.status === "dispatched" && (
        <p className="text-xs text-muted-foreground">
          The server accepted this action for execution. Submission does not
          confirm completion or the physical outcome. Inspect machine status and
          stay at the machine.
        </p>
      )}
      {request.status === "completed" && (
        <p className="text-xs text-muted-foreground">
          The server reports this request completed. Verify the physical outcome
          at the machine.
        </p>
      )}
      {pendingRequest && (
        <>
          {(!current || expired) && (
            <Notice tone="warning">
              This request no longer matches the current job/session or its
              review time has elapsed. Request a fresh action.
            </Notice>
          )}
          {(action.incomplete || parameters.incomplete) && (
            <Notice tone="warning">
              The complete action cannot be displayed. Reject this request and
              ask for smaller parameters without credentials.
            </Notice>
          )}
          {humanReadiness && (
            <Notice tone="warning">
              Confirm puck placement and contact readiness yourself in Jog &amp;
              surface.
            </Notice>
          )}
          <CheckField
            label="I inspected the machine and clearance for this exact action."
            checked={confirmed}
            disabled={approveLocked}
            onCheckedChange={(value) =>
              setConfirmedFor(value === true ? reviewKey : null)
            }
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={approveLocked || !confirmed}
              onClick={() => void decide(true)}
              onKeyDown={(event) => {
                if (event.repeat && ["Enter", " "].includes(event.key))
                  event.preventDefault();
              }}
            >
              Approve
            </Button>
            <Button
              variant="outline"
              disabled={!online || pending}
              onClick={() => void decide(false)}
            >
              Reject
            </Button>
          </div>
          {(dirty || state?.agent?.prepareEnabled || state?.busy) && (
            <p className="field-help">
              Pause agent editing, apply or discard local edits and wait for the
              machine to be idle before approval.
            </p>
          )}
        </>
      )}
    </article>
  );
}
