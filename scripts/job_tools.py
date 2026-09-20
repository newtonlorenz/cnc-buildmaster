"""Bounded, offline job preparation. No I/O, machine access or implicit defaults.

Public functions accept JSON-compatible records and raise ValueError on invalid
input. All lengths are mm, feeds mm/min, and Z increases upwards. Geometry must
share one declared work frame with the material surface at Z0. Configuration
review flags are caller assertions, never evidence of physical qualification.

Fixture bounds contain the complete XY tool/holder footprint and the tool TIP's
Z range (not the machine carriage or holder top). Clamps are rectangular prisms.
The holder is conservatively treated as a column extending upwards from the
exposed tool length. Unmodelled machine parts and the initial approach remain
outside this inspection. None of these results releases a job for execution.
"""

import copy
import datetime
import math
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR

from pcb_gcode import MAX_POINTS, parse_gcode, transform

MAX_CLAMPS = 64
MAX_INTERSECTIONS = 2_000_000
MAX_FINDINGS = 1000
MAX_DRAFT_LINES = 20_000
MAX_PASSES = 100
MAX_RASTER_ROWS = 1000
# pcb_gcode uses <= .01 mm arc sagitta and accepts .005 mm endpoint error.
PATH_ALLOWANCE = .02
_GRID = Decimal('0.000001')
REVIEW_FLAGS = ('machineReviewed', 'toolReviewed', 'materialReviewed',
                'workholdingReviewed', 'coordinateFrameReviewed', 'spindleReviewed')


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _record(value, keys, name):
    _require(type(value) is dict and set(value) == set(keys),
             name + ' has missing or unsupported fields')
    return value


def _number(value, name, low=-100000, high=100000):
    # Check magnitude before math.isfinite: arbitrarily large JSON integers must
    # produce ValueError rather than OverflowError during float conversion.
    _require(type(value) in (int, float) and low <= value <= high
             and math.isfinite(value), f'{name} must be finite, from {low} to {high}')
    return float(value)


def _integer(value, name, low, high):
    _require(type(value) is int and low <= value <= high,
             f'{name} must be an integer from {low} to {high}')
    return value


def _boolean(value, name):
    _require(type(value) is bool, name + ' must be boolean')
    return value


def _text(value, name, limit=120):
    _require(type(value) is str and 0 < len(value) <= limit and value.strip()
             and all(c.isprintable() or c == '\n' for c in value),
             name + ' must be nonempty text within its size limit')
    return value  # Evidence wording, including whitespace, is never normalised.


def _vector(value, name, size=3, low=-100000, high=100000):
    _require(type(value) is list and len(value) == size, name + ' has the wrong dimensions')
    return [_number(v, name, low, high) for v in value]


def _bounds(value, axes='xyz'):
    _record(value, axes, 'Bounds')
    result = {a: _vector(value[a], 'Bounds.' + a, 2) for a in axes}
    for a, (lo, hi) in result.items():
        _require(lo < hi and hi - lo <= 1000, 'Bounds.' + a + ' must span >0 and <=1000 mm')
    return result


def validate_tool(tool):
    """Return a new tool record: diameter, cuttingLength, length, holderDiameter.

    length is exposed tip-to-holder distance, not overall purchased tool length.
    diameter is the maximum exposed tool/shaft diameter, including a V-bit shank;
    an estimated engraving width is insufficient for collision inspection.
    """
    _record(tool, ('diameter', 'cuttingLength', 'length', 'holderDiameter'), 'Tool')
    result = {
        'diameter': _number(tool['diameter'], 'Tool diameter', .01, 50),
        'cuttingLength': _number(tool['cuttingLength'], 'Cutting length', .001, 300),
        'length': _number(tool['length'], 'Exposed tool length', .001, 300),
        'holderDiameter': _number(tool['holderDiameter'], 'Holder diameter', .01, 100),
    }
    _require(result['cuttingLength'] <= result['length'], 'Cutting length exceeds exposed tool length')
    _require(result['holderDiameter'] >= result['diameter'], 'Holder diameter must cover the tool diameter')
    return result


