"""Offline regression test of the real held-jog source against a fake controller.

Run: JAVA_HOME=/path/to/jdk python3 tests/test_ugs_held_jog.py -v
The JDK may also be selected from PATH. UGS jars come from the configured ugsApp;
missing prerequisites are reported as skips. No dependency downloads, sockets,
UGS process, installed extension build, or machine connection are used.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))


def jdk_tools():
    suffix = '.exe' if os.name == 'nt' else ''
    home = os.environ.get('JAVA_HOME')
    compiler = Path(home).expanduser() / 'bin' / ('javac' + suffix) if home else shutil.which('javac')
    if compiler:
        compiler = Path(compiler).resolve()
        runtime = compiler.with_name('java' + suffix)
        try:
            for tool in (compiler, runtime):
                result = subprocess.run([str(tool), '-version'], capture_output=True, text=True, timeout=10)
                version = re.search(r'(?:javac |version ")([0-9]+)', result.stdout + result.stderr)
                if result.returncode or not version or int(version[1]) < 17:
                    break
            else:
                return compiler, runtime
        except (OSError, subprocess.TimeoutExpired):
            pass
    message = 'A JDK 17 or newer is required; set JAVA_HOME or put its bin directory on PATH'
    if home:
        raise RuntimeError(message + ' (the explicit JAVA_HOME did not provide one)')
    raise unittest.SkipTest(message)


class HeldJogOfflineTests(unittest.TestCase):
    def test_fake_controller_regressions(self):
        compiler, runtime = jdk_tools()
        from ugs_loopback_setup import APP, STATE, check_stock
        modules = APP / 'Contents/Resources/ugsplatform/ugsplatform/modules'
        if not modules.is_dir():
            self.skipTest('UGS test jars unavailable; configure ugsApp with a compatible local UGS distribution')
        check_stock()  # Read-only compatibility gate; never install or start UGS.
        classpath = os.pathsep.join(str(jar) for jar in sorted(modules.rglob('*.jar')))
        source = STATE / 'src/com/willwinder/universalgcodesender/pendantui/v1/resources/HeldJogResource.java'
        with tempfile.TemporaryDirectory(prefix='ugs-held-jog-test-') as directory:
            fixture = Path(directory) / 'HeldJogTest.java'
            fixture.write_text(JAVA_FIXTURE, encoding='utf-8')
            for command in (
                [str(compiler), '--release', '17', '-cp', classpath, '-d', directory, str(source), str(fixture)],
                [str(runtime), '-ea', '-cp', directory + os.pathsep + classpath, 'HeldJogTest'],
            ):
                result = subprocess.run(command, capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('HeldJogTest passed', result.stdout)
            print(result.stdout.strip())


# Keep the fake controller self-contained. The production source and upstream
# UGS formatter are compiled as-is, while every backend/controller call is fake.
JAVA_FIXTURE = r'''
import com.willwinder.universalgcodesender.*;
import com.willwinder.universalgcodesender.model.*;
import com.willwinder.universalgcodesender.model.UnitUtils.Units;
import com.willwinder.universalgcodesender.listeners.*;
import com.willwinder.universalgcodesender.firmware.*;
import com.willwinder.universalgcodesender.firmware.grbl.GrblCapabilitiesConstants;
import com.willwinder.universalgcodesender.gcode.util.GcodeUtils;
import com.willwinder.universalgcodesender.types.GcodeCommand;
import com.willwinder.universalgcodesender.pendantui.v1.resources.HeldJogResource;
import java.lang.reflect.*;
import java.util.*;

public class HeldJogTest {
    static void ok(boolean condition) { if (!condition) throw new AssertionError(); }
    interface Action {void run() throws Exception;}
    static void rejects(Action action) throws Exception {try {action.run();}catch(jakarta.ws.rs.BadRequestException expected){return;}throw new AssertionError("Expected refusal");}
    static class Fake implements AutoCloseable {
        long time; int jogs, cancels; boolean autoAck=true; GcodeCommand pending; boolean connected=true; boolean loaded; double spindle;
        List<ControllerListener> listeners=new ArrayList<>();
        ControllerStatus status; IController controller; BackendAPI backend; HeldJogResource resource;
        Fake() {
            report("IDLE",0,0,10,0,0);
            Capabilities caps=new Capabilities();caps.addCapability(GrblCapabilitiesConstants.HARDWARE_JOGGING);
            IFirmwareSettings settings=(IFirmwareSettings)Proxy.newProxyInstance(getClass().getClassLoader(),new Class[]{IFirmwareSettings.class},(p,m,a)->{
                if(m.getName().equals("getMaximumRate"))return a[0]==Axis.Z?600.:1000.;
                throw new AssertionError(m.getName());
            });
            controller=(IController)Proxy.newProxyInstance(getClass().getClassLoader(),new Class[]{IController.class},(p,m,a)->{
                switch(m.getName()){
                    case "isCommOpen":return connected;
                    case "getCapabilities":return caps;
                    case "getFirmwareSettings":return settings;
                    case "getControllerStatus":return status;
                    case "addListener":listeners.add((ControllerListener)a[0]);return null;
                    case "removeListener":listeners.remove(a[0]);return null;
                    case "cancelJog":cancels++;return null;
                    case "jogMachine":
                        jogs++;
                        GcodeCommand command=new GcodeCommand("$J="+GcodeUtils.generateMoveCommand("G91",(double)a[1],(PartialPosition)a[0]),jogs);
                        for(var l:List.copyOf(listeners))l.commandSent(command);
                        pending=command;
                        if(autoAck)ack();
                        return null;
                    default:throw new AssertionError("Unexpected controller call: "+m.getName());
                }
            });
            backend=(BackendAPI)Proxy.newProxyInstance(getClass().getClassLoader(),new Class[]{BackendAPI.class},(p,m,a)->{
                switch(m.getName()){
                    case "getController":return controller;
                    case "isConnected":return connected;
                    case "isSendingFile":return false;
                    case "getGcodeFile":return loaded?new java.io.File("fixture.nc"):null;
                    default:throw new AssertionError("Unexpected backend call: "+m.getName());
                }
            });
            resource=new HeldJogResource(backend,()->time,false);
        }
        void ack(){pending.setOk(true);for(var l:List.copyOf(listeners))l.commandComplete(pending);}
        void report(String state,double x,double y,double z,double feed,double offsetX){
            status=ControllerStatusBuilder.newInstance().setState(ControllerState.valueOf(state))
                .setMachineCoord(new Position(x,y,z,Units.MM)).setWorkCoord(new Position(x-offsetX,y,z+14,Units.MM))
                .setFeedSpeed(feed).setSpindleSpeed(spindle).setFeedSpeedUnits(Units.MM).build();
            for(var l:List.copyOf(listeners))l.statusStringListener(status);
        }
        HeldJogResource.Input input(String id){var i=new HeldJogResource.Input();i.id=id;i.axis="X";i.delta=100;i.feed=1000;i.expected=new double[]{0,0,10};i.offset=new double[]{0,0,-14};return i;}
        void begin() throws Exception {resource.start(input("test-hold-one"));}
        Map<String,Object> state(){return resource.state("test-hold-one");}
        public void close(){resource.close();}
    }
    public static void main(String[] args) throws Exception {
        // Real UGS command formatter and real extension, fake backend: no serial/network.
        try(Fake f=new Fake()){
            var r=f.resource.start(f.input("test-hold-one"));ok(r.get("command").equals("$J=G21G91X100F1000"));
            ok(f.jogs==1);f.report("JOG",5,0,10,1000,0);
            f.resource.stop(f.input("test-hold-one"));ok(f.cancels==1);ok(!(boolean)f.state().get("finished"));
            f.report("IDLE",8,0,10,0,0);ok((boolean)f.state().get("finished"));
            f.resource.pulse(f.input("test-hold-one"));ok(f.jogs==1);
            rejects(()->f.resource.start(f.input("test-hold-one")));
        }
        try(Fake f=new Fake()){
            f.resource.stop(f.input("test-hold-one"));rejects(f::begin);ok(f.jogs==0);
        }
        try(Fake f=new Fake()){
            f.begin();f.time=501;f.resource.pulse(f.input("test-hold-one"));ok(f.cancels>=1);
            ok(f.state().get("reason").equals("lease expired"));
            f.time=700;f.resource.pulse(f.input("test-hold-one"));ok((boolean)f.state().get("cancelled"));
            rejects(()->f.resource.start(f.input("test-hold-two")));
            // Cached initial Idle is insufficient; a fresh report after ack/cancel is needed.
            ok(!(boolean)f.state().get("finished"));f.report("IDLE",0,0,10,0,0);ok((boolean)f.state().get("finished"));
        }
        try(Fake f=new Fake()){
            f.begin();f.resource.stop(f.input("different-id"));ok(f.cancels==0);
            f.report("IDLE",100,0,10,0,0);ok((boolean)f.state().get("finished"));ok(f.jogs==1);
        }
        for(String fault:new String[]{"offset","bounds","alarm","spindle","disconnect","file"})try(Fake f=new Fake()){
            f.begin();if(fault.equals("spindle"))f.spindle=100;
            if(fault.equals("disconnect"))f.connected=false;
            if(fault.equals("file"))f.loaded=true;
            f.report(fault.equals("alarm")?"ALARM":"JOG",fault.equals("bounds")?101:1,0,10,100,fault.equals("offset")?1:0);
            f.resource.tick();ok(f.state().get("error")!=null);ok(f.cancels>0);
        }
        for(String bad:new String[]{"speed","distance","axis","start","height","nonfinite","zspeed"})try(Fake f=new Fake()){
            var i=f.input("test-hold-one");
            switch(bad){case "speed":i.feed=1001;break;case "distance":i.delta=101;break;case "axis":i.axis="A";break;case "start":i.expected[0]=1;break;case "height":i.expected[2]=9;break;case "nonfinite":i.delta=Double.NaN;break;case "zspeed":i.axis="Z";i.delta=5;i.feed=601;break;}
            rejects(()->f.resource.start(i));ok(f.jogs==0);
        }
        try(Fake f=new Fake()){
            f.begin();var c=new GcodeCommand("G1 X5",99);for(var l:List.copyOf(f.listeners))l.commandSent(c);
            ok(f.state().get("error")!=null);ok(f.cancels>0);
        }
        // A slow stopping report must not cause a stream of cancellation bytes.
        try(Fake f=new Fake()){
            f.begin();f.report("JOG",5,0,10,1000,0);f.resource.stop(f.input("test-hold-one"));
            for(int i=0;i<20;i++){f.time+=100;f.resource.tick();}
            ok(f.cancels==1);ok(!(boolean)f.state().get("finished"));
            f.report("IDLE",8,0,10,0,0);ok((boolean)f.state().get("finished"));
            f.time+=1000;f.resource.tick();ok(f.cancels==1);
        }
        // Release before acceptance needs one post-ack cancel and then a newer Idle.
        try(Fake f=new Fake()){
            f.autoAck=false;f.begin();f.resource.stop(f.input("test-hold-one"));ok(f.cancels==1);
            f.time=100;f.resource.tick();ok(f.cancels==1);
            f.ack();f.report("IDLE",0,0,10,0,0);f.resource.tick();
            ok(f.cancels==2);ok(!(boolean)f.state().get("finished"));
            f.report("IDLE",0,0,10,0,0);ok((boolean)f.state().get("finished"));
            f.time=1000;f.resource.tick();ok(f.cancels==2);
        }
        System.out.println("HeldJogTest passed: 20 fake-controller scenarios, including cancellation counts before/after acknowledgement and fresh stopped reports; no sockets or hardware.");
    }
}
'''


if __name__ == '__main__':
    unittest.main()
