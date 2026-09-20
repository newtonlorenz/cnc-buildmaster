import {
  Component,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Bot,
  Camera,
  CircleHelp,
  Command as CommandIcon,
  FileStack,
  Layers3,
  Monitor,
  Moon,
  Search,
  Settings2,
  Sun,
  Terminal,
  Wifi,
  WifiOff,
  X,
  Wrench,
  ChevronDown,
} from "lucide-react";
import { setNonce } from "get-nonce";
import { MachineClient } from "@/lib/machine-client";
import {
  WorkbenchContext,
  useWorkbench,
  downloadFile,
  formatNumber,
  type Workspace,
  type Appearance,
  type Utility,
  type JobPost,
} from "@/workbench-context";
import { JobGuide } from "@/job-guide";
import { SurfaceWorkspace } from "@/views/surface-workspace";
import { PcbWorkspace } from "@/views/pcb-workspace";
import { ToolsWorkspace } from "@/views/tools-workspace";
import { WorkbenchHelp } from "@/components/workbench-help";
import { AgentAccess, AgentAccessBanner } from "@/components/agent-access";
import { errorGuidance } from "@/lib/error-guidance";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { CameraView } from "@/views/camera-view";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Sidebar,
  SidebarProvider,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { StopButton, Notice } from "@/components/workbench-controls";

const sections = [
  {
    id: "guide" as const,
    label: "Job guide",
    icon: BookOpen,
    detail: "Prepare the next operation",
  },
  {
    id: "pcb" as const,
    label: "Files & alignment",
    icon: Layers3,
    detail: "Files, stock & alignment",
  },
  {
    id: "surface" as const,
    label: "Jog & surface",
    icon: Activity,
    detail: "Position & measure",
  },
  {
    id: "tools" as const,
    label: "Workshop tools",
    icon: Wrench,
    detail: "Optional checks & calculations",
  },
];
const styleNonce = document.querySelector<HTMLMetaElement>(
  'meta[name="csp-nonce"]',
)?.content;
if (styleNonce) setNonce(styleNonce);
const token =
  location.hash.slice(1) || sessionStorage.getItem("surface-token") || "";
if (token) sessionStorage.setItem("surface-token", token);
history.replaceState(null, "", location.pathname);
const clientId =
  sessionStorage.getItem("surface-client") || crypto.randomUUID();