def validate_fixture(fixture):
    """Validate {bounds:{x,y,z}, clearance, clamps:[{id,x,y,width,height,baseZ,heightZ}]}.

    Bounds are a reviewed safe footprint envelope, not advertised machine travel.
    Clamp x/y are lower rectangle edges; height is its Y size, heightZ its vertical
    extent. All clamp prisms must fit within bounds. clearance expands obstacles
    and shrinks usable XY bounds; touching an expanded clamp counts as collision.
    """
    _record(fixture, ('bounds', 'clearance', 'clamps'), 'Fixture')
    safe = _bounds(fixture['bounds'])
    clearance = _number(fixture['clearance'], 'Clearance margin', 0, 50)
    _require(2 * clearance < min(safe[a][1] - safe[a][0] for a in 'xy'),
             'Clearance consumes the fixture bounds')
    clamps = fixture['clamps']
    _require(type(clamps) is list and len(clamps) <= MAX_CLAMPS, 'Too many or invalid clamps')
    result = []
    ids = set()
    for clamp in clamps:
        _record(clamp, ('id', 'x', 'y', 'width', 'height', 'baseZ', 'heightZ'), 'Clamp')
        label = _text(clamp['id'], 'Clamp id')
        _require(label not in ids, 'Clamp ids must be unique')
        ids.add(label)
        c = {'id': label, **{k: _number(clamp[k], 'Clamp ' + k) for k in ('x', 'y', 'baseZ')},
             **{k: _number(clamp[k], 'Clamp ' + k, .001, 1000) for k in ('width', 'height', 'heightZ')}}
        for a, lower, extent in (('x', 'x', 'width'), ('y', 'y', 'height'), ('z', 'baseZ', 'heightZ')):
            _require(safe[a][0] <= c[lower] and c[lower] + c[extent] <= safe[a][1],
                     'Clamp extends outside fixture bounds')
        result.append(c)
    return {'bounds': safe, 'clearance': clearance, 'clamps': result}


def _placement(value):
    _record(value, ('x', 'y', 'angle', 'mirror'), 'Placement')
    return {'x': _number(value['x'], 'Placement X'), 'y': _number(value['y'], 'Placement Y'),
            'angle': _number(value['angle'], 'Placement angle', -360, 360),
            'mirror': _boolean(value['mirror'], 'Placement mirror')}


def _intersects(start, end, limits):
    """Closed segment/slab intersection; endpoints alone are insufficient."""
    enter, leave = 0., 1.
    for axis, (lower, upper) in enumerate(limits):
        delta = end[axis] - start[axis]
        if delta == 0:
            if not lower <= start[axis] <= upper:
                return False
        else:
            a, b = (lower - start[axis]) / delta, (upper - start[axis]) / delta
            enter, leave = max(enter, min(a, b)), min(leave, max(a, b))
            if enter > leave:
                return False
    return True


def _inside_xy(point, safe, radius):
    # Decimal comparisons avoid accepting a tiny overrun through an epsilon, or
    # rejecting exact decimal boundaries due to subtraction roundoff.
    r = Decimal(str(radius))
    return all(Decimal(str(safe[a][0])) <= Decimal(str(point[i])) - r
               and Decimal(str(point[i])) + r <= Decimal(str(safe[a][1]))
               for i, a in enumerate('xy'))


