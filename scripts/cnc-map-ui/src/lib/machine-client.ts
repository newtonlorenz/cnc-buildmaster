/** One transport and one authoritative snapshot. UI preferences never grant machine authority. */
export interface AgentRequest {
  requestId: string;
  action: string;
  parameters: Record<string, unknown>;
  reason: string;
  status:
    | "pending"
    | "running"
    | "dispatched"
    | "interrupted"
    | "completed"
    | "failed"
    | "rejected"
    | "expired"
    | "stale";
  createdAt: string | number;
  expiresAt: string | number;
  sessionId: string;
  pcbRevision: number;
  result?: unknown;
  error?: string | { code: string; message: string; retryable: boolean };
}
export interface AgentState {
  prepareEnabled: boolean;
  jobGeneration: number;
  requests: AgentRequest[];
}
export interface Hold {
  id: string;
  sessionId: string;
  axis: "x" | "y" | "z";
  sign: number;
  key: string | null;
  speed: string;
  timer: ReturnType<typeof setInterval> | null;
}
export interface ClientSnapshot {
  state: any;
  job: any;
  online: boolean;
  pending: boolean;
  error: string | null;
  activeHold: Hold | null;
  jobGeneration: number;
}
type Receive = (result: any) => void;
export class MachineClient {
  private snapshot: ClientSnapshot = {
    state: null,
    job: null,
    online: false,
    pending: false,
    error: null,
    activeHold: null,
    jobGeneration: 0,
  };
  private listeners = new Set<() => void>();
  private headers: Record<string, string>;
  private pollTask: Promise<void> | null = null;
  private jobTask: Promise<void> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private connectionError = false;
  private evidenceKey = "";
  private appliedAgentGeneration: number | undefined;
  private stopped = false;
  constructor(token: string, clientId: string) {
    this.headers = {
      Authorization: `Bearer ${token}`,
      "X-Client-ID": clientId,
      "Content-Type": "application/json",
    };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  private update(patch: Partial<ClientSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  setError = (message: string | null) => {
    this.connectionError = false;
    this.update({ error: message || null });
  };
  private async request(
    path: string,
    body?: Record<string, unknown>,
    timeout = 25000,
  ) {
    const response = await fetch("/api/" + path, {
      headers: this.headers,
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  start() {
    this.stopped = false;
    void this.poll();
    this.interval = setInterval(() => {
      if (!document.hidden) void this.poll();
    }, 750);
  }
  dispose() {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.releaseHold();
  }
  async refreshJob(fresh = false): Promise<void> {
    if (this.jobTask) {
      await this.jobTask;
      if (fresh) return this.refreshJob();
      return;
    }
    this.jobTask = (async () => {
      try {
        const generation = this.snapshot.state?.agent?.jobGeneration;
        const job = await this.request("pcb", undefined, 10000);
        if (!this.stopped) {
          const replaced =
            typeof generation === "number" &&
            this.appliedAgentGeneration !== undefined &&
            generation !== this.appliedAgentGeneration &&
            generation === this.snapshot.state?.agent?.jobGeneration &&
            job.revision === this.snapshot.state?.pcbRevision;
          // Reset replacement fields with the new job, never with the previous
          // geometry while its replacement is still being fetched.
          if (replaced) this.appliedAgentGeneration = generation;
          this.update({
            job,
            ...(replaced
              ? { jobGeneration: this.snapshot.jobGeneration + 1 }
              : {}),
          });
        }
      } catch (e) {
        this.setError("Job workspace: " + message(e));
      }
    })();
    try {
      await this.jobTask;
    } finally {
      this.jobTask = null;
    }
  }
  async poll(fresh = false): Promise<void> {
    if (this.pollTask) {
      await this.pollTask;
      if (fresh) return this.poll();
      return;
    }
    if (this.stopped) return;
    const task = (async () => {
      try {
        const state = await this.request("state", undefined, 2000);
        if (state.apiVersion !== 7)
          throw new Error(
            "Restart the server with ./cnc-map restart and open its new link",
          );
        if (this.stopped) return;
        if (
          this.snapshot.state &&
          (this.snapshot.state.sessionId !== state.sessionId ||
            state.agent?.prepareEnabled)
        )
          this.releaseHold();
        if (this.appliedAgentGeneration === undefined)
          this.appliedAgentGeneration = state.agent?.jobGeneration;
        const agentJobChanged =
          typeof state.agent?.jobGeneration === "number" &&
          state.agent.jobGeneration !== this.appliedAgentGeneration;
        const patch: Partial<ClientSnapshot> = { state, online: true };
        if (this.connectionError) {
          patch.error = null;
          this.connectionError = false;
        }
        this.update(patch);
        const evidenceKey = JSON.stringify([
          state.phase,
          state.mapSource?.fingerprint,
          state.result?.path,
          state.handoff?.sha256,
        ]);
        if (
          !this.snapshot.job ||
          agentJobChanged ||
          state.pcbRevision !== this.snapshot.job.revision ||
          evidenceKey !== this.evidenceKey
        ) {
          this.evidenceKey = evidenceKey;
          // Geometry can be expensive. Never put it in the machine heartbeat's
          // critical path; job writes still await a fresh revision separately.
          void this.refreshJob(agentJobChanged);
        }
      } catch (e) {
        this.releaseHold();
        this.connectionError = true;
        this.update({
          online: false,
          error:
            "Connection unavailable: " + message(e) + ". Controls are locked.",
        });
      }
    })();
    this.pollTask = task;
    try {
      await task;
    } finally {
      if (this.pollTask === task) this.pollTask = null;
    }
  }
  call = async (
    action: string,
    body: Record<string, unknown> = {},
    receive?: Receive,
  ): Promise<boolean> => {
    const stop = action === "stop";
    if (
      this.snapshot.state?.agent?.prepareEnabled &&
      !["stop", "agent-access", "agent-decide", "diagnostics"].includes(action)
    ) {
      this.setError(
        "Pause agent editing before editing the job or using machine controls.",
      );
      return false;
    }
    if (this.snapshot.pending && !stop) return false;
    if (!this.snapshot.online && !stop) {
      this.setError("Connection unavailable. Controls are locked.");
      return false;
    }
    if (!stop) this.update({ pending: true });
    let success = false;
    try {
      const data = await this.request(action, {
        ...body,
        sessionId: this.snapshot.state?.sessionId,
      });
      this.setError(null);
      if (["pcb-new", "pcb-load", "pcb-example"].includes(action))
        this.update({ jobGeneration: this.snapshot.jobGeneration + 1 });
      receive?.(data.result);
      success = true;
    } catch (e) {
      if (action === "jog-hold") this.releaseHold();
      this.setError(message(e));
    } finally {
      await this.poll(true);
      if (success && (action.startsWith("pcb-") || action === "agent-access"))
        await this.refreshJob(true);
      if (!stop) this.update({ pending: false });
    }
    return success;
  };
  post = async (
    action: string,
    body: Record<string, unknown> = {},
    receive?: Receive,
  ) => {
    if (!this.snapshot.job) return false;
    return this.call(
      action,
      { ...body, pcbRevision: this.snapshot.job.revision },
      receive,
    );
  };
  stop = () => {
    this.releaseHold();
    return this.call("stop");
  };
  jog = (
    axis: "x" | "y" | "z",
    sign: number,
    distance: number,
    speed: string,
  ) => {
    const s = this.snapshot;
    if (
      !s.online ||
      s.pending ||
      s.state?.agent?.prepareEnabled ||
      !s.state?.armed ||
      s.state.busy ||
      s.state.phase !== "teach" ||
      (axis === "z" && s.state.corners.length)
    )
      return Promise.resolve(false);
    return this.call("jog", {
      axis,
      delta: sign * (axis === "z" ? Math.min(distance, 1) : distance),
      speed,
    });
  };
  startHold = (
    axis: "x" | "y" | "z",
    sign: number,
    key: string | null,
    speed: string,
  ) => {
    const s = this.snapshot;
    if (
      s.activeHold ||
      s.pending ||
      s.state?.agent?.prepareEnabled ||
      !s.online ||
      !s.state?.armed ||
      s.state.busy ||
      s.state.phase !== "teach" ||
      !s.state.nativeJog ||
      (axis === "z" && s.state.corners.length)
    )
      return;
    const hold: Hold = {
      id: crypto.randomUUID(),
      sessionId: s.state.sessionId,
      axis,
      sign,
      key,
      speed,
      timer: null,
    };
    this.update({ activeHold: hold });
    hold.timer = setInterval(() => {
      if (this.snapshot.activeHold === hold)
        void this.holdControl("jog-pulse", hold);
    }, 150);
    // The HTTP response acknowledges the background worker, not the end of motion.
    void this.call("jog-hold", { axis, delta: sign, id: hold.id, speed });
  };
  private async holdControl(action: string, hold: Hold) {
    try {
      await this.request(
        action,
        { id: hold.id, sessionId: hold.sessionId },
        1000,
      );
    } catch (e) {
      if (this.snapshot.activeHold === hold) {
        this.releaseHold();
        this.setError("Held jog stopped: " + message(e));
      }
    }
  }
  releaseHold = () => {
    const hold = this.snapshot.activeHold;
    if (!hold) return;
    this.update({ activeHold: null });
    if (hold.timer) clearInterval(hold.timer);
    // Release has its own transport: never queue behind the still-running hold request.
    void this.holdControl("jog-release", hold);
  };
  recoverOwnership = async () => {
    if (this.snapshot.pending) return false;
    this.releaseHold();
    this.update({ pending: true });
    try {
      await this.request("recover-session", { confirmed: true });
      this.setError(null);
      await this.poll(true);
      await this.refreshJob(true);
      return this.snapshot.online;
    } catch (error) {
      this.setError(message(error));
      return false;
    } finally {
      this.update({ pending: false });
    }
  };
  report = () => this.request("report", undefined, 3000);
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The request could not finish";
}
