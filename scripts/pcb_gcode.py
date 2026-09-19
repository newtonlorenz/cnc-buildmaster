"""Strict, offline PCB toolpath reader and rigid XY placement.

Supported GRBL subset is explicit. Unknown geometry is rejected, never skipped.
No machine access. The first approach from the live tool position is not inferred.
"""
import hashlib
import math
import re

MAX_SOURCE = 4_000_000
MAX_POINTS = 220_000
WORD = re.compile(r'([A-Z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))')
GROUPS = [{0., 1., 2., 3., 80.}, {20., 21.}, {90., 91.}, {17.}, {91.1},
          {94.}, {54.}, {40.}, {49.}, {4.}]
G_CODES = set().union(*GROUPS)
M_GROUPS = [{0, 1, 2, 30}, {3, 4, 5}, {7, 8, 9}]


def require(ok, message):
    if not ok:
        raise ValueError(message)


def finite(value, name='value', limit=100000):
    require(type(value) in (int, float) and math.isfinite(value) and abs(value) <= limit,
            f'{name} must be a finite number within ±{limit}')
    return float(value)


def words(line):
    out = []; comment = False
    for ch in line:
        if ch == ';' and not comment: break
        if ch == '(':
            require(not comment, 'Nested comments are unsupported')
            comment = True
        elif ch == ')':
            require(comment, 'Unmatched comment ending'); comment = False
        elif not comment:
            require(ch in '\t\r\n ' or 32 <= ord(ch) < 127, 'Non-ASCII command character')
            out.append(ch)
    require(not comment, 'Unclosed comment')
    code = ''.join(out).upper().replace(' ', '').replace('\t', '').strip()
    if not code or code == '%': return []
    matches = list(WORD.finditer(code))
    require(''.join(m.group() for m in matches) == code, 'Unsupported syntax or non-G-code command')
    values = [(m[1], float(m[2])) for m in matches]
    require(all(k in 'GMXYZIJRFSPTN' and math.isfinite(v) and abs(v) <= 1e7 for k, v in values),
            'Unsupported word or number outside bounds')
    for key in 'XYZIJRFSPTN':
        require(sum(k == key for k, _ in values) <= 1, f'Duplicate {key} word')
    return values


def sweep(start, end, centre, clockwise):
    a = math.atan2(start[1]-centre[1], start[0]-centre[0])
    b = math.atan2(end[1]-centre[1], end[0]-centre[0])
    delta = (b-a) % math.tau
    if clockwise: delta = -((a-b) % math.tau)
    if abs(delta) < 1e-12: delta = -math.tau if clockwise else math.tau
    return a, delta


def arc(start, end, values, unit, clockwise):
    require(all(v is not None for v in start), 'Arc needs a known starting XYZ')
    require(('R' in values) != ('I' in values or 'J' in values), 'Arc needs either R or I/J')
    if 'R' in values:
        radius = values['R']*unit
        dx, dy = end[0]-start[0], end[1]-start[1]
        chord = math.hypot(dx, dy)
        require(chord > 1e-8 and abs(radius) >= chord/2, 'Invalid radius arc')
        height = math.sqrt(max(0, radius*radius-chord*chord/4))
        candidates = [[(start[0]+end[0])/2-sign*dy/chord*height,
                       (start[1]+end[1])/2+sign*dx/chord*height] for sign in (1, -1)]
        centre = candidates[0] if height < 1e-10 else next((c for c in candidates if
                       (abs(sweep(start, end, c, clockwise)[1]) <= math.pi+1e-9) == (radius >= 0)), None)
        require(centre is not None, 'Ambiguous radius arc')
    else:
        centre = [start[0]+values.get('I', 0)*unit, start[1]+values.get('J', 0)*unit]
    radius = math.dist(start[:2], centre)
    require(radius > 1e-8 and abs(radius-math.dist(end[:2], centre)) <= .005, 'Arc endpoint is not on its circle')
    angle, delta = sweep(start, end, centre, clockwise)
    # <=0.01 mm sagitta, with exact cardinal extrema included for bounds checking.
    step = min(math.pi/24, 2*math.acos(max(-1, 1-.01/radius)))
    count = max(1, math.ceil(abs(delta)/max(step, 1e-6)))
    require(count <= 20000, 'Arc is too large to preview')
    fractions = {i/count for i in range(count+1)}
    for cardinal in (0, math.pi/2, math.pi, 3*math.pi/2):
        distance = (cardinal-angle) % math.tau if delta > 0 else (angle-cardinal) % math.tau
        if distance <= abs(delta)+1e-9: fractions.add(min(1, distance/abs(delta)))
    points = [[centre[0]+radius*math.cos(angle+delta*t),
               centre[1]+radius*math.sin(angle+delta*t), start[2]+(end[2]-start[2])*t]
              for t in sorted(fractions)]
    points[0] = start.copy(); points[-1] = end.copy()
    return centre, points, math.hypot(radius*delta, end[2]-start[2])