def inspect_fixture_paths(parsed, placement, fixture, tool):
    """Inspect pcb_gcode.parse_gcode() paths after rigid XY placement, without I/O.

    Every known segment, including G0 and vertical moves, is checked against
    expanded clamp rectangles in 3D. A .02 mm XY allowance covers parser arc
    approximation. Bounds use the holder's full XY footprint at every height,
    conservatively; Z bounds apply to the tip. Single known endpoints are checked
    but cannot establish the missing initial approach. Returned `modelClear`
    means only that this bounded geometric model found no conflict.
    """
    fixture, tool, placement = validate_fixture(fixture), validate_tool(tool), _placement(placement)
    _require(type(parsed) is dict and type(parsed.get('paths')) is list
             and 0 < len(parsed['paths']) <= MAX_POINTS, 'Expected nonempty parsed paths')
    paths = []
    total = 0
    segments = 0
    for path in parsed['paths']:
        _require(type(path) is dict, 'Invalid path')
        rapid = _boolean(path.get('rapid'), 'Path rapid')
        line = _integer(path.get('line'), 'Path line', 1, 100000)
        points = path.get('points')
        _require(type(points) is list and 0 < len(points) <= MAX_POINTS, 'Invalid path points')
        total += len(points)
        segments += max(1, len(points) - 1)
        _require(total <= MAX_POINTS, 'Too many path points')
        _require(segments * max(1, len(fixture['clamps'])) <= MAX_INTERSECTIONS,
                 'Fixture inspection exceeds the segment/clamp work cap')
        points = [_vector(transform(_vector(p, 'Path XYZ'), placement), 'Transformed XYZ') for p in points]
        paths.append((line, rapid, points))

    margin = fixture['clearance']
    tool_radius = _decimal(tool['diameter']) / 2 + _decimal(margin) + _decimal(PATH_ALLOWANCE)
    holder_radius = _decimal(tool['holderDiameter']) / 2 + _decimal(margin) + _decimal(PATH_ALLOWANCE)
    collisions, outside = [], []
    collision_count = outside_count = 0
    for line, rapid, points in paths:
        if any(not _inside_xy(p, fixture['bounds'], holder_radius)
               or not fixture['bounds']['z'][0] <= p[2] <= fixture['bounds']['z'][1] for p in points):
            outside_count += 1
            if len(outside) < MAX_FINDINGS:
                outside.append({'line': line, 'rapid': rapid})
        pairs = zip(points, points[1:]) if len(points) > 1 else [(points[0], points[0])]
        for index, (start, end) in enumerate(pairs):
            for clamp in fixture['clamps']:
                top = clamp['baseZ'] + clamp['heightZ']
                components = []
                for name, radius, lower, upper in (
                    ('tool', float(tool_radius), clamp['baseZ'] - tool['length'] - margin, top + margin),
                    ('holder', float(holder_radius), -math.inf, top - tool['length'] + margin),
                ):
                    limits = [(clamp['x'] - radius, clamp['x'] + clamp['width'] + radius),
                              (clamp['y'] - radius, clamp['y'] + clamp['height'] + radius), (lower, upper)]
                    if _intersects(start, end, limits):
                        components.append(name)
                if components:
                    collision_count += 1
                    if len(collisions) < MAX_FINDINGS:
                        collisions.append({'line': line, 'segment': index, 'rapid': rapid,
                                           'clampId': clamp['id'], 'components': components})
    return {'modelClear': collision_count == outside_count == 0, 'collisions': collisions,
            'collisionCount': collision_count, 'outsideBounds': outside, 'outsideCount': outside_count,
            'findingsTruncated': collision_count > len(collisions) or outside_count > len(outside),
            'segmentsChecked': segments, 'initialApproachInspected': False, 'executionReleased': False,
            'warnings': ['Initial approach and unmodelled machine parts are not inspected.',
                         'This geometric inspection is not physical clearance qualification.']}


def _tolerance(value):
    return _number(value, 'Residual tolerance', .000001, 1)


def _at_z(value, z, name):
    point = _vector(value, name)
    _require(point[2] == z, name + ' must use the declared common Z')
    return point


def _altitude(a, b, c):
    distance = math.dist(a, b)
    return abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / distance if distance else 0