sessionStorage.setItem("surface-client", clientId);
const client = new MachineClient(token, clientId);
function storedView(): Workspace {
  const view = sessionStorage.getItem("surface-workspace");
  return view === "pcb" || view === "surface" || view === "tools"
    ? view
    : "guide";
}
function storedAppearance(): Appearance {
  const value = localStorage.getItem("surface-theme");
  return value === "light" || value === "dark" ? value : "system";
}
function App() {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [view, setView] = useState<Workspace>(storedView),
    [section, setSection] = useState<string | null>(null),
    [appearance, setAppearance] = useState<Appearance>(storedAppearance);
  const visited = useRef(new Set<Workspace>([view]));
  const [utility, setUtility] = useState<Utility>(null),
    [commands, setCommands] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [dirtyKeys, setDirtyKeys] = useState<Record<string, boolean>>({});
  const [replacement, setReplacement] = useState<{
    action: string;
    body: Record<string, unknown>;
    receive?: (result: any) => void;
    resolve: (value: boolean) => void;
  } | null>(null);
  const files = useRef<HTMLInputElement>(null),
    packageFile = useRef<HTMLInputElement>(null);
  const dirty = Object.values(dirtyKeys).some(Boolean),
    modalOpen = !!utility || commands || mobileNav || !!replacement,
    agentEditing = snapshot.state?.agent?.prepareEnabled === true;
  function navigate(next: Workspace, target?: string) {
    client.releaseHold();
    visited.current.add(next);
    setView(next);
    setSection(target || null);
    sessionStorage.setItem("surface-workspace", next);
  }
  function openUtility(next: Utility) {
    client.releaseHold();
    setUtility(next);
  }
  useEffect(() => {
    client.start();
    return () => client.dispose();
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      const dark =
        appearance === "dark" || (appearance === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    update();
    media.addEventListener("change", update);
    localStorage.setItem("surface-theme", appearance);
    return () => media.removeEventListener("change", update);
  }, [appearance]);
  useEffect(() => {
    const release = () => client.releaseHold(),
      hidden = () => {
        if (document.hidden) release();
      },
      pointer = () => {
        if (!client.getSnapshot().activeHold?.key) release();
      },
      up = (event: KeyboardEvent) => {
        if (client.getSnapshot().activeHold?.key === event.key) {
          event.preventDefault();
          release();
        }
      },
      down = (event: KeyboardEvent) => {
        // A held Enter/Space on a focused Ready or capture button is one activation.
        // Native button repeat must never approve the next, newly-rendered probe prompt.
        if (
          event.repeat &&
          ["Enter", " "].includes(event.key) &&
          event.target instanceof Element &&
          event.target.closest("button,[role=button]")
        ) {
          event.preventDefault();
          return;
        }
        if (
          event.repeat &&
          (event.key === "Escape" ||
            ((event.metaKey || event.ctrlKey) &&
              event.key.toLowerCase() === "k"))
        ) {
          event.preventDefault();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          release();
          setCommands(false);
          setUtility(null);
          void client.stop();
          return;
        }
        if (
          event.key.toLowerCase() === "k" &&
          (event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          release();
          setCommands((open) => !open);
        }
      };
    window.addEventListener("blur", release);
    window.addEventListener("pagehide", release);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("pointerup", pointer);
    document.addEventListener("keyup", up);
    document.addEventListener("keydown", down, true);
    return () => {
      window.removeEventListener("blur", release);
      window.removeEventListener("pagehide", release);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("pointerup", pointer);
      document.removeEventListener("keyup", up);
      document.removeEventListener("keydown", down, true);
    };
  }, []);
  useEffect(() => {
    if (modalOpen) client.releaseHold();
  }, [modalOpen]);
  useEffect(
    () =>
      setDirtyKeys((previous) => ({
        "surface-drafts": !!previous["surface-drafts"],
      })),
    [snapshot.jobGeneration],
  );
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || snapshot.state?.armed || snapshot.state?.busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, snapshot.state?.armed, snapshot.state?.busy]);
  const post: JobPost = (action, body = {}, receive) => {
    if (client.getSnapshot().state?.agent?.prepareEnabled) {
      client.setError("Pause agent editing before changing the job.");
      return Promise.resolve(false);
    }
    if (
      ["pcb-new", "pcb-load", "pcb-example"].includes(action) &&
      (Object.entries(dirtyKeys).some(
        ([key, value]) => key !== "surface-drafts" && value,
      ) ||
        snapshot.job?.hasContent ||
        snapshot.job?.operations?.length)
    ) {
      client.releaseHold();
      if (replacement) return Promise.resolve(false);
      return new Promise((resolve) =>
        setReplacement({ action, body, receive, resolve }),
      );
    }
    return client.post(action, body, receive);
  };
  function cancelReplacement() {
    replacement?.resolve(false);
    setReplacement(null);
  }
  async function replaceJob() {
    const request = replacement;
    setReplacement(null);
    if (request)
      request.resolve(
        await client.post(request.action, request.body, request.receive),
      );
  }
  async function importFiles(list: FileList | null) {
    if (!list?.length) return;
    try {
      const selected = Array.from(list);
      if (
        selected.length > 12 ||
        selected.some((f) => f.size > 4 * 1024 * 1024) ||
        selected.reduce((n, f) => n + f.size, 0) > 16 * 1024 * 1024
      )
        throw Error(
          "Choose up to 12 CAM files, at most 4 MB each and 16 MB total.",
        );
      const revision = client.getSnapshot().job?.revision;
      const session = client.getSnapshot().state?.sessionId;
      const values = await Promise.all(
        selected.map(async (f) => ({ name: f.name, source: await f.text() })),
      );
      if (
        client.getSnapshot().job?.revision !== revision ||
        client.getSnapshot().state?.sessionId !== session
      )
        throw Error(
          "The job changed while the files were being read. Select them again for the current job.",
        );
      if (await client.post("pcb-import", { files: values })) navigate("pcb");
    } catch (error) {
      client.setError(
        error instanceof Error ? error.message : "Could not read the files.",
      );
    }
  }
  async function openPackage(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 24_000_000) throw Error("The job package exceeds 24 MB.");
      if (
        await post("pcb-load", {
          package: JSON.parse(await file.text()),
        })
      )
        navigate("pcb");
    } catch (error) {
      client.setError(
        error instanceof Error
          ? error.message
          : "Could not read the job package.",
      );
    }
  }
  const savePackage = () => {
    if (dirty) {
      client.setError(
        "Apply or discard the pending job edits before saving a package.",
      );
      return Promise.resolve(false);
    }
    return client.post("pcb-save", {}, (result) =>
      downloadFile(
        (String(snapshot.job?.name || "pcb-job").replace(
          /[^a-zA-Z0-9_-]+/g,
          "-",
        ) || "job") + ".pcb-job.json",
        JSON.stringify(result.package, null, 2),
      ),
    );
  };
  const pickFiles = () => {
      client.releaseHold();
      files.current?.click();
    },
    pickPackage = () => {
      client.releaseHold();
      packageFile.current?.click();
    };
  return (
    <WorkbenchContext.Provider
      value={{
        ...snapshot,
        client,
        post,
        call: client.call,
        view,
        navigate,
        section,
        modalOpen,
        openUtility,
        appearance,
        setAppearance,
        dirty,
        dirtyKeys,
        setDirty: (key, value) =>
          setDirtyKeys((previous) =>
            previous[key] === value ? previous : { ...previous, [key]: value },
          ),
        importFiles: pickFiles,
        openPackage: pickPackage,
        savePackage,
      }}
    >
      <TooltipProvider delayDuration={500}>
        <SidebarProvider defaultOpen className="application">
          <WorkbenchSidebar
            openUtility={openUtility}
            openCommands={() => {
              client.releaseHold();
              setCommands(true);
            }}
            onMobileChange={setMobileNav}
          />
          <SidebarInset className="application-main">
            <header className="app-header">
              <div className="header-location">
                <SidebarTrigger />
                <Separator orientation="vertical" className="!h-5" />
                <span className="header-project">Buildmaster</span>
                <span className="text-muted-foreground">/</span>
                <strong>{sections.find((s) => s.id === view)?.label}</strong>
              </div>
              <div className="header-actions">
                <Badge variant="outline" className="mode-badge">
                  {snapshot.state?.demo
                    ? "Simulation"
                    : snapshot.state?.offline
                      ? "Offline preparation"
                      : "Machine workspace"}
                </Badge>
                <StopButton id="stop" />
              </div>
            </header>
            {snapshot.error && (
              <div className="global-error">
                <Notice tone="error">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <strong>{errorGuidance(snapshot.error).title}</strong>
                      <p>{errorGuidance(snapshot.error).detail}</p>
                      <Collapsible>
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm" className="px-0">
                            Technical detail
                            <ChevronDown />
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <p id="error" className="break-words text-xs">
                            {snapshot.error}
                          </p>
                        </CollapsibleContent>
                      </Collapsible>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          openUtility(errorGuidance(snapshot.error!).utility)
                        }
                      >
                        {errorGuidance(snapshot.error).action}
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => client.setError(null)}
                      aria-label="Dismiss error"
                    >
                      Dismiss
                    </Button>
                  </div>
                </Notice>
              </div>
            )}
            <AgentAccessBanner />
            <main
              className="workspace-host"
              id="mainWorkspace"
              inert={agentEditing}
            >
              <section id="guideWorkspace" hidden={view !== "guide"}>
                <JobGuide />
              </section>
              <section id="pcbWorkspace" hidden={view !== "pcb"}>
                <PcbWorkspace active={view === "pcb" && !agentEditing} />
              </section>
              <section id="toolsWorkspace" hidden={view !== "tools"}>
                {visited.current.has("tools") && <ToolsWorkspace />}
              </section>
              <section id="surfaceWorkspace" hidden={view !== "surface"}>
                <SurfaceWorkspace
                  active={view === "surface" && !agentEditing}
                />
              </section>
            </main>
            <StatusBar openLog={() => openUtility("log")} />
          </SidebarInset>
          <UtilityDialog utility={utility} close={() => setUtility(null)} />
          <AlertDialog
            open={!!replacement}
            onOpenChange={(open) => {
              if (!open) cancelReplacement();
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Replace the current job?</AlertDialogTitle>
                <AlertDialogDescription>
                  {dirty
                    ? "You have unapplied edits. Replacing the job discards those edits. Cancel to apply and save them first."
                    : "Save a job package first if you need to keep this setup. Reopened jobs require fresh machine references."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <StopButton />
                <AlertDialogCancel onClick={cancelReplacement}>
                  Keep current job
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(event) => {
                    event.preventDefault();
                    void replaceJob();
                  }}
                >
                  Replace job
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Dialog
            open={commands}
            onOpenChange={(open) => {
              client.releaseHold();
              setCommands(open);
            }}
          >
            <DialogContent className="command-dialog">
              <DialogHeader>
                <DialogTitle>Find a workspace or tool</DialogTitle>
                <DialogDescription>
                  Navigation only. Machine actions stay in their workspace.
                </DialogDescription>
              </DialogHeader>
              <Command>
                <CommandInput
                  aria-label="Find a tool"
                  placeholder="Search tools…"
                />
                <CommandList>
                  <CommandEmpty>No matching tool.</CommandEmpty>
                  <CommandGroup heading="Workspaces">
                    {sections.map(({ id, label, icon: Icon }) => (
                      <CommandItem
                        key={id}
                        onSelect={() => {
                          navigate(id);
                          setCommands(false);
                        }}
                      >
                        <Icon />
                        {label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  <CommandGroup heading="Utilities">
                    {(
                      [
                        { id: "agents", label: "Agent access", icon: Bot },
                        {
                          id: "connection",
                          label: "Connection & configuration",
                          icon: Settings2,
                        },
                        { id: "camera", label: "Camera preview", icon: Camera },
                        { id: "log", label: "Session log", icon: Terminal },
                        { id: "help", label: "Workflow help", icon: BookOpen },
                        {
                          id: "shortcuts",
                          label: "Keyboard shortcuts",
                          icon: CircleHelp,
                        },
                      ] as const
                    ).map(({ id, label, icon: Icon }) => (
                      <CommandItem
                        key={id}
                        onSelect={() => {
                          setCommands(false);
                          openUtility(id);
                        }}
                      >
                        <Icon />
                        {label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
              <DialogFooter>
                <StopButton />
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Input
            ref={files}
            id="pcbFiles"
            type="file"
            accept=".nc,.gcode,.tap,.ngc,.cnc"
            multiple
            hidden
            onChange={(event) => {
              void importFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <Input
            ref={packageFile}
            id="pcbPackageFile"
            type="file"
            accept=".json"
            hidden
            onChange={(event) => {
              void openPackage(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </SidebarProvider>
      </TooltipProvider>
    </WorkbenchContext.Provider>
  );
}
function WorkbenchSidebar({
  openUtility,
  openCommands,
  onMobileChange,
}: {
  openUtility: (utility: Utility) => void;
  openCommands: () => void;
  onMobileChange: (open: boolean) => void;
}) {
  const { state, online, view, navigate, appearance, setAppearance, client } =
      useWorkbench(),
    { openMobile, setOpenMobile } = useSidebar();
  useEffect(() => {
    onMobileChange(openMobile);
    if (openMobile) client.releaseHold();
  }, [openMobile]);
  useEffect(() => {
    if (!openMobile) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMobile(false);
    };
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [openMobile, setOpenMobile]);
  const icon =
    appearance === "dark" ? (
      <Moon />
    ) : appearance === "light" ? (
      <Sun />
    ) : (
      <Monitor />
    );
  function select(action: () => void) {
    client.releaseHold();
    setOpenMobile(false);
    action();
  }
  return (
    <Sidebar collapsible="icon" className="workbench-sidebar">
      <SidebarHeader>
        <div className="brand">
          <div className="brand-mark">
            <Layers3 />
          </div>
          <div className="brand-copy">
            <strong>Buildmaster</strong>
            <span>CNC workbench</span>
          </div>
          {openMobile && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close navigation"
              className="ml-auto"
              onClick={() => setOpenMobile(false)}
            >
              <X />
            </Button>
          )}
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => select(openCommands)}
              tooltip="Find a tool"
            >
              <Search />
              <span>Find a tool</span>
              <kbd className="ml-auto">⌘ K</kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {sections.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    id={id + "Tab"}
                    isActive={view === id}
                    onClick={() => select(() => navigate(id))}
                    tooltip={label}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Machine &amp; tools</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {(
                [
                  { id: "agents", label: "Agent access", icon: Bot },
                  { id: "connection", label: "Connection", icon: Wifi },
                  { id: "camera", label: "Camera preview", icon: Camera },
                  { id: "log", label: "Session log", icon: Terminal },
                  { id: "help", label: "Workflow help", icon: BookOpen },
                  {
                    id: "shortcuts",
                    label: "Keyboard shortcuts",
                    icon: CircleHelp,
                  },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    tooltip={label}
                    onClick={() => select(() => openUtility(id))}
                  >
                    <Icon />
                    <span>{label}</span>
                    {id === "agents" &&
                      state?.agent?.requests?.some(
                        (request: { status: string }) =>
                          request.status === "pending",
                      ) && (
                        <Badge
                          variant="secondary"
                          className="ml-auto"
                          aria-label="Pending agent requests"
                        >
                          {
                            state.agent.requests.filter(
                              (request: { status: string }) =>
                                request.status === "pending",
                            ).length
                          }
                        </Badge>
                      )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        {openMobile && <StopButton />}
        <div className="sidebar-machine">
          <span
            className={online ? "connection-dot online" : "connection-dot"}
          />
          <div>
            <strong>{state?.configuration?.name || "Local workbench"}</strong>
            <span>
              {state?.demo
                ? "Simulation · no machine access"
                : state?.offline
                  ? "Offline · no machine access"
                  : online
                    ? "Local API available"
                    : "Controls locked"}
            </span>
          </div>
        </div>
        <DropdownMenu
          modal={false}
          onOpenChange={(open) => {
            if (open) client.releaseHold();
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="appearance-trigger"
              aria-label="Change appearance"
            >
              {icon}
              <span>
                {appearance === "system"
                  ? "System appearance"
                  : appearance === "dark"
                    ? "Dark appearance"
                    : "Light appearance"}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end">
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={appearance}
              onValueChange={(value) => setAppearance(value as Appearance)}
            >
              <DropdownMenuRadioItem value="system">
                <Monitor className="mr-2 size-4" />
                Follow system
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">
                <Sun className="mr-2 size-4" />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="mr-2 size-4" />
                Dark
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
function StatusBar({ openLog }: { openLog: () => void }) {
  const { state, online, pending } = useWorkbench();
  const position = state?.status?.machineCoord;
  return (
    <footer className="statusbar">
      <div>
        <span className={online ? "connection-dot online" : "connection-dot"} />
        <span id="connection">
          {!online
            ? "Connection unavailable"
            : state?.offline
              ? "Offline preparation"
              : state?.phase === "stopped"
                ? "Session stopped"
                : state?.demo
                  ? "Simulation connected"
                  : state?.status
                    ? "UGS " + state.status.state
                    : "Local API"}
        </span>
        <span className="status-task">
          {state?.offline
            ? "Files & planning"
            : state?.prompt
              ? "Waiting for you"
              : state?.busy || pending
                ? "Operation in progress"
                : state?.armed
                  ? "Setup enabled"
                  : "Controls locked"}
        </span>
      </div>
      <div className="status-position">
        {(["x", "y", "z"] as const).map((axis) => (
          <span key={axis}>
            {axis.toUpperCase()}{" "}
            <strong id={"status-" + axis}>
              {formatNumber(position?.[axis])}
            </strong>
          </span>
        ))}
        <span>mm</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={openLog}
          aria-label="Open session log"
        >
          <Terminal />
        </Button>
      </div>
    </footer>
  );
}
function UtilityDialog({
  utility,
  close,
}: {
  utility: Utility;
  close: () => void;
}) {
  const { state, online, pending, call, client, error } = useWorkbench();
  const title = {
    agents: "Agent access",
    connection: "Connection & configuration",
    help: "Using Buildmaster",
    camera: "Camera preview",
    shortcuts: "Keyboard shortcuts",
    log: "Session log",
  };
  const description = {
    agents:
      "Local preparation access and operator review of exact action requests.",
    connection: "Read-only checks of the local service and UGS.",
    help: "A guide to preparation, measurement and the handoff to UGS.",
    camera: "A browser-only live view. No movement or recording.",
    shortcuts:
      "Movement shortcuts work only in the enabled surface teaching view.",
    log: "Events from the current machine session.",
  };
  async function report() {
    try {
      downloadFile(
        "cnc-session-" +
          new Date().toISOString().replace(/[:.]/g, "-") +
          ".json",
        JSON.stringify(await client.report(), null, 2),
      );
    } catch (error) {
      client.setError(
        error instanceof Error ? error.message : "Report unavailable.",
      );
    }
  }
  const configuration = state?.configuration;
  return (
    <Dialog
      open={!!utility}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="utility-dialog">
        <DialogHeader>
          <DialogTitle>{utility ? title[utility] : ""}</DialogTitle>
          <DialogDescription>
            {utility ? description[utility] : ""}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea
          className={
            utility === "agents"
              ? "utility-scroll h-[65dvh] [&>[data-slot=scroll-area-viewport]]:absolute [&>[data-slot=scroll-area-viewport]]:inset-0 [&>[data-slot=scroll-area-viewport]]:h-auto"
              : "utility-scroll"
          }
          style={utility === "agents" ? { flex: "0 1 65dvh" } : undefined}
        >
          {error && (
            <Notice tone="error">
              <strong>{errorGuidance(error).title}</strong>
              <p>{errorGuidance(error).detail}</p>
              <p className="mt-2 break-words text-xs">{error}</p>
            </Notice>
          )}
          {utility === "camera" && <CameraView />}
          {utility === "agents" && <AgentAccess />}
          {utility === "help" && <WorkbenchHelp close={close} />}
          {utility === "connection" && (
            <div className="space-y-5">
              <h3>{configuration?.name || "Local workbench"}</h3>
              {!online && (
                <Notice tone="warning">
                  The local session is unavailable. If the server restarted,
                  open its current address from <code>./cnc-map status</code>.
                </Notice>
              )}
              {!online &&
                /another tab|original tab|ownership/i.test(error || "") && (
                  <div className="space-y-3">
                    <p className="text-sm">
                      If the original tab is closed, recover its session here.
                      Recovery is refused while that tab is active or machine
                      workers are running. This clears old machine references
                      and keeps preparation records.
                    </p>
                    <Button
                      disabled={pending}
                      onClick={() => void client.recoverOwnership()}
                    >
                      Recover closed tab &amp; clear references
                    </Button>
                  </div>
                )}
              {state?.offline && (
                <Notice>
                  Offline preparation has no machine connection. Save the job,
                  then open Buildmaster in machine mode with your validated
                  configuration when you are at the CNC.
                </Notice>
              )}
              {configuration && !state?.offline && (
                <dl className="config-list">
                  {Object.entries({
                    "UGS address": `127.0.0.1:${configuration.ugsPort}`,
                    "Puck height": configuration.puckHeight + " mm",
                    "XY travel": configuration.feeds.xy + " mm/min",
                    "Z travel": configuration.feeds.z + " mm/min",
                    "First contact": configuration.feeds.first + " mm/min",
                    "Second contact": configuration.feeds.second + " mm/min",
                  }).map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <Button
                id="checkConnection"
                disabled={!online || pending || state?.busy || state?.offline}
                onClick={() => void call("diagnostics")}
              >
                Check connection
              </Button>
              <div id="health" className="space-y-3">
                {state?.diagnostics?.checks.map((check: any, index: number) => (
                  <Notice
                    key={index}
                    tone={
                      check.ok === true
                        ? "success"
                        : check.ok === false
                          ? "error"
                          : "default"
                    }
                  >
                    <strong>{check.label}</strong>
                    <p>{check.detail}</p>
                  </Notice>
                ))}
                {state?.diagnostics?.checkedAt && (
                  <p className="field-help">
                    Checked {state.diagnostics.checkedAt}
                  </p>
                )}
              </div>
              <Button
                id="report"
                variant="outline"
                disabled={!online}
                onClick={() => void report()}
              >
                Download session report
              </Button>
            </div>
          )}
          {utility === "log" && (
            <div className="space-y-4">
              <Badge variant="outline">{state?.phase || "No session"}</Badge>
              <pre id="log" tabIndex={0} className="session-log">
                {state?.logs?.join("\n") || "No events in this session."}
              </pre>
              <Button
                variant="outline"
                disabled={!online}
                onClick={() => void report()}
              >
                Download session report
              </Button>
            </div>
          )}
          {utility === "shortcuts" && (
            <div className="space-y-5">
              <dl className="config-list">
                {[
                  ["Stop", "Esc"],
                  ["Jog XY", "← ↑ ↓ →"],
                  ["Raise / lower Z", "Page Up / Page Down"],
                  ["Fast XY hold", "Shift + arrow"],
                  ["Record corner / ready", "Enter"],
                  ["Find a tool", "⌘ / Ctrl + K"],
                  ["Toggle sidebar", "⌘ / Ctrl + B"],
                ].map(([label, key]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      <kbd>{key}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
              <Notice>
                Typing in a field never moves the cutter. Keep the physical stop
                within reach; the browser Stop depends on the connection.
              </Notice>
            </div>
          )}
        </ScrollArea>
        <DialogFooter className="utility-footer">
          <StopButton />
          <Button variant="outline" onClick={close}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    client.releaseHold();
  }
  render() {
    return this.state.failed ? (
      <div className="crash-screen">
        <h1>The workbench could not render</h1>
        <p>
          Use the physical stop if movement continues. Reload to reconnect to
          the current session.
        </p>
        <Button variant="destructive" onClick={() => void client.stop()}>
          Stop
        </Button>
        <Button variant="outline" onClick={() => location.reload()}>
          Reload workbench
        </Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
