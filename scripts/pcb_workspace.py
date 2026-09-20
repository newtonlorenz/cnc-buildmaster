"""PCB preparation state. File parsing and geometry are separate from machine control."""
import copy
import datetime
import io
import json
import math
from pathlib import Path
import re
import uuid
import zipfile

from job_workflow import defaults, restore_workflow, refresh_tool_checks
from pcb_gcode import parse_gcode, transform, finite, require, aligned_gcode, sweep

ROLES = ('isolation', 'drilling', 'outline', 'clearing', 'other')
LABELS = ('A', 'B', 'C')
MAX_TOTAL = 16_000_000


def text(value, name, limit=120):
    require(isinstance(value, str) and len(value) <= limit and all(ord(c) >= 32 for c in value),
            f'{name} must be text, up to {limit} characters')
    return value.strip()


def xy(value):
    require(isinstance(value, list) and len(value) == 2, 'Expected an XY pair')
    return [finite(v, 'XY coordinate') for v in value]


def export_limits(profile, demo):
    """Real limits never default; the explicit demo spindle model defaults to 1000."""
    if profile is None:
        require(demo, 'Real draft export requires the configured machine profile')
        return None
    require(isinstance(profile, dict) and (demo or profile.get('configured') is True),
            'Real draft export requires the configured machine profile')
    baseline = profile.get('baseline')
    require(isinstance(baseline, dict), 'Missing machine baseline for export')
    result = {}
    for label, key in [('x', '110'), ('y', '111'), ('z', '112'), ('spindle', '30')]:
        # The bundled demo has axis rates but no GRBL spindle baseline. Match
        # its existing simulated spindle model, without filling real omissions
        # or hiding explicitly supplied invalid values.
        value = baseline.get(key, 1000 if demo is True and key == '30' else None)
        require(type(value) in (int, float, str), 'Missing or invalid export limit: ' + label)
        try:
            value = float(value)
        except (ValueError, OverflowError) as error:
            raise ValueError('Invalid export limit: ' + label) from error
        ceiling = 1e9 if label == 'spindle' else 100000
        require(math.isfinite(value) and 0 < value <= ceiling, 'Invalid export limit: ' + label)
        result[label] = value
    return result


def check_export_rates(parsed, limits, name):
    """Check emitted G94 feeds per axis, including analytic arc/helix peaks.

    Rapids use controller-managed axis maxima, not modal F. Initial approach,
    acceleration and physical cutting suitability are not qualified here.
    """
    require(parsed['maxSpindle'] <= limits['spindle'], name + ': spindle command exceeds configured maximum')
    feed = None
    for block in parsed['blocks']:
        feed = block.get('feed', feed)
        move = block.get('move')
        if not move or move['g'] == 0: continue
        start, end = move['from'], move['to']
        delta = [end[i] - start[i] for i in range(3)]
        if move['g'] == 1:
            distance = math.hypot(*delta)
            rates = [feed * abs(d) / distance for d in delta] if distance else [0, 0, 0]
        else:
            angle, turn = sweep(start, end, move['centre'], move['g'] == 2)
            radius = math.dist(start[:2], move['centre'])
            length_xy = radius * abs(turn)
            distance = math.hypot(length_xy, delta[2])
            candidates = [angle, angle + turn]
            for theta in (0, math.pi/2, math.pi, 3*math.pi/2):
                travel = ((theta-angle) if turn > 0 else (angle-theta)) % math.tau
                if travel <= abs(turn) + 1e-12: candidates.append(theta)
            xy_feed = feed * length_xy / distance
            rates = [xy_feed * max(abs(math.sin(a)) for a in candidates),
                     xy_feed * max(abs(math.cos(a)) for a in candidates),
                     feed * abs(delta[2]) / distance]
        for axis, rate in zip('xyz', rates):
            require(rate <= limits[axis] or math.isclose(rate, limits[axis], rel_tol=1e-12),
                    f'{name}: line {block["line"]} {axis.upper()} feed exceeds configured maximum')


def _merge_bounds(total, current):
    if current is None: return total
    if total is None: return {a: limits.copy() for a, limits in current.items()}
    for a in 'xyz':
        total[a][0] = min(total[a][0], current[a][0])
        total[a][1] = max(total[a][1], current[a][1])
    return total