def calibrate_camera_offset(samples, check, *, common_z, tolerance):
    """Fit camera-centre offset from TWO fiducials; check a separate third one.

    Each record is {spindle:[x,y,z], camera:[x,y,z]}: carriage coordinates when
    the spindle and then camera centre were separately placed over the SAME
    fiducial. offsetXY = spindle - camera, so centreXY = carriageXY + offsetXY.
    The third record is excluded from the fit. All six captures must have exactly
    common_z; no Z scaling or motion is inferred. C must be off the A-B line.
    """
    z, tolerance = _number(common_z, 'Common Z'), _tolerance(tolerance)
    _require(type(samples) is list and len(samples) == 2, 'Use two offset samples and an independent third check')
    records = []
    for value in [*samples, check]:
        _record(value, ('spindle', 'camera'), 'Camera offset sample')
        records.append({k: _at_z(value[k], z, k) for k in ('spindle', 'camera')})
    for key in ('spindle', 'camera'):
        a, b, c = [r[key][:2] for r in records]
        _require(math.dist(a, b) >= 5 and _altitude(a, b, c) >= 1,
                 'Use a >=5 mm baseline and an independent third point >=1 mm off its line')
    offsets = [[r['spindle'][i] - r['camera'][i] for i in range(2)] for r in records]
    offset = [sum(o[i] for o in offsets[:2]) / 2 for i in range(2)]
    _vector(offset, 'Camera offset', 2, -1000, 1000)
    residuals = [math.dist(o, offset) for o in offsets]
    _require(max(residuals) <= tolerance, 'Camera offset residual exceeds tolerance')
    return {'offsetXY': offset, 'commonZ': z, 'tolerance': tolerance,
            'fitResiduals': residuals[:2], 'checkResidual': residuals[2],
            'samples': records[:2], 'check': records[2], 'status': 'numerically-checked',
            'physicalQualification': 'not-assessed', 'executionReleased': False}


def _image_sample(value, z, size):
    _record(value, ('image', 'machine'), 'Image sample')
    image = _vector(value['image'], 'Image point', 2, 0, 100000)
    _require(all(v <= bound for v, bound in zip(image, size)), 'Image point is outside the image')
    return {'image': image, 'machine': _at_z(value['machine'], z, 'Image sample XYZ')}