def bounds(points):
    values = list(points)
    return {a: [min(p[i] for p in values), max(p[i] for p in values)] for i, a in enumerate('xyz')} if values else None


def parse_gcode(source):
    require(isinstance(source, str) and 0 < len(source.encode()) <= MAX_SOURCE, 'File must contain at most 4 MB of G-code')
    unit = None; absolute = None; plane = None; motion = None; feed = None; spindle = False; speed = None
    position = [None, None, None]; paths = []; blocks = []; warnings = set()
    point_count = 0; minutes = 0.; ended = False; max_feed = 0.; max_spindle = 0.
    source_lines = source.splitlines()
    require(len(source_lines) <= 100000, 'File has too many lines')
    for lineno, line in enumerate(source_lines, 1):
        try:
            tokens = words(line)
            if not tokens: continue
            require(not ended, 'Commands after program end')
            gs = [v for k, v in tokens if k == 'G']; ms = [v for k, v in tokens if k == 'M']
            vals = {k: v for k, v in tokens if k not in 'GMN'}
            require(all(v.is_integer() and 0 <= v <= 9999999 for k, v in tokens if k == 'N'), 'Invalid line number')
            require(set(gs) <= G_CODES, 'Unsupported G-code (offset changes, probing, homing, canned cycles and non-XY planes are not previewed)')
            require(all(v in set().union(*M_GROUPS) for v in ms), 'Unsupported M-code; split tool changes into separate files')
            for group in GROUPS:
                require(sum(v in group for v in gs) <= 1, 'Conflicting G-code modes')
            for group in M_GROUPS:
                require(sum(v in group for v in ms) <= 1, 'Conflicting M-code modes')
            if 20 in gs: unit = 25.4
            if 21 in gs: unit = 1.
            if 90 in gs: absolute = True
            if 91 in gs: absolute = False
            if 17 in gs: plane = 'XY'
            for g in gs:
                if g in (0, 1, 2, 3, 80): motion = int(g)
            if 'F' in vals:
                require(unit is not None and vals['F'] > 0, 'Declare units before a positive feed')
                feed = vals['F']*unit; max_feed = max(max_feed, feed)
            if 'S' in vals:
                require(vals['S'] >= 0, 'Spindle command must be nonnegative')
                speed = vals['S']
                max_spindle = max(max_spindle, vals['S'])
            if 'T' in vals: require(vals['T'] >= 0 and vals['T'].is_integer(), 'Invalid tool number')
            if any(m in (3, 4) for m in ms):
                spindle = True
                if speed is None or speed <= 0: warnings.add('Spindle start needs an explicit positive S command.')
            if 5 in ms: spindle = False
            if any(m in (2, 30) for m in ms): ended = True
            block = {'line': lineno, 'm': [int(m) for m in ms], 'extra': {k: vals[k] for k in 'ST' if k in vals}}
            if 'F' in vals: block['feed'] = feed
            if 4 in gs:
                require('P' in vals and vals['P'] >= 0 and not any(k in vals for k in 'XYZIJR'), 'Dwell needs P and no motion words')
                block['dwell'] = vals['P']
            else: require('P' not in vals, 'Unexpected P word')
            has_axes = any(k in vals for k in 'XYZ')
            has_arc = any(k in vals for k in 'IJR')
            if has_axes or has_arc:
                require(unit is not None and absolute is not None and motion in (0, 1, 2, 3), 'Declare units, distance and motion mode before coordinates')
                require(4 not in gs and not ended, 'Motion mixed with dwell or program end')
                require(not has_arc or motion in (2, 3), 'Arc words on non-arc motion')
                target = position.copy()
                for i, a in enumerate('XYZ'):
                    if a in vals:
                        require(absolute or position[i] is not None, 'Incremental move starts from an unknown coordinate')
                        target[i] = vals[a]*unit+(0 if absolute else position[i])
                        require(abs(target[i]) <= 100000, 'Coordinate outside preview bounds')
                # A rotated first XY position cannot be reconstructed from one unknown axis.
                if 'X' in vals or 'Y' in vals:
                    require(target[0] is not None and target[1] is not None, 'First XY move must establish both X and Y')
                    if target[2] is None: warnings.add('XY positioning begins before the file establishes a Z clearance.')
                if motion != 0:
                    require(all(v is not None for v in target) and all(v is not None for v in position),
                            'Establish XYZ with rapid positioning before a cutting move')
                    require(feed is not None, 'Cutting move needs a positive feed')
                    if not spindle or speed is None or speed <= 0:
                        warnings.add('A feed move occurs while the spindle is not commanded on at a positive speed.')
                known = all(v is not None for v in position+target)
                centre = None
                if motion in (2, 3):
                    require(plane == 'XY', 'Declare G17 before an XY arc')
                    centre, points, distance = arc(position, target, vals, unit, motion == 2)
                else:
                    points = [position.copy(), target.copy()] if known else ([target.copy()] if all(v is not None for v in target) else [])
                    distance = math.dist(position, target) if known else 0
                if motion == 0 and known and position[:2] != target[:2] and min(position[2], target[2]) <= 0:
                    warnings.add('Rapid XY travel reaches or crosses Z0. Check clearance in UGS.')
                if motion and known: minutes += distance/feed
                point_count += len(points)
                require(point_count <= MAX_POINTS, 'Toolpath is too large to preview')
                move = {'g': motion, 'from': position.copy(), 'to': target.copy(),
                        'axes': [a for a in 'XYZ' if a in vals], 'centre': centre}
                block['move'] = move
                if points: paths.append({'rapid': motion == 0, 'points': points, 'line': lineno})
                position = target
            blocks.append(block)
        except ValueError as e:
            raise ValueError(f'Line {lineno}: {e}') from e
    require(paths and any(not p['rapid'] for p in paths), 'No complete cutting toolpath found')
    if spindle and not ended: warnings.add('File ends with the spindle commanded on.')
    if position[2] is not None and position[2] <= 0: warnings.add('File ends at or below Z0.')
    warnings.add('The initial approach from the machine position is not shown.')
    return {'sha256': hashlib.sha256(source.encode()).hexdigest(), 'paths': paths, 'blocks': blocks,
            'bounds': bounds(p for path in paths for p in path['points']),
            'cutBounds': bounds(p for path in paths if not path['rapid'] for p in path['points']),
            'warnings': sorted(warnings), 'feedMinutes': minutes, 'maxFeed': max_feed,
            'maxSpindle': max_spindle, 'pointCount': point_count, 'lineCount': len(source_lines)}


