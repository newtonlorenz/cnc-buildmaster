/* Local UGS extension, GPL-3.0-or-later, like the surrounding UGS sources. */
package com.willwinder.universalgcodesender.pendantui.v1.resources;

import com.willwinder.universalgcodesender.IController;
import com.willwinder.universalgcodesender.firmware.grbl.GrblCapabilitiesConstants;
import com.willwinder.universalgcodesender.gcode.util.GcodeUtils;
import com.willwinder.universalgcodesender.listeners.*;
import com.willwinder.universalgcodesender.model.*;
import com.willwinder.universalgcodesender.model.UnitUtils.Units;
import com.willwinder.universalgcodesender.types.GcodeCommand;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.LongSupplier;

/** One bounded native GRBL jog per press, with an independent in-UGS deadman timer. */
@Path("/jogHold")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public final class HeldJogResource implements AutoCloseable {
    public static final long LEASE_MS = 500;
    public static class Input {
        public String id, axis;
        public double delta, feed;
        public double[] expected, offset;
    }
    private final BackendAPI backend;
    private final LongSupplier clock;
    private final ScheduledExecutorService timer;
    private final Set<String> retired = new LinkedHashSet<>();
    private Active active;
    private boolean closed;
    private static class Active {
        Input request;
        IController controller;
        ControllerListener listener;
        String command, reason = "moving", error;
        long deadline, revision, ackRevision = -1, stopRevision = -1, lastCancel;
        Integer commandId;
        boolean acknowledged, cancelled, finished;
        ControllerStatus status;
    }
    public HeldJogResource(BackendAPI backend) {
        this(backend, () -> System.nanoTime()/1_000_000, true);
    }
    public HeldJogResource(BackendAPI backend, LongSupplier clock, boolean schedule) {
        this.backend = backend; this.clock = clock;
        timer = schedule ? Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "ugs-held-jog-deadman"); t.setDaemon(true); return t;
        }) : null;
        if (timer != null) timer.scheduleAtFixedRate(this::tick, 25, 25, TimeUnit.MILLISECONDS);
    }
    private static void require(boolean ok, String message) {
        if (!ok) throw new BadRequestException(message);
    }
    private static void id(String value) {
        require(value != null && value.matches("[-A-Za-z0-9_]{8,80}"), "Invalid hold ID");
    }
    private void retire(String value) {
        retired.add(value);
        if (retired.size() > 512) retired.remove(retired.iterator().next());
    }
    private static String norm(String text) { return text.replaceAll("\\s", "").toUpperCase(Locale.ROOT); }
    @GET @Path("capabilities")
    public Map<String,Object> capabilities() {
        return Map.of("protocol", 1, "nativeJog", true, "leaseMs", LEASE_MS, "xyLimit", 100, "zLimit", 5);
    }
    private ControllerStatus checked(Active a) throws Exception {
        require(backend.isConnected() && backend.getController() == a.controller && a.controller.isCommOpen(), "Controller changed/disconnected");
        require(!backend.isSendingFile() && backend.getGcodeFile() == null, "A job is selected/active");
        ControllerStatus s = a.controller.getControllerStatus();
        require(s != null && (s.getState() == ControllerState.IDLE || s.getState() == ControllerState.JOG), "Expected Idle/Jog");
        require(s.getSpindleSpeed() != null && s.getSpindleSpeed() == 0 && s.getFeedSpeed() != null && Double.isFinite(s.getFeedSpeed()) && s.getFeedSpeed() >= 0, "Unexpected spindle/feed");
        require(s.getMachineCoord().getUnits() == Units.MM && s.getWorkCoord().getUnits() == Units.MM, "Expected MM");
        for (int i=0;i<3;i++) {
            Axis axis = new Axis[]{Axis.X,Axis.Y,Axis.Z}[i];
            double machine = s.getMachineCoord().get(axis), work = s.getWorkCoord().get(axis);
            require(Double.isFinite(machine) && Double.isFinite(work) && Math.abs(machine-work-a.request.offset[i]) <= .0051, "Reference changed");
            double delta = axis.name().equals(a.request.axis) ? a.request.delta : 0;
            require(machine >= a.request.expected[i]+Math.min(0,delta)-.0051 && machine <= a.request.expected[i]+Math.max(0,delta)+.0051, "Jog left permitted bounds");
        }
        return s;
    }
    @POST @Path("start")
    public synchronized Map<String,Object> start(Input input) throws Exception {
        require(!closed, "Jog service closed"); id(input.id); tick();
        require(!retired.contains(input.id), "Released/used hold ID");
        require(active == null || (active.finished && active.error == null), "Previous jog not finished");
        require(Set.of("X","Y","Z").contains(input.axis), "Invalid axis");
        require(Double.isFinite(input.delta) && Math.abs(input.delta) > 0 && Math.abs(input.delta) <= (input.axis.equals("Z") ? 5 : 100), "Invalid distance");
        require(Double.isFinite(input.feed) && input.feed > 0, "Invalid feed");
        for (double[] v : new double[][]{input.expected,input.offset}) {
            require(v != null && v.length == 3, "Expected XYZ and offset");
            for (double n : v) require(Double.isFinite(n), "Nonfinite coordinate");
        }
        IController controller = backend.getController();
        require(controller != null && controller.getCapabilities().hasCapability(GrblCapabilitiesConstants.HARDWARE_JOGGING), "GRBL native jogging required");
        double maximum = controller.getFirmwareSettings().getMaximumRate(Axis.valueOf(input.axis));
        require(Double.isFinite(maximum) && input.feed <= maximum && input.feed <= (input.axis.equals("Z") ? 600 : 1000), "Axis feed limit exceeded");
        Active a = new Active(); a.request = input; a.controller = controller;
        ControllerStatus s = checked(a);
        require(s.getState() == ControllerState.IDLE && s.getFeedSpeed() == 0, "Must start stopped");
        for (int i=0;i<3;i++) require(Math.abs(s.getMachineCoord().get(new Axis[]{Axis.X,Axis.Y,Axis.Z}[i])-input.expected[i]) <= .0051, "Start position changed");
        if (active != null) active.controller.removeListener(active.listener);
        PartialPosition distance = PartialPosition.from(Axis.valueOf(input.axis), input.delta, Units.MM);
        a.command = "$J="+GcodeUtils.generateMoveCommand("G91", input.feed, distance);
        a.deadline = clock.getAsLong()+LEASE_MS; a.status=s;
        a.listener = new ControllerListener() {
            public void statusStringListener(ControllerStatus status) { synchronized(HeldJogResource.this) { a.status=status; a.revision++; } }
            public void commandSent(GcodeCommand c) { synchronized(HeldJogResource.this) {
                if (a.finished) return;
                if (a.commandId != null || !norm(c.getCommandString()).equals(norm(a.command))) fault(a,"Concurrent/unexpected command");
                else a.commandId=c.getId();
            } }
            public void commandComplete(GcodeCommand c) { synchronized(HeldJogResource.this) {
                if (a.finished) return;
                if (a.commandId == null || c.getId()!=a.commandId || !c.isOk() || c.isError() || c.isSkipped()) fault(a,"Jog acknowledgement failed");
                else { a.acknowledged=true; a.ackRevision=a.revision; }
            } }
            public void receivedAlarm(Alarm alarm) { synchronized(HeldJogResource.this) { fault(a,"Controller alarm"); } }
            public void commandSkipped(GcodeCommand c) { synchronized(HeldJogResource.this) { if (!a.finished) fault(a,"Jog skipped"); } }
            public void streamStarted() { synchronized(HeldJogResource.this) { fault(a,"Unexpected file stream"); } }
            public void streamCanceled() {} public void streamPaused() {} public void streamResumed() {} public void streamComplete() {} public void probeCoordinates(Position p) {}
        };
        active=a; retire(input.id); controller.addListener(a.listener);
        try { controller.jogMachine(distance,input.feed); }
        catch (Exception e) { fault(a,e.getMessage()); throw e; }
        return result(a);
    }
    private void fault(Active a, String message) {
        if (a.error == null) a.error=message;
        cancel(a,"failure");
    }
    private void cancel(Active a, String reason) {
        if (a.finished) return;
        if (!a.cancelled) { a.cancelled=true; a.reason=reason; a.stopRevision=a.revision; }
        // A release may precede the firmware accepting $J. Keep cancellation effective
        // while that command is pending, until a fresh acknowledged Idle is observed.
        try { a.controller.cancelJog(); a.lastCancel=clock.getAsLong(); }
        catch (Exception e) { if (a.error == null) a.error="Jog cancel failed: "+e.getMessage(); }
    }
    public synchronized void tick() {
        Active a=active;
        if (closed || a==null || a.finished) return;
        try {
            ControllerStatus s=checked(a);
            if (!a.cancelled && clock.getAsLong()>=a.deadline) cancel(a,"lease expired");
            double end=a.request.expected[Axis.valueOf(a.request.axis).ordinal()]+a.request.delta;
            boolean reached=Math.abs(s.getMachineCoord().get(Axis.valueOf(a.request.axis))-end)<=.0051;
            if (a.acknowledged && a.revision>a.ackRevision && (!a.cancelled || a.revision>a.stopRevision) &&
                s.getState()==ControllerState.IDLE && s.getFeedSpeed()==0 && (a.cancelled || reached)) {
                a.finished=true;
                if (!a.cancelled) a.reason="travel limit";
            } else if (a.cancelled && clock.getAsLong()-a.lastCancel>=100) cancel(a,a.reason);
        } catch (Exception e) { fault(a,e.getMessage()); }
    }
    @POST @Path("pulse")
    public synchronized Map<String,Object> pulse(Input input) {
        id(input.id); tick();
        require(active!=null && active.request.id.equals(input.id), "Unknown hold ID");
        if (!active.cancelled && !active.finished) active.deadline=clock.getAsLong()+LEASE_MS;
        return result(active);
    }
    @POST @Path("stop")
    public synchronized Map<String,Object> stop(Input input) {
        id(input.id); retire(input.id);
        if (active==null || !active.request.id.equals(input.id)) return Map.of("id",input.id,"finished",true,"cancelled",true);
        if (!active.cancelled) cancel(active,"released");
        tick(); return result(active);
    }
    @GET @Path("state")
    public synchronized Map<String,Object> state(@QueryParam("id") String id) {
        id(id); tick(); require(active!=null && active.request.id.equals(id), "Unknown hold ID"); return result(active);
    }
    private Map<String,Object> result(Active a) {
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("id",a.request.id); result.put("finished",a.finished); result.put("cancelled",a.cancelled);
        result.put("reason",a.reason); result.put("error",a.error); result.put("command",a.command);
        result.put("position",Map.of("x",a.status.getMachineCoord().get(Axis.X),"y",a.status.getMachineCoord().get(Axis.Y),"z",a.status.getMachineCoord().get(Axis.Z)));
        return result;
    }
    @jakarta.annotation.PreDestroy
    public synchronized void close() {
        if (active!=null && !active.finished) cancel(active,"service closed");
        closed=true;
        if (timer!=null) timer.shutdownNow();
        if (active!=null) active.controller.removeListener(active.listener);
    }
}