def fit_image_affine(samples, check, *, image_size, common_z, tolerance):
    """Fit 3-32 {image:[u,v], machine:[x,y,z]} pairs and check a held-out pair.

    image_size gives inclusive pixel-coordinate limits [maxU,maxV]. Image Y may
    point down; the affine model includes reflection, rotation, shear and scale.
    The camera pose, resolution, crop, focus and Z must remain unchanged. A
    centred/scaled least-squares fit rejects degenerate/ill-conditioned samples,
    collapsed output geometry, excessive fit residuals and a failed independent
    check. This cannot calibrate lens distortion or validate another Z plane.
    """
    z, tolerance = _number(common_z, 'Common Z'), _tolerance(tolerance)
    size = _vector(image_size, 'Image size', 2, 1, 100000)
    _require(type(samples) is list and 3 <= len(samples) <= 32, 'Use 3-32 affine fit samples')
    samples = [_image_sample(p, z, size) for p in samples]
    check = _image_sample(check, z, size)
    for i, sample in enumerate(samples):
        _require(all(math.dist(sample['image'], other['image']) >= 1 for other in samples[:i]),
                 'Image fit points must be distinct and >=1 pixel apart')
    _require(all(math.dist(check['image'], p['image']) >= 1
                 and math.dist(check['machine'][:2], p['machine'][:2]) >= .001 for p in samples),
             'Independent image check must not reuse a fit point')
    count = len(samples)
    centre = [math.fsum(p['image'][i] for p in samples) / count for i in range(2)]
    scale = [max(abs(p['image'][i] - centre[i]) for p in samples) for i in range(2)]
    _require(min(scale) >= .5, 'Image fit points are degenerate')
    uv = [[(p['image'][i] - centre[i]) / scale[i] for i in range(2)] for p in samples]
    uu = math.fsum(u * u for u, v in uv)
    vv = math.fsum(v * v for u, v in uv)
    uv_sum = math.fsum(u * v for u, v in uv)
    determinant = uu * vv - uv_sum * uv_sum
    _require(determinant > 1e-8 * uu * vv, 'Image fit points are collinear or ill-conditioned')
    matrix = []
    for axis in range(2):
        mean = math.fsum(p['machine'][axis] for p in samples) / count
        rhs_u = math.fsum(u * (p['machine'][axis] - mean) for (u, v), p in zip(uv, samples))
        rhs_v = math.fsum(v * (p['machine'][axis] - mean) for (u, v), p in zip(uv, samples))
        a = (rhs_u * vv - rhs_v * uv_sum) / determinant / scale[0]
        b = (rhs_v * uu - rhs_u * uv_sum) / determinant / scale[1]
        matrix.append([a, b, mean - a * centre[0] - b * centre[1]])
    for row in matrix:
        _vector(row, 'Affine coefficients', high=1e8, low=-1e8)
    a, b, _ = matrix[0]
    c, d, _ = matrix[1]
    norm_squared = a * a + b * b + c * c + d * d
    _require(norm_squared > 0 and abs(a * d - b * c) > 1e-8 * norm_squared,
             'Affine machine coordinates are collapsed or ill-conditioned')
    residuals = [math.dist(_apply_affine(matrix, p['image']), p['machine'][:2]) for p in [*samples, check]]
    _require(max(residuals) <= tolerance, 'Affine fit or independent check residual exceeds tolerance')
    return {'matrix': matrix, 'samples': samples, 'check': check, 'imageSize': size,
            'commonZ': z, 'tolerance': tolerance, 'fitResiduals': residuals[:-1],
            'checkResidual': residuals[-1], 'status': 'numerically-checked',
            'physicalQualification': 'not-assessed', 'executionReleased': False}


def _apply_affine(matrix, point):
    return [math.fsum((row[0] * point[0], row[1] * point[1], row[2])) for row in matrix]


def transform_image_point(calibration, image_point, *, common_z):
    """Return estimated work XYZ at the unchanged camera pose and calibrated Z.

    Refit retained evidence instead of trusting imported matrix/status fields.
    Reject a changed model, Z, nonfinite pixel or pixel outside image bounds.
    Applying the model within the image can still extrapolate beyond fiducials;
    the return value is an estimate, never a movement command.
    """
    _require(type(calibration) is dict, 'Expected affine calibration')
    required = ('samples', 'check', 'imageSize', 'commonZ', 'tolerance', 'matrix')
    _require(all(k in calibration for k in required), 'Incomplete affine calibration')
    z = _number(common_z, 'Common Z')
    _require(z == calibration['commonZ'], 'Camera Z has changed; recalibrate')
    fitted = fit_image_affine(calibration['samples'], calibration['check'],
                              image_size=calibration['imageSize'], common_z=z,
                              tolerance=calibration['tolerance'])
    _require(calibration['matrix'] == fitted['matrix'], 'Affine matrix differs from its calibration evidence')
    pixel = _vector(image_point, 'Image point', 2, 0, 100000)
    _require(all(v <= bound for v, bound in zip(pixel, fitted['imageSize'])), 'Image point is outside the image')
    return _vector([*_apply_affine(fitted['matrix'], pixel), z], 'Estimated work XYZ')


def vbit_effective_diameter(tip_diameter, included_angle, depth, *, max_diameter):
    """Estimate tip + 2*depth*tan(included_angle/2); no runout/material allowance.

    Angles are degrees; depth is positive below the surface. max_diameter is the
    known cutting-head diameter. Reject depths outside that cone instead of
    silently capping the estimate. This is not a measured kerf or a recipe.
    """
    tip = _number(tip_diameter, 'Tip diameter', 0, 50)
    angle = _number(included_angle, 'Included angle', 1, 179)
    depth = _number(depth, 'V-bit depth', 0, 10)
    maximum = _number(max_diameter, 'Maximum cutting diameter', .01, 50)
    diameter = tip + 2 * depth * math.tan(math.radians(angle) / 2)
    _require(tip <= maximum and diameter <= maximum, 'Depth exceeds the known V-bit cutting diameter')
    return diameter


