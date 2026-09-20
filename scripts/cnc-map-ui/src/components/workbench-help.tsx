import { ArrowRight } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { useWorkbench } from "@/workbench-context";
export function WorkbenchHelp({ close }: { close: () => void }) {
  const { navigate } = useWorkbench();
  return (
    <div className="space-y-5 text-sm">
      <p>
        Buildmaster helps you prepare and measure a workpiece. Your CAM tool
        makes the cutting files; UGS applies the reviewed height correction and
        sends the job.
      </p>
      <Accordion type="single" collapsible defaultValue="measure">
        <AccordionItem value="measure">
          <AccordionTrigger>I just want to level a surface</AccordionTrigger>
          <AccordionContent className="space-y-3">
            <p>Start in Surface mapping. A cutting file is optional.</p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Check workholding, tool clearance, the probe circuit and the
                configured puck height. Enable the setup.
              </li>
              <li>
                Jog to two opposite corners of the usable area. Record them and
                accept the inferred rectangle.
              </li>
              <li>
                Choose spacing and review the number of placements. A finer grid
                finds smaller changes but takes longer.
              </li>
              <li>
                With a movable puck, place it flat under the cutter and press
                Enter when clear. The machine measures twice, retracts and moves
                on.
              </li>
              <li>
                Accept the completed readings and return check. Review the
                surface result, then import the accepted map into UGS.
              </li>
              <li>
                Save any aligned draft files, then use Finish preparation.
                Continue in UGS only after Buildmaster has ended its monitoring.
              </li>
            </ol>
            <p>
              Continuous bare copper can use a checked electrical circuit and
              one route approval. Interrupted copper, wood and insulated
              surfaces need a suitable probe method.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                close();
                navigate("surface");
              }}
            >
              Open surface mapping
              <ArrowRight />
            </Button>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="pcb">
          <AccordionTrigger>I want to mill a PCB</AccordionTrigger>
          <AccordionContent className="space-y-3">
            <p>
              Export isolation, drilling and outline G-code from CAM. Keep files
              for one board face in a job. Set the actual stock, cutter and
              effective diameter for each operation.
            </p>
            <p>
              For alignment, pick the same recognisable point in the design and
              on the workpiece. Two separated points A and B establish
              placement; an independent point C checks it. Typed coordinates are
              a draft. Fresh machine captures establish the session reference.
            </p>
            <p>
              Confirm the machining face and mirroring with an asymmetric
              feature such as a labelled connector. The app does not guess which
              side of the board your CAM files describe.
            </p>
            <p>
              The Job guide links each missing check to its editor. Once the
              layout is checked, map only the cutting area and use the setup
              sheet for the UGS handoff.
            </p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="ugs">
          <AccordionTrigger>What happens in UGS?</AccordionTrigger>
          <AccordionContent className="space-y-3">
            <p>
              Buildmaster uses UGS as its only machine connection. It does not
              stream cutting jobs.
            </p>
            <p>
              Import the accepted map with an empty AutoLeveler, no selected
              cutting file and Apply to Gcode off. Native readback checks that
              UGS received the grid. It does not establish the material Z zero
              or prove that a selected file is compensated.
            </p>
            <p>
              After export and map import, use Finish preparation to end
              Buildmaster’s monitoring. Then load the reviewed operation file in
              UGS, establish material-top Z for the fitted cutter, check full
              map coverage and apply compensation exactly once. Review the
              resulting paths and clearances in UGS before sending. Remove the
              probe leads before starting the spindle.
            </p>
            <p>
              <a
                className="text-primary underline underline-offset-4"
                href="https://github.com/winder/Universal-G-Code-Sender/wiki/Usage"
                target="_blank"
                rel="noreferrer"
              >
                UGS usage guide
              </a>
            </p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="tools">
          <AccordionTrigger>
            When do I need the workshop tools?
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Fixtures:</strong> model measured clamps and holder
                clearance. Inspect the physical setup too.
              </li>
              <li>
                <strong>Tool changes:</strong> keep observations for the next
                cutter. Notes do not set Z.
              </li>
              <li>
                <strong>Recipes:</strong> record parameters and observed
                results. A previous success is context for a new setup.
              </li>
              <li>
                <strong>Camera:</strong> calculate an offset from measured
                fiducials. Live preview remains a visual aid.
              </li>
              <li>
                <strong>Wood:</strong> prepare a reviewed coupon or surfacing
                draft using explicit machine, tool and material parameters.
              </li>
            </ul>
            <Button
              variant="outline"
              onClick={() => {
                close();
                navigate("tools");
              }}
            >
              Open workshop tools
              <ArrowRight />
            </Button>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="coordinates">
          <AccordionTrigger>
            Machine coordinates, G54 and height maps
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <p>
              <strong>Machine XY</strong> describes positions in the current
              machine reference. Taught corners and captured board references
              use this frame.
            </p>
            <p>
              <strong>G54</strong> is the work offset used by the cutting job.
              The aligned draft converts XY into this frame. Changing the
              reference can invalidate the setup.
            </p>
            <p>
              <strong>A height map</strong> records surface variation. It does
              not flatten the material, set the cutting depth or establish Z
              zero. Saved files do not prove that the workpiece is still in the
              same place.
            </p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="recovery">
          <AccordionTrigger>
            A control is locked or the connection stopped
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <p>
              Read the message next to the action first. Unapplied form edits, a
              pending operation, an inactive setup or a missing reference can
              each lock an action.
            </p>
            <p>
              Use Connection to run read-only checks. If the local server
              restarted, open the fresh address printed by{" "}
              <code>./cnc-map status</code>. An old tab may hold an expired
              local session.
            </p>
            <p>
              A stopped machine session does not resume a probe cycle
              automatically. Check the physical machine, resolve the reported
              cause, then establish a fresh setup. Keep the physical stop
              available if software control is unavailable.
            </p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