def transform(point, placement):
    x, y = point[:2]
    if placement['mirror']: x = -x
    a = math.radians(placement['angle']); c, s = math.cos(a), math.sin(a)
    return [c*x-s*y+placement['x'], s*x+c*y+placement['y'], *point[2:]]


def aligned_gcode(parsed, placement, work_offset):
    """Prepared draft in current G54 XY; original work Z and feeds are preserved."""
    offset = [finite(work_offset[a], 'G54 '+a) for a in 'xy']
    out = ['(ALIGNED DRAFT - verify Z datum, height compensation and clearance in UGS)',
           '(XY placement applied once. Do not rotate or mirror again.)', 'G21 G90 G17 G94 G54 G40 G49 G91.1', 'M5', 'M0']
    def n(v): return f'{v:.6f}'.rstrip('0').rstrip('.') if abs(v) >= .0000005 else '0'
    for block in parsed['blocks']:
        parts = ['M'+str(m) for m in block['m']]
        parts += [k+n(v) for k, v in block['extra'].items()]
        if 'feed' in block: parts.append('F'+n(block['feed']))
        if 'dwell' in block: parts += ['G4', 'P'+n(block['dwell'])]
        move = block.get('move')
        if move:
            g = move['g']
            if g in (2, 3) and placement['mirror']: g = 5-g
            parts.append('G'+str(g))
            if move['centre'] is not None or any(a in move['axes'] for a in 'XY'):
                target = transform(move['to'], placement)
                parts += [a+n(target[i]-offset[i]) for i, a in enumerate('XY')]
            if 'Z' in move['axes']: parts.append('Z'+n(move['to'][2]))
            if move['centre'] is not None:
                centre = transform(move['centre'], placement); start = transform(move['from'], placement)
                parts += [a+n(centre[i]-start[i]) for i, a in enumerate('IJ')]
        if parts: out.append(' '.join(parts))
    return '\n'.join(out)+'\n'