def _parameters(value, tool):
    _record(value, ('feed', 'plungeFeed', 'depth', 'passDepth', 'clearZ', 'spindleCommand'), 'Parameters')
    limits = {'feed': (.001, 3000), 'plungeFeed': (.001, 300), 'depth': (.000001, 3),
              'passDepth': (.000001, 1), 'clearZ': (.000001, 300), 'spindleCommand': (1, 1000000)}
    result = {k: _number(value[k], k, *limit) for k, limit in limits.items()}
    _require(result['passDepth'] <= result['depth'] <= tool['cuttingLength'],
             'Depth exceeds cutting length, or pass depth exceeds total depth')
    _require(result['plungeFeed'] <= result['feed'], 'Plunge feed exceeds cutting feed')
    return result


def validate_recipe(recipe):
    """Copy a bounded recipe record, retaining dated user observations verbatim.

    Schema: {version:1,name,material,tool,parameters,observations}. Each observation
    has {date:YYYY-MM-DD,source,scope,observation,measurements}, where measurements
    maps up to 32 labels to {value,unit}. Negative/zero observations are retained.
    This validates structure and parameter ranges, not a physically qualified
    process. Caller-supplied qualification/release flags are unsupported.
    """
    _record(recipe, ('version', 'name', 'material', 'tool', 'parameters', 'observations'), 'Recipe')
    _integer(recipe['version'], 'Recipe version', 1, 1)
    _text(recipe['name'], 'Recipe name')
    _text(recipe['material'], 'Recipe material', 500)
    tool = validate_tool(recipe['tool'])
    parameters = _parameters(recipe['parameters'], tool)
    observations = recipe['observations']
    _require(type(observations) is list and len(observations) <= 100, 'Use at most 100 observations')
    for observation in observations:
        _record(observation, ('date', 'source', 'scope', 'observation', 'measurements'), 'Observation')
        date = _text(observation['date'], 'Observation date', 10)
        try:
            _require(datetime.date.fromisoformat(date).isoformat() == date, 'Use YYYY-MM-DD dates')
        except ValueError as error:
            raise ValueError('Use valid YYYY-MM-DD observation dates') from error
        for field, limit in (('source', 500), ('scope', 1000), ('observation', 4000)):
            _text(observation[field], field, limit)
        measurements = observation['measurements']
        _require(type(measurements) is dict and len(measurements) <= 32, 'Invalid observation measurements')
        for label, measurement in measurements.items():
            _text(label, 'Measurement label')
            _record(measurement, ('value', 'unit'), 'Measurement')
            _number(measurement['value'], 'Observed measurement', -1e9, 1e9)
            _text(measurement['unit'], 'Measurement unit', 40)
    return {'record': copy.deepcopy({**recipe, 'tool': tool, 'parameters': parameters}),
            'status': 'recorded-unqualified', 'physicalQualification': 'not-assessed', 'executionReleased': False}


def _decimal(value):
    return Decimal(str(value))


def _grid(value, name):
    decimal = _decimal(value)
    _require(decimal == decimal.quantize(_GRID), name + ' permits at most six decimal places')
    return decimal


