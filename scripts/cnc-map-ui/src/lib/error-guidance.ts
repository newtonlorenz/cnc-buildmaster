export function errorGuidance(message: string): {
  title: string;
  detail: string;
  utility: "connection" | "log";
  action: string;
} {
  if (/Restart the server/i.test(message))
    return {
      title: "The server and interface versions differ",
      detail:
        "Finish any active machine operation, then restart Buildmaster with ./cnc-map restart and open the new address it prints.",
      utility: "connection",
      action: "Connection details",
    };
  if (/invalid local session|unauthori[sz]ed|401|expired/i.test(message))
    return {
      title: "This browser session has expired",
      detail:
        "Open the current address from ./cnc-map status. A server restart creates a new local session; this tab cannot use the old one.",
      utility: "connection",
      action: "Connection help",
    };
  if (
    /another.*(browser|tab|client)|different.*(browser|tab|client)|owned by/i.test(
      message,
    )
  )
    return {
      title: "Another tab is using the machine session",
      detail:
        "Return to the tab that enabled this setup. Do not run movement controls from two tabs at once.",
      utility: "connection",
      action: "Connection details",
    };
  if (
    /reference changed|G54|offset.*(changed|match)|position reference/i.test(
      message,
    )
  )
    return {
      title: "The machine reference needs checking",
      detail:
        "A coordinate change can invalidate taught corners and measurements. Check UGS and the physical setup, then start a fresh setup when the machine is stopped.",
      utility: "connection",
      action: "Check connection",
    };
  if (
    /failed to fetch|unavailable|network|timeout|timed out|offline/i.test(
      message,
    )
  )
    return {
      title: "The local connection needs attention",
      detail:
        "Check that the Buildmaster server is running. The app keeps controls locked until a fresh response arrives; it does not repeat a movement request.",
      utility: "connection",
      action: "Connection details",
    };
  return {
    title: "The action did not finish",
    detail:
      "Your current inputs are still here. Review the detail below, correct the cause and try the action again.",
    utility: "log",
    action: "Open session log",
  };
}
