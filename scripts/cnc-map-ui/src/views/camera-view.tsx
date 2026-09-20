import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SelectField, Notice } from "@/components/workbench-controls";
export function CameraView() {
  const video = useRef<HTMLVideoElement>(null),
    stream = useRef<MediaStream | null>(null),
    generation = useRef(0),
    requesting = useRef(false);
  const [pending, setPending] = useState(false),
    [live, setLive] = useState(false),
    [device, setDevice] = useState(""),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [help, setHelp] = useState(
    "Video stays in this browser. Nothing is recorded or uploaded.",
  );
  function stop(message = "Camera off. Video is not recorded or uploaded.") {
    generation.current++;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    requesting.current = false;
    if (video.current) video.current.srcObject = null;
    setPending(false);
    setLive(false);
    setHelp(message);
  }
  useEffect(() => {
    const hidden = () => {
      if (document.hidden)
        stop("Camera paused while the page was hidden. Enable it to resume.");
    };
    const leave = () => stop();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => {
      generation.current++;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
    };
  }, []);
  async function start() {
    if (requesting.current || stream.current) return;
    const ticket = ++generation.current;
    requesting.current = true;
    setPending(true);
    setHelp("Allow camera access, or choose Turn off to cancel.");
    let captured: MediaStream | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw Error("Camera access is unavailable in this browser.");
      captured = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 15, max: 30 },
          ...(device ? { deviceId: { exact: device } } : {}),
        },
      });
      if (ticket !== generation.current || document.hidden) {
        captured.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = captured;
      requesting.current = false;
      setPending(false);
      setLive(true);
      captured.getVideoTracks().forEach((t) =>
        t.addEventListener("ended", () => {
          if (stream.current === captured)
            stop("Camera disconnected. Enable it after reconnecting.");
        }),
      );
      if (video.current) {
        video.current.srcObject = captured;
        await video.current.play();
      }
      if (ticket !== generation.current) return;
      setHelp("Live view. The crosshair is not calibrated to the cutter.");
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (ticket === generation.current) {
          setDevices(all.filter((d) => d.kind === "videoinput"));
          setDevice(captured.getVideoTracks()[0]?.getSettings().deviceId || "");
        }
      } catch {
        /* Preview remains available without device names. */
      }
    } catch (error) {
      captured?.getTracks().forEach((t) => t.stop());
      if (ticket !== generation.current) return;
      const names: Record<string, string> = {
        NotAllowedError:
          "Camera permission was denied. Enable it in browser settings to try again.",
        NotFoundError: "No camera found. Connect a camera and try again.",
        NotReadableError: "Camera is busy or unavailable.",
        OverconstrainedError: "The selected camera is unavailable.",
      };
      stop(
        error instanceof Error
          ? names[error.name] || error.message
          : "Camera request failed.",
      );
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p>Optional positioning view</p>
        <Badge id="cameraState" variant={live ? "default" : "secondary"}>
          {live ? "LIVE" : pending ? "WAITING" : "OFF"}
        </Badge>
      </div>
      <SelectField
        id="cameraDevice"
        label="Camera device"
        value={device}
        disabled={pending || live}
        onChange={(e) => {
          stop();
          setDevice(e.target.value);
        }}
        options={[
          { value: "", label: "Default camera" },
          ...devices.map((d, i) => ({
            value: d.deviceId,
            label: d.label || `Camera ${i + 1}`,
          })),
        ]}
      />
      <div className="actions">
        <Button
          id="cameraStart"
          disabled={pending || live}
          onClick={() => void start()}
        >
          Enable camera
        </Button>
        <Button
          id="cameraStop"
          variant="outline"
          disabled={!pending && !live}
          onClick={() => stop()}
        >
          Turn off
        </Button>
      </div>
      <div id="cameraFrame" className="camera-frame" hidden={!live}>
        <video id="cameraVideo" ref={video} autoPlay muted playsInline />
        <div className="camera-crosshair" aria-hidden>
          +
        </div>
      </div>
      <Notice>
        <span id="cameraHelp">{help}</span>
      </Notice>
    </div>
  );
}