def _draft_setup(spec, reviewed, demo):
    _boolean(demo, 'Demo mode')
    _record(reviewed, ('configured', *REVIEW_FLAGS, 'maxFeed', 'maxPlungeFeed', 'maxSpindleCommand'), 'Review')
    configured = _boolean(reviewed['configured'], 'Configured')
    _require(demo or configured, 'Real draft export needs a configured installation')
    for flag in REVIEW_FLAGS:
        _require(_boolean(reviewed[flag], flag), 'Review required: ' + flag)
    # Machine capabilities are not requested cutting parameters. A faster
    # installation must still accept conservative drafts; _parameters retains
    # the separate 3000/300 mm/min preparation limits.
    caps = {'feed': _number(reviewed['maxFeed'], 'Maximum feed', .001, 100000),
            'plungeFeed': _number(reviewed['maxPlungeFeed'], 'Maximum plunge feed', .001, 100000),
            'spindleCommand': _number(reviewed['maxSpindleCommand'], 'Maximum spindle command', 1, 1e9)}
    _record(spec, ('fixture', 'area', 'tool', 'parameters'), 'Draft specification')
    fixture, tool = validate_fixture(spec['fixture']), validate_tool(spec['tool'])
    area = _bounds(spec['area'], 'xy')
    parameters = _parameters(spec['parameters'], tool)
    for name, cap in caps.items():
        _require(parameters[name] <= cap, name + ' exceeds reviewed configuration')
    for name, value in parameters.items():
        _grid(value, name)
    for a in 'xy':
        for value in area[a]:
            _grid(value, 'Area ' + a)
        _require(fixture['bounds'][a][0] <= area[a][0] and area[a][1] <= fixture['bounds'][a][1],
                 'Draft area exceeds exact fixture bounds')
    _require(fixture['bounds']['z'][0] <= -parameters['depth']
             and parameters['clearZ'] <= fixture['bounds']['z'][1], 'Draft depth or clear Z exceeds exact Z bounds')
    _require(parameters['clearZ'] > 0, 'Clear Z must be above the Z0 surface')
    _require(_decimal(tool['length']) - _decimal(parameters['depth']) > _decimal(fixture['clearance']),
             'Exposed tool length does not clear the holder above the material')
    # Use inward rounding; rounded commands must never leave the requested area.
    inset = _decimal(tool['diameter']) / 2 + _decimal(fixture['clearance']) + _decimal(PATH_ALLOWANCE)
    centre = {a: [(_decimal(area[a][0]) + inset).quantize(_GRID, rounding=ROUND_CEILING),
                  (_decimal(area[a][1]) - inset).quantize(_GRID, rounding=ROUND_FLOOR)] for a in 'xy'}
    _require(all(hi - lo >= _GRID for lo, hi in centre.values()), 'Tool and margins consume the draft area')
    depth, step = _decimal(parameters['depth']), _decimal(parameters['passDepth'])
    count = int((depth / step).to_integral_value(rounding=ROUND_CEILING))
    _require(count <= MAX_PASSES, 'Draft exceeds the depth pass cap')
    levels = [-min(depth, step * i) for i in range(1, count + 1)]
    return fixture, tool, parameters, centre, levels


def _format(value):
    return format(_decimal(value).quantize(_GRID), 'f').rstrip('0').rstrip('.') or '0'