def _path_geometry(parsed, placement, include_paths):
    """Transform every sampled vertex once, retaining paths only when requested.

    Bounds use the actual transformed vertices (including arc extrema), never
    rotated source bounding boxes. No geometry or reference cache is retained.
    """
    paths = [] if include_paths else None
    travel_low = [math.inf] * 3; travel_high = [-math.inf] * 3
    cut_low = [math.inf] * 3; cut_high = [-math.inf] * 3
    for path in parsed['paths']:
        points = [] if include_paths else None
        cutting = not path['rapid']
        for source in path['points']:
            point = transform(source, placement)
            for i, value in enumerate(point):
                if value < travel_low[i]: travel_low[i] = value
                if value > travel_high[i]: travel_high[i] = value
                if cutting:
                    if value < cut_low[i]: cut_low[i] = value
                    if value > cut_high[i]: cut_high[i] = value
            if include_paths: points.append(point)
        if include_paths: paths.append({**path, 'points': points})
    def result(low, high):
        return {a: [low[i], high[i]] for i, a in enumerate('xyz')} if low[0] != math.inf else None
    return paths, result(cut_low, cut_high), result(travel_low, travel_high)


class Workspace:
    def __init__(self):
        self.revision = 0
        self.workflow = defaults()
        self.name = 'Untitled PCB'; self.board_revision = ''; self.face = 'bottom'
        self.stock = {'x': 0., 'y': 0., 'width': 100., 'height': 70., 'thickness': 1., 'margin': 1., 'spoilAllowance': .5}
        self.placement = {'x': 0., 'y': 0., 'angle': 0., 'mirror': False}
        self.operations = []
        self.references = {label: {'design': None, 'machine': None, 'session': None} for label in LABELS}
        self.alignment = None
        self.tolerance = .05
        self.last_saved = None
        self.note = 'Draft placement. Teach references to establish alignment.'

    def changed(self):
        self.revision += 1

    def has_content(self):
        """Meaningful preparation worth preserving; not a dirty/live-authority flag."""
        empty = Workspace()
        fields = ('name', 'board_revision', 'face', 'stock', 'placement', 'tolerance', 'workflow')
        return bool(self.operations or any(getattr(self, k) != getattr(empty, k) for k in fields)
                    or any(p['design'] is not None or p['machine'] is not None for p in self.references.values()))

    def invalidate(self, reason, keep_design=True):
        for point in self.references.values():
            point.update(machine=None, session=None)
            if not keep_design: point['design'] = None
        refresh_tool_checks(self)
        self.workflow['camera'] = None
        self.alignment = None; self.note = reason; self.changed()

    def import_files(self, files):
        require(isinstance(files, list) and 1 <= len(files) <= 12, 'Choose 1–12 G-code files')
        require(len(self.operations)+len(files) <= 12, 'A job can contain up to 12 operations')
        require(sum(len(o['source'].encode()) for o in self.operations)+
                sum(len(f.get('source', '').encode()) for f in files if isinstance(f, dict) and isinstance(f.get('source'), str)) <= MAX_TOTAL,
                'Combined G-code must be at most 16 MB')
        additions = []
        for item in files:
            require(isinstance(item, dict), 'Invalid file record')
            name = text(item.get('name'), 'File name')
            require(name and '/' not in name and '\\' not in name and Path(name).suffix.lower() in ('.nc', '.gcode', '.tap', '.ngc', '.cnc'),
                    'Choose a .nc, .gcode, .tap, .ngc or .cnc file with a plain file name')
            require(name not in [o['name'] for o in self.operations+additions], 'File names must be unique')
            try: parsed = parse_gcode(item.get('source'))
            except ValueError as e: raise ValueError(f'{name}: {e}') from e
            name_lower = name.lower()
            role = next((role for fragment, role in [('isolat','isolation'), ('drill','drilling'), ('outline','outline'), ('clear','clearing')] if fragment in name_lower), 'other')
            additions.append({'id': uuid.uuid4().hex, 'name': name, 'source': item['source'], 'parsed': parsed,
                              'role': role, 'tool': '', 'diameter': None})
        require(sum(o['parsed']['pointCount'] for o in self.operations+additions) <= 660000, 'Combined preview is too large')
        self.operations.extend(additions)
        self.invalidate('Files changed. Teach alignment for this job.', keep_design=False)

    def configure(self, data):
        require(isinstance(data, dict), 'Expected job settings')
        name = text(data.get('name'), 'Job name')
        revision = text(data.get('boardRevision'), 'Board revision')
        face = data.get('face'); require(face in ('top', 'bottom'), 'Choose the machining face')
        stock = data.get('stock'); require(isinstance(stock, dict) and set(stock) == set(self.stock), 'Invalid stock settings')
        stock = {k: finite(v, k) for k, v in stock.items()}
        require(.1 <= stock['width'] <= 1000 and .1 <= stock['height'] <= 1000, 'Stock dimensions must be 0.1–1000 mm')
        require(.01 <= stock['thickness'] <= 100 and 0 <= stock['margin'] < min(stock['width'], stock['height'])/2,
                'Check stock thickness and edge margin')
        require(0 <= stock['spoilAllowance'] <= 3, 'Spoilboard allowance must be 0–3 mm')
        placement = data.get('placement')
        require(isinstance(placement, dict) and set(placement) == set(self.placement), 'Invalid placement')
        require(type(placement['mirror']) is bool, 'Mirror selection must be boolean')
        placement = {**{k: finite(placement[k], k) for k in ('x', 'y', 'angle')}, 'mirror': placement['mirror']}
        require(-360 <= placement['angle'] <= 360, 'Rotation must be between -360° and 360°')
        tolerance = finite(data.get('tolerance'), 'Alignment tolerance')
        require(.005 <= tolerance <= .5, 'Alignment check tolerance must be 0.005–0.5 mm')
        altered = placement != self.placement or stock != self.stock or face != self.face or tolerance != self.tolerance
        self.name = name or 'Untitled PCB'; self.board_revision = revision; self.face = face
        self.stock = stock; self.placement = placement; self.tolerance = tolerance
        if altered: self.invalidate('Placement, face or stock changed. Alignment needs a fresh check.')
        else: self.changed()

    def operation(self, data):
        op = next((o for o in self.operations if o['id'] == data.get('id')), None)
        require(op is not None, 'Operation no longer exists')
        action = data.get('action', 'update')
        if action == 'remove':
            self.operations.remove(op); self.invalidate('Operation removed; verify alignment for the remaining job.')
        elif action in ('up', 'down'):
            index = self.operations.index(op); target = index+(-1 if action == 'up' else 1)
            if 0 <= target < len(self.operations): self.operations[index], self.operations[target] = self.operations[target], op
            self.changed()
        else:
            require(action == 'update' and data.get('role') in ROLES, 'Invalid operation update')
            label = text(data.get('tool'), 'Tool description')
            diameter = data.get('diameter')
            if diameter is not None:
                diameter = finite(diameter, 'Effective cutting diameter')
                require(.01 <= diameter <= 20, 'Effective cutting diameter must be 0.01–20 mm')
            op.update(role=data['role'], tool=label, diameter=diameter); self.changed()

    def reference(self, label, design, machine=None, session=None):
        require(label in LABELS, 'Choose reference A, B or C')
        design = xy(design); machine = xy(machine) if machine is not None else None
        self.references[label] = {'design': design, 'machine': machine, 'session': session}
        self.alignment = None; self.note = 'Reference changed. Solve alignment to check it.'; self.changed()

    def solve(self, session):
        require(self.operations, 'Load the cutting files first')
        points = [self.references[label] for label in LABELS]
        require(all(p['design'] is not None and p['machine'] is not None for p in points[:2]),
                'Record design and observed XY for A and B')
        mirrored = {'x': 0, 'y': 0, 'angle': 0, 'mirror': self.placement['mirror']}
        a, b = [transform(p['design'], mirrored) for p in points[:2]]
        ma, mb = [p['machine'] for p in points[:2]]
        distance, measured = math.dist(a, b), math.dist(ma, mb)
        require(distance >= 5 and measured >= 5, 'Choose reference points at least 5 mm apart')
        mismatch = abs(distance-measured)
        require(mismatch <= self.tolerance, f'Reference spacing differs by {mismatch:.3f} mm; check points, units and axis calibration. Geometry will not be scaled.')
        angle = math.degrees(math.atan2(mb[1]-ma[1], mb[0]-ma[0])-math.atan2(b[1]-a[1], b[0]-a[0]))
        angle = (angle+180) % 360-180
        placed_a = transform(points[0]['design'], {**mirrored, 'angle': angle})
        placement = {'x': ma[0]-placed_a[0], 'y': ma[1]-placed_a[1], 'angle': angle, 'mirror': self.placement['mirror']}
        check_error = None
        if points[2]['design'] is not None and points[2]['machine'] is not None:
            c = transform(points[2]['design'], mirrored)
            altitude = abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/distance
            require(altitude >= 1, 'Reference C must be at least 1 mm away from the A–B line')
            check_error = math.dist(transform(points[2]['design'], placement), points[2]['machine'])
            require(check_error <= self.tolerance, f'Independent point C misses by {check_error:.3f} mm. Recheck alignment.')
        live = check_error is not None and all(p['session'] == session and session is not None for p in points)
        self.placement = placement
        self.alignment = {'baselineError': mismatch, 'checkError': check_error, 'session': session if live else None,
                          'status': 'captured' if live else 'draft', 'scale': 1}
        self.note = 'Three captured points agree; Z and height compensation remain separate.' if live else 'Draft alignment only. Capture A, B and C from this machine session for export.'
        self.changed()

    def valid_alignment(self, session):
        return bool(self.alignment and self.alignment['status'] == 'captured' and self.alignment['session'] == session)

    def public(self, session=None, include_paths=True):
        operations = []; issues = []; all_cut = None; all_travel = None
        s = self.stock; inset = s['margin']
        usable = {'x': [s['x']+inset, s['x']+s['width']-inset], 'y': [s['y']+inset, s['y']+s['height']-inset]}
        for op in self.operations:
            parsed = op['parsed']
            paths, cb, travel = _path_geometry(parsed, self.placement, include_paths)
            # Cover 0.01 mm arc tessellation plus accepted endpoint rounding.
            radius = (op['diameter'] or 0)/2+.02
            footprint = {a: [cb[a][0]-radius, cb[a][1]+radius] for a in 'xy'}
            fits = all(footprint[a][0] >= usable[a][0] and footprint[a][1] <= usable[a][1] for a in 'xy')
            depth_ok = -cb['z'][0] <= s['thickness']+s['spoilAllowance']
            if not fits: issues.append(op['name']+': cutter footprint extends outside the stock margin.')
            if not depth_ok: issues.append(op['name']+': depth exceeds stock thickness plus spoilboard allowance.')
            if not op['tool'] or op['diameter'] is None: issues.append(op['name']+': specify the cutter and its effective diameter.')
            dangerous = [w for w in parsed['warnings'] if not w.startswith('The initial approach')]
            issues.extend(op['name']+': '+w for w in dangerous)
            all_cut = _merge_bounds(all_cut, cb); all_travel = _merge_bounds(all_travel, travel)
            result = {k: op[k] for k in ('id', 'name', 'role', 'tool', 'diameter')}
            result.update({k: parsed[k] for k in ('sha256','warnings','feedMinutes','maxFeed','maxSpindle','lineCount')})
            result['warnings'] = list(parsed['warnings'])
            result.update(bounds=travel, cutBounds=cb, footprint=footprint, fits=fits, depthOk=depth_ok)
            if include_paths: result['paths'] = paths
            operations.append(result)
        if not operations: issues.append('Load at least one cutting file.')
        if not self.valid_alignment(session): issues.append('Capture and check A, B and C in the current machine session.')
        return {'revision': self.revision, 'hasContent': self.has_content(), 'name': self.name, 'boardRevision': self.board_revision, 'face': self.face,
                'stock': self.stock.copy(), 'placement': self.placement.copy(), 'operations': operations,
                'references': copy.deepcopy(self.references), 'alignment': copy.deepcopy(self.alignment), 'note': self.note,
                'tolerance': self.tolerance, 'cutBounds': all_cut, 'bounds': all_travel,
                'issues': issues, 'canExport': not issues, 'lastSaved': self.last_saved, 'workflow': copy.deepcopy(self.workflow)}

    def package(self, session=None):
        data = self.public(session, include_paths=False)
        return {'format': 'cnc-pcb-job', 'version': 1, 'savedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'executionReleased': False, 'heightCompensationAddedByWorkbench': False, 'sourceHeightCompensation': 'unknown',
                'job': data, 'files': [{k: o[k] for k in ('name','source','role','tool','diameter')} |
                                     {'sha256': o['parsed']['sha256']} for o in self.operations]}

    @classmethod
    def from_package(cls, package):
        require(isinstance(package, dict) and package.get('format') == 'cnc-pcb-job' and package.get('version') == 1,
                'Choose a supported PCB job package')
        files = package.get('files')
        require(isinstance(files, list) and len(files) <= 12, 'Invalid job files')
        workspace = cls()
        if files: workspace.import_files(files)
        job = package.get('job'); require(isinstance(job, dict), 'Invalid job package')
        workspace.configure(job)
        for op, saved in zip(workspace.operations, package['files']):
            require(op['parsed']['sha256'] == saved.get('sha256'), 'Saved file hash does not match its contents')
            workspace.operation({'id': op['id'], **{k: saved.get(k) for k in ('role','tool','diameter')}})
        workspace.workflow = restore_workflow(job.get('workflow'), workspace.operations, job.get('operations', []))
        refresh_tool_checks(workspace)
        references = job.get('references', {})
        require(isinstance(references, dict), 'Invalid references')
        for label in LABELS:
            point = references.get(label, {})
            require(isinstance(point, dict), 'Invalid reference')
            if point.get('design') is not None: workspace.reference(label, point['design'])
        workspace.note = 'Setup reopened. Previous machine references and surface approval were discarded.'
        return workspace

    def export(self, session, work_offset, demo=False, *, profile=None):
        """Real exports require profile=validated server config, never client input.

        Demo may omit profile; its .nc.txt drafts then have no machine-limit
        verification. Neither form grants physical reference or cutting authority.
        """
        public = self.public(session, include_paths=False)
        require(public['canExport'], 'Resolve all preparation checks before exporting an aligned draft')
        limits = export_limits(profile, demo)
        prepared = [aligned_gcode(op['parsed'], self.placement, work_offset) for op in self.operations]
        if limits is not None:
            for op, source in zip(self.operations, prepared):
                check_export_rates(parse_gcode(source), limits, op['name'])
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('job.pcb-job.json', json.dumps(self.package(session), indent=2))
            archive.writestr('READ-ME.txt',
                ('SIMULATED DEMO ALIGNMENT. DO NOT MACHINE THESE FILES.\n' if demo else '')+
                'Prepared alignment draft; no file has been sent to UGS.\n'
                'XY is transformed once into the recorded G54 frame. Original work Z is retained.\n'
                'Establish the actual copper-face Z reference for each fitted cutter. Check whether the source is already compensated before applying a height map.\n'
                'Inspect initial approach, all paths, workholding, tabs and clearance in UGS. Remove probe clip before spindle use.\n'
                'Re-fixturing, a board flip, reference loss or a new connection invalidates this placement.\n'
                'Split files remain separate tool operations; each prepared file begins spindle off and paused.\n')
            for index, (op, source) in enumerate(zip(self.operations, prepared), 1):
                archive.writestr('originals/'+op['name'], op['source'])
                filename = f'{index:02d}-'+Path(op['name']).stem+'-ALIGNED-DRAFT.nc'+('.txt' if demo else '')
                archive.writestr('prepared/'+filename, source)
            archive.writestr('reference.json', json.dumps({'g54XY': {a: work_offset[a] for a in 'xy'},
                             'placementInMachineCoordinates': self.placement, 'simulation': demo,
                             'configuredLimits': limits, 'machineLimitsChecked': limits is not None,
                             'referenceValidAfterReconnect': False, 'cuttingReleased': False}, indent=2))
        return output.getvalue()