def _draft(kind, spec, reviewed, demo, stepover=None):
    fixture, tool, params, centre, levels = _draft_setup(spec, reviewed, demo)
    x0, x1 = centre['x']
    y0, y1 = centre['y']
    if kind == 'coupon':
        _require(all(spec['area'][a][1] - spec['area'][a][0] <= 50 for a in 'xy'),
                 'Calibration coupon is limited to 50 x 50 mm')
        path = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    else:
        step = _grid(_number(stepover, 'Raster stepover', .000001, tool['diameter'] / 2), 'Raster stepover')
        count = int(((y1 - y0) / step).to_integral_value(rounding=ROUND_CEILING))
        _require(count + 1 <= MAX_RASTER_ROWS, 'Surfacing draft exceeds the raster row cap')
        path = []
        for i in range(count + 1):
            y = min(y1, y0 + step * i)
            path.extend([(x0, y), (x1, y)] if i % 2 == 0 else [(x1, y), (x0, y)])
    _require(len(levels) * (len(path) + 3) + 12 <= MAX_DRAFT_LINES, 'Draft exceeds the output line cap')
    clear = _format(params['clearZ'])
    header = 'SIMULATED DEMO - DO NOT MACHINE' if demo else 'UNRELEASED DRAFT - REVIEW IN UGS'
    lines = ['(' + header + ')', '(Z0 is the declared surface; initial approach is not validated.)',
             'G21 G90 G17 G94 G54 G40 G49', 'M5', 'M0', 'G0 Z' + clear,
             f'G0 X{_format(x0)} Y{_format(y0)}', 'M3 S' + _format(params['spindleCommand'])]
    for level in levels:
        lines.append('G0 Z' + clear)
        lines.append(f'G0 X{_format(x0)} Y{_format(y0)}')
        lines.append(f'G1 Z{_format(level)} F{_format(params["plungeFeed"])}')
        for x, y in path[1:]:
            lines.append(f'G1 X{_format(x)} Y{_format(y)} F{_format(params["feed"])}')
    lines.extend(['G0 Z' + clear, 'M5', 'M2'])
    _require(len(lines) <= MAX_DRAFT_LINES, 'Draft exceeds the output line cap')
    source = '\n'.join(lines) + '\n'
    parsed = parse_gcode(source)
    inspection = inspect_fixture_paths(parsed, {'x': 0, 'y': 0, 'angle': 0, 'mirror': False}, fixture, tool)
    _require(inspection['modelClear'], 'Draft conflicts with clamps or the tool/holder footprint bounds')
    return {'kind': kind, 'filename': kind + ('-DEMO.nc.txt' if demo else '-DRAFT.nc'),
            'source': source, 'simulation': demo, 'status': 'draft', 'executionReleased': False,
            'physicalQualification': 'not-assessed', 'bounds': parsed['bounds'],
            'passes': len(levels), 'inspection': inspection,
            'specification': copy.deepcopy(spec), 'reviewed': copy.deepcopy(reviewed),
            'stepover': stepover,
            'warnings': ['Review Z datum, cutter, initial approach, workholding and spindle start before use.',
                         'No height compensation is applied. Configuration review is not physical qualification.',
                         'Paths are inset by tool radius, clearance and 0.02 mm; rectangular corners are not fully cleared.']}


def generate_calibration_coupon(spec, reviewed, *, demo):
    """Return a <=50 mm rectangular perimeter draft for dimensional/depth trials.

    spec={fixture,area:{x:[lo,hi],y:[lo,hi]},tool,parameters}; parameters has feed,
    plungeFeed,depth,passDepth,clearZ,spindleCommand. Positive depths are below Z0.
    area bounds the cutter footprint, not the perimeter centreline. This is a
    witness perimeter, without tabs or a break-out operation. Tool must be suitable
    for a vertical plunge; toolReviewed includes that caller assertion.

    reviewed requires configured, all REVIEW_FLAGS true, maxFeed, maxPlungeFeed,
    maxSpindleCommand. Demo accepts configured=False but still requires the review
    flags and explicit inputs; its output is conspicuously marked .nc.txt. S is a
    controller command value, not measured RPM. The draft uses M3 (clockwise).
    No file is saved or sent.
    """
    return _draft('coupon', spec, reviewed, demo)


def generate_surfacing_draft(spec, reviewed, *, stepover, demo):
    """Return an inset serpentine raster draft, with stepover <= tool diameter/2.

    Inputs and evidence boundaries match generate_calibration_coupon. Each depth
    pass retracts before repositioning. Final raster rows and depth passes are
    clipped to exact bounds. Clearance, exposed length, clamps, configured feed
    limits and output caps are checked before returning text. The flat end tool
    must be suitable for surfacing and vertical plunge (toolReviewed assertion).
    """
    return _draft('surfacing', spec, reviewed, demo, stepover)
