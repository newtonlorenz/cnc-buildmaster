"""Offline tests with synthetic dimensions only; no generated machine job files."""

import copy
import json
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import job_tools as jobs
from pcb_gcode import parse_gcode, transform


IDENTITY = {'x': 0, 'y': 0, 'angle': 0, 'mirror': False}
BAD_NUMBERS = [True, False, None, '1', [], {}, math.inf, -math.inf, math.nan, 10 ** 400]


def tool():
    return {'diameter': 2, 'cuttingLength': 4, 'length': 10, 'holderDiameter': 8}


def fixture(clamps=True):
    return {'bounds': {'x': [-30, 50], 'y': [-30, 50], 'z': [-10, 40]}, 'clearance': 0,
            'clamps': ([{'id': 'A', 'x': 9, 'y': 9, 'width': 2, 'height': 2, 'baseZ': 0, 'heightZ': 5}]
                       if clamps else [])}


def paths(points, rapid=False):
    return {'paths': [{'line': 5, 'rapid': rapid, 'points': points}]}


def parameters():
    return {'feed': 100, 'plungeFeed': 20, 'depth': .3, 'passDepth': .1, 'clearZ': 6, 'spindleCommand': 500}


def spec():
    return {'fixture': fixture(False), 'area': {'x': [0, 20], 'y': [0, 15]},
            'tool': tool(), 'parameters': parameters()}


def reviewed():
    return {'configured': False, **dict.fromkeys(jobs.REVIEW_FLAGS, True),
            'maxFeed': 200, 'maxPlungeFeed': 50, 'maxSpindleCommand': 1000}


def recipe():
    return {'version': 1, 'name': 'Synthetic trial', 'material': 'Synthetic material',
            'tool': tool(), 'parameters': parameters(),
            'observations': [{'date': '2026-09-19', 'source': 'User report', 'scope': 'Trial A only',
                              'observation': '  No groove observed.\nDepth remains unverified.  ',
                              'measurements': {'width error': {'value': -.12, 'unit': 'mm'},
                                               'groove depth': {'value': 0, 'unit': 'mm'}}}]}


def offset_samples():
    # Camera is +3 X, -2 Y relative to spindle; carriage moves oppositely to
    # centre the camera on each of the same fiducials.
    return [{'spindle': [0, 0, 5], 'camera': [-3, 2, 5]},
            {'spindle': [10, 0, 5], 'camera': [7, 2, 5]},
            {'spindle': [0, 10, 5], 'camera': [-3, 12, 5]}]


def image_samples():
    # Rotation, shear and reflection with a fixed work-coordinate translation.
    def sample(u, v):
        return {'image': [u, v], 'machine': [10 + .1 * u + .02 * v, 20 + .03 * u - .2 * v, 5]}
    return [sample(0, 0), sample(100, 0), sample(0, 100), sample(100, 100)], sample(40, 50)


class FixtureTests(unittest.TestCase):
    def inspect(self, points, *, rapid=False, ft=None, cutter=None, placement=None):
        return jobs.inspect_fixture_paths(paths(points, rapid), placement or IDENTITY,
                                          ft if ft is not None else fixture(), cutter or tool())

    def test_fixture_validation_copies_and_is_json_compatible(self):
        original = fixture()
        before = copy.deepcopy(original)
        result = jobs.validate_fixture(original)
        self.assertEqual(original, before)
        result['clamps'][0]['x'] = 0
        self.assertEqual(original, before)
        json.dumps(result, allow_nan=False)

    def test_invalid_fixtures_and_clamp_numbers(self):
        for value in (None, [], {}, {'bounds': {}}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                jobs.validate_fixture(value)
        for key in ('x', 'y', 'width', 'height', 'baseZ', 'heightZ'):
            for invalid in BAD_NUMBERS:
                ft = fixture()
                ft['clamps'][0][key] = invalid
                with self.subTest(key=key, value=invalid), self.assertRaises(ValueError):
                    jobs.validate_fixture(ft)
        for key, value in [('width', 0), ('height', -1), ('heightZ', 0), ('x', 49),
                           ('baseZ', 39), ('id', ''), ('id', 'bad\x00id')]:
            ft = fixture()
            ft['clamps'][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                jobs.validate_fixture(ft)

    def test_duplicate_excess_unknown_fields_and_invalid_bounds(self):
        cases = []
        ft = fixture(); ft['clamps'] *= 2; cases.append(ft)
        ft = fixture(); ft['clamps'] *= jobs.MAX_CLAMPS + 1; cases.append(ft)
        ft = fixture(); ft['bounds']['x'] = [0, 0]; cases.append(ft)
        ft = fixture(); ft['bounds']['y'] = [0, 1001]; cases.append(ft)
        ft = fixture(); ft['bounds']['z'] = [10, -10]; cases.append(ft)
        ft = fixture(); ft['bounds']['z'] = [False, 10]; cases.append(ft)
        ft = fixture(); ft['units'] = 'inch'; cases.append(ft)
        ft = fixture(); ft['clearance'] = 40; cases.append(ft)
        for ft in cases:
            with self.subTest(fixture=ft), self.assertRaises(ValueError):
                jobs.validate_fixture(ft)

    def test_clamp_crossing_between_clear_endpoints_and_rapid(self):
        for rapid in (True, False):
            result = self.inspect([[0, 10, 1], [20, 10, 1]], rapid=rapid)
            self.assertEqual(result['collisionCount'], 1)
            self.assertEqual(result['collisions'][0]['rapid'], rapid)
            self.assertIn('tool', result['collisions'][0]['components'])
            self.assertFalse(result['modelClear'])
        self.assertTrue(self.inspect([[0, 10, 6], [20, 10, 6]], rapid=True)['modelClear'])

    def test_z_rapid_crosses_clamp_and_uses_simultaneous_xyz(self):
        result = self.inspect([[10, 10, 8], [10, 10, -8]], rapid=True)
        self.assertEqual(result['collisionCount'], 1)
        # At clamp entry this rising move is already above the clamp. A test
        # using the minimum endpoint Z for the entire segment would misreport it.
        self.assertTrue(self.inspect([[0, 10, 1], [20, 10, 20]], rapid=True)['modelClear'])
        self.assertFalse(self.inspect([[0, 10, 20], [20, 10, -5]], rapid=True)['modelClear'])

    def test_holder_collision_depends_on_exposed_tool_length(self):
        short = {**tool(), 'length': 4, 'cuttingLength': 3}
        result = self.inspect([[0, 6, 0], [20, 6, 0]], cutter=short)
        self.assertEqual(result['collisions'][0]['components'], ['holder'])
        self.assertTrue(self.inspect([[0, 6, 0], [20, 6, 0]])['modelClear'])
        # Holder touches the top at tip Z1 with a 4 mm exposed length.
        self.assertFalse(self.inspect([[0, 6, 1], [20, 6, 1]], cutter=short)['modelClear'])
        self.assertTrue(self.inspect([[0, 6, 1.0001], [20, 6, 1.0001]], cutter=short)['modelClear'])

    def test_touching_expanded_rectangle_is_collision_and_clearance_applies(self):
        self.assertFalse(self.inspect([[0, 7.98, 1], [20, 7.98, 1]])['modelClear'])
        self.assertTrue(self.inspect([[0, 7.9799, 1], [20, 7.9799, 1]])['modelClear'])
        ft = fixture(); ft['clearance'] = 1
        self.assertFalse(self.inspect([[0, 7, 1], [20, 7, 1]], ft=ft)['modelClear'])
        # Bounding boxes overlap but the diagonal misses the rectangle.
        self.assertTrue(self.inspect([[0, 8, 1], [8, 20, 1]])['modelClear'])

    def test_transform_is_applied_once_and_input_is_untouched(self):
        p = paths([[0, 0, 1], [20, 0, 1]])
        before = copy.deepcopy(p)
        placement = {'x': 10, 'y': 20, 'angle': 90, 'mirror': True}
        result = jobs.inspect_fixture_paths(p, placement, fixture(), tool())
        self.assertFalse(result['modelClear'])
        self.assertEqual(p, before)
        transformed = {'paths': [{**p['paths'][0], 'points': [transform(v, placement) for v in p['paths'][0]['points']]}]}
        self.assertEqual(jobs.inspect_fixture_paths(transformed, IDENTITY, fixture(), tool()), result)

    def test_parser_arc_and_rapid_paths_are_inspected(self):
        source = ('G21 G90 G17\nG0 Z6\nG0 X0 Y10\nM3 S500\nG1 Z1 F20\n'
                  'G3 X20 Y10 I10 J0 F100\nG0 Z6\nM5\nM2\n')
        ft = fixture()
        ft['clamps'][0].update(x=9, y=-1)
        result = jobs.inspect_fixture_paths(parse_gcode(source), IDENTITY, ft, tool())
        self.assertFalse(result['modelClear'])
        self.assertGreater(result['segmentsChecked'], 10)
        self.assertFalse(result['initialApproachInspected'])
        self.assertFalse(result['executionReleased'])

    def test_exact_safe_bounds_and_no_tolerance_overrun(self):
        ft = fixture(False)
        # Holder radius 4 + .02 preview allowance; exact footprint edge is -30.
        self.assertTrue(self.inspect([[-25.98, 0, -10], [45.98, 0, 40]], ft=ft)['modelClear'])
        for point in ([-25.980000001, 0, 0], [45.980000001, 0, 0], [0, 0, -10.000000001], [0, 0, 40.000000001]):
            with self.subTest(point=point):
                self.assertEqual(self.inspect([point], ft=ft)['outsideCount'], 1)

    def test_malformed_paths_and_placement(self):
        cases = [None, {}, {'paths': []}, {'paths': [None]}, paths([]), paths([[0, 0]]),
                 paths([[0, None, 0]]), paths([[0, 0, 0]], rapid=1)]
        p = paths([[0, 0, 0]]); p['paths'][0]['line'] = True; cases.append(p)
        for p in cases:
            with self.subTest(parsed=p), self.assertRaises(ValueError):
                jobs.inspect_fixture_paths(p, IDENTITY, fixture(), tool())
        for key, value in [('mirror', 1), ('angle', math.nan), ('x', True), ('angle', 361)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.inspect([[0, 0, 0]], placement={**IDENTITY, key: value})

    def test_fractional_tool_and_margin_use_exact_decimal_bounds(self):
        ft = fixture(False)
        ft.update(bounds={'x': [0, 20], 'y': [0, 20], 'z': [-10, 40]}, clearance=.1)
        cutter = {**tool(), 'diameter': 2.04, 'holderDiameter': 2.04}
        self.assertTrue(self.inspect([[1.14, 1.14, 0], [18.86, 18.86, 0]], ft=ft, cutter=cutter)['modelClear'])
        self.assertFalse(self.inspect([[1.139999999, 1.14, 0]], ft=ft, cutter=cutter)['modelClear'])

    def test_work_and_result_caps_do_not_silently_approve(self):
        with patch.object(jobs, 'MAX_POINTS', 2), self.assertRaises(ValueError):
            self.inspect([[0, 0, 1]] * 3)
        with patch.object(jobs, 'MAX_INTERSECTIONS', 1), self.assertRaises(ValueError):
            self.inspect([[0, 10, 1], [20, 10, 1], [0, 10, 1]])
        with patch.object(jobs, 'MAX_FINDINGS', 1):
            result = self.inspect([[0, 10, 1], [20, 10, 1], [0, 10, 1]])
        self.assertTrue(result['findingsTruncated'])
        self.assertEqual(result['collisionCount'], 2)
        self.assertEqual(len(result['collisions']), 1)
        self.assertFalse(result['modelClear'])


class CameraTests(unittest.TestCase):
    def offset(self, samples=None, check=None, **kwargs):
        a, b, c = offset_samples()
        return jobs.calibrate_camera_offset(samples if samples is not None else [a, b],
                                            check if check is not None else c,
                                            **{'common_z': 5, 'tolerance': .05, **kwargs})

    def affine(self, samples=None, check=None, **kwargs):
        defaults, default_check = image_samples()
        return jobs.fit_image_affine(samples if samples is not None else defaults,
                                     check if check is not None else default_check,
                                     **{'image_size': [100, 100], 'common_z': 5, 'tolerance': .01, **kwargs})

    def test_camera_offset_sign_and_independent_check(self):
        result = self.offset()
        self.assertEqual(result['offsetXY'], [3, -2])
        self.assertEqual(result['fitResiduals'], [0, 0])
        self.assertEqual(result['checkResidual'], 0)
        self.assertEqual(result['physicalQualification'], 'not-assessed')
        self.assertFalse(result['executionReleased'])
        a, b, c = offset_samples()
        c['camera'][0] -= .04
        checked = self.offset([a, b], c)
        self.assertEqual(checked['offsetXY'], [3, -2])  # C never biases the fit.
        self.assertAlmostEqual(checked['checkResidual'], .04)

    def test_camera_requires_common_z_distinct_third_point_and_residual_limit(self):
        for changed in ('check', 'fit', 'z', 'line', 'duplicate', 'short'):
            a, b, c = offset_samples()
            if changed == 'check': c['camera'][0] += .1
            if changed == 'fit': b['camera'][0] += .2
            if changed == 'z': b['camera'][2] += .000001
            if changed == 'line': c = {'spindle': [5, 0, 5], 'camera': [2, 2, 5]}
            if changed == 'duplicate': c = a
            if changed == 'short': b = {'spindle': [4, 0, 5], 'camera': [1, 2, 5]}
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                self.offset([a, b], c)

    def test_camera_malformed_numbers_shapes_and_boolean_tolerances(self):
        for value in BAD_NUMBERS:
            a, b, c = offset_samples()
            a['spindle'][0] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.offset([a, b], c)
            with self.assertRaises(ValueError):
                self.offset(tolerance=value)
        for samples in (None, [], [{}], [None, None]):
            with self.subTest(samples=samples), self.assertRaises(ValueError):
                jobs.calibrate_camera_offset(samples, {}, common_z=5, tolerance=.05)

    def test_affine_recovers_shear_reflection_and_round_trips_json(self):
        calibration = self.affine()
        restored = json.loads(json.dumps(calibration, allow_nan=False))
        point = jobs.transform_image_point(restored, [25, 75], common_z=5)
        self.assertAlmostEqual(point[0], 14)
        self.assertAlmostEqual(point[1], 5.75)
        self.assertEqual(point[2], 5)
        self.assertLess(calibration['checkResidual'], 1e-10)
        self.assertEqual(calibration['physicalQualification'], 'not-assessed')

    def test_three_affine_fit_points_need_an_independent_fourth_check(self):
        samples, check = image_samples()
        calibrated = self.affine(samples[:3], check)
        self.assertEqual(len(calibrated['fitResiduals']), 3)
        with self.assertRaisesRegex(ValueError, 'reuse'):
            self.affine(samples[:3], samples[0])
        samples[0]['machine'][0] += .5  # Three fit points alone have zero residual.
        with self.assertRaisesRegex(ValueError, 'residual'):
            self.affine(samples[:3], check)

    def test_affine_fit_residual_and_check_residual_are_both_enforced(self):
        samples, check = image_samples()
        samples[3]['machine'][0] += .2
        with self.assertRaisesRegex(ValueError, 'residual'):
            self.affine(samples, check)
        samples, check = image_samples()
        check['machine'][1] += .05
        with self.assertRaisesRegex(ValueError, 'residual'):
            self.affine(samples, check)

    def test_affine_degenerate_collapsed_duplicate_and_near_collinear(self):
        samples, check = image_samples()
        cases = [samples[:2], samples * 9, [samples[0]] * 3]
        for epsilon in (0, 1e-7):
            cases.append([{'image': [x, x + (epsilon if x == 50 else 0)],
                           'machine': [x, x, 5]} for x in (0, 50, 100)])
        cases.append([{**p, 'machine': [p['image'][0], 0, 5]} for p in samples])
        for points in cases:
            with self.subTest(samples=points), self.assertRaises(ValueError):
                self.affine(points, check)

    def test_affine_same_z_and_finite_bounded_pixels_required(self):
        samples, check = image_samples()
        check['machine'][2] = 5.001
        with self.assertRaises(ValueError): self.affine(samples, check)
        for point in ([101, 0], [-1, 0], [True, 1], [math.nan, 1], [0], 'bad'):
            with self.subTest(point=point), self.assertRaises(ValueError):
                jobs.transform_image_point(self.affine(), point, common_z=5)
        with self.assertRaises(ValueError):
            jobs.transform_image_point(self.affine(), [0, 0], common_z=4)
        for bad in BAD_NUMBERS:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.affine(image_size=[bad, 100])

    def test_imported_calibration_cannot_forge_matrix_or_passed_status(self):
        calibration = self.affine()
        calibration['matrix'][0][2] += 1
        with self.assertRaisesRegex(ValueError, 'differs'):
            jobs.transform_image_point(calibration, [0, 0], common_z=5)
        calibration = self.affine()
        calibration['check']['machine'][0] += 1
        calibration['checkResidual'] = 0
        with self.assertRaisesRegex(ValueError, 'residual'):
            jobs.transform_image_point(calibration, [0, 0], common_z=5)


class RecipeAndToolTests(unittest.TestCase):
    def test_vbit_geometric_estimate_and_zero_depth(self):
        self.assertAlmostEqual(jobs.vbit_effective_diameter(.1, 90, .2, max_diameter=3), .5)
        self.assertEqual(jobs.vbit_effective_diameter(.1, 30, 0, max_diameter=3), .1)
        self.assertGreater(jobs.vbit_effective_diameter(0, 60, .2, max_diameter=3), 0)

    def test_vbit_rejects_bad_inputs_and_never_silently_clamps(self):
        for args in [(.1, 0, .1, 3), (.1, 180, .1, 3), (.1, 90, -.1, 3),
                     (.1, 90, 1, 1), (2, 30, 0, 1), (.1, 90, .1, 0)]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                jobs.vbit_effective_diameter(*args[:3], max_diameter=args[3])
        for index in range(4):
            for bad in BAD_NUMBERS:
                args = [.1, 90, .1, 3]; args[index] = bad
                with self.subTest(index=index, bad=bad), self.assertRaises(ValueError):
                    jobs.vbit_effective_diameter(*args[:3], max_diameter=args[3])

    def test_tool_length_holder_and_finite_dimensions(self):
        for key in tool():
            for bad in BAD_NUMBERS + [0, -1]:
                with self.subTest(key=key, bad=bad), self.assertRaises(ValueError):
                    jobs.validate_tool({**tool(), key: bad})
        for change in ({'length': 3}, {'holderDiameter': 1}, {'diameter': 51}, {'length': 301}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                jobs.validate_tool({**tool(), **change})

    def test_recipe_preserves_negative_evidence_and_does_not_qualify(self):
        data = recipe()
        before = copy.deepcopy(data)
        result = jobs.validate_recipe(data)
        self.assertEqual(result['record'], data)
        self.assertEqual(result['record']['observations'], before['observations'])
        self.assertEqual(result['status'], 'recorded-unqualified')
        self.assertEqual(result['physicalQualification'], 'not-assessed')
        self.assertFalse(result['executionReleased'])
        result['record']['observations'][0]['observation'] = 'Changed'
        self.assertEqual(data, before)
        data['observations'][0]['observation'] = 'User says this was qualified.'
        self.assertEqual(jobs.validate_recipe(data)['physicalQualification'], 'not-assessed')

    def test_recipe_does_not_accept_release_or_qualification_flags(self):
        for key in ('qualified', 'executionReleased', 'status'):
            data = recipe(); data[key] = True
            with self.subTest(key=key), self.assertRaises(ValueError): jobs.validate_recipe(data)
        data = recipe(); data['observations'] = []
        self.assertEqual(jobs.validate_recipe(data)['status'], 'recorded-unqualified')

    def test_recipe_bounded_evidence_and_strict_dates(self):
        for date in ('2026-02-30', '20260919', '2026-09-19Z', '', 'bad', None):
            data = recipe(); data['observations'][0]['date'] = date
            with self.subTest(date=date), self.assertRaises(ValueError): jobs.validate_recipe(data)
        for key, bad in [('source', ''), ('observation', 'x' * 4001), ('scope', 'x\x00y')]:
            data = recipe(); data['observations'][0][key] = bad
            with self.subTest(key=key), self.assertRaises(ValueError): jobs.validate_recipe(data)
        data = recipe(); data['observations'] *= 101
        with self.assertRaises(ValueError): jobs.validate_recipe(data)
        data = recipe(); data['version'] = True
        with self.assertRaises(ValueError): jobs.validate_recipe(data)
        for bad in BAD_NUMBERS:
            data = recipe(); data['observations'][0]['measurements']['groove depth']['value'] = bad
            with self.subTest(bad=bad), self.assertRaises(ValueError): jobs.validate_recipe(data)


class DraftTests(unittest.TestCase):
    def test_machine_maxima_are_independent_of_conservative_parameter_limits(self):
        review = reviewed(); review.update(maxFeed=5000, maxPlungeFeed=500, maxSpindleCommand=24000)
        for kind in ('coupon', 'surfacing'):
            result = self.generate(kind, review=review)
            self.assertEqual(parse_gcode(result['source'])['maxFeed'], 100)
            for key, excess in [('feed', 3001), ('plungeFeed', 301)]:
                data = spec(); data['parameters'][key] = excess
                with self.subTest(kind=kind, key=key), self.assertRaises(ValueError):
                    self.generate(kind, data=data, review=review)
        for field in ('maxFeed', 'maxPlungeFeed', 'maxSpindleCommand'):
            for invalid in BAD_NUMBERS + [0, -1]:
                bad = dict(review); bad[field] = invalid
                with self.subTest(field=field, invalid=invalid), self.assertRaises(ValueError):
                    self.generate(review=bad)

    def generate(self, kind='coupon', data=None, review=None, **kwargs):
        fn = jobs.generate_calibration_coupon if kind == 'coupon' else jobs.generate_surfacing_draft
        if kind != 'coupon': kwargs.setdefault('stepover', .8)
        return fn(data if data is not None else spec(), review if review is not None else reviewed(),
                  **{'demo': True, **kwargs})

    def test_coupon_demo_is_in_memory_parseable_bounded_and_unreleased(self):
        data, review = spec(), reviewed()
        before = copy.deepcopy((data, review))
        result = self.generate(data=data, review=review)
        self.assertEqual((data, review), before)
        self.assertTrue(result['filename'].endswith('-DEMO.nc.txt'))
        self.assertIn('SIMULATED DEMO - DO NOT MACHINE', result['source'])
        self.assertFalse(result['executionReleased'])
        self.assertEqual(result['physicalQualification'], 'not-assessed')
        self.assertEqual(result['passes'], 3)
        parsed = parse_gcode(result['source'])
        self.assertEqual(parsed['bounds']['z'], [-.3, 6])
        self.assertEqual(parsed['maxFeed'], 100)
        self.assertEqual(parsed['maxSpindle'], 500)
        self.assertTrue(result['inspection']['modelClear'])
        self.assertFalse(result['inspection']['initialApproachInspected'])
        self.assertEqual(parsed['warnings'], ['The initial approach from the machine position is not shown.'])
        self.assertTrue(result['source'].endswith('G0 Z6\nM5\nM2\n'))
        self.assertIn('M5\nM0\nG0 Z6\nG0 X1.02 Y1.02\nM3 S500', result['source'])
        json.dumps(result, allow_nan=False)

    def test_surfacing_has_clipped_final_rows_passes_and_no_low_rapid_xy(self):
        data = spec(); data['parameters'].update(depth=.25, passDepth=.1)
        result = self.generate('surfacing', data=data, stepover=.7)
        parsed = parse_gcode(result['source'])
        self.assertEqual(result['passes'], 3)
        self.assertEqual(parsed['bounds']['z'], [-.25, 6])
        cut = [p for path in parsed['paths'] if not path['rapid'] for p in path['points']]
        self.assertEqual(max(p[1] for p in cut), 13.98)
        self.assertEqual(min(p[1] for p in cut), 1.02)
        self.assertTrue(all(-.25 <= p[2] <= 6 for p in cut))
        for block in parsed['blocks']:
            move = block.get('move')
            if move and move['g'] == 0 and all(p is not None for p in move['from'] + move['to']):
                if move['from'][:2] != move['to'][:2]:
                    self.assertEqual(move['from'][2], 6)
                    self.assertEqual(move['to'][2], 6)

    def test_every_review_flag_is_explicit_and_true_even_in_demo(self):
        for flag in jobs.REVIEW_FLAGS:
            for value in (False, 1, 'true', None):
                r = reviewed(); r[flag] = value
                with self.subTest(flag=flag, value=value), self.assertRaises(ValueError): self.generate(review=r)
            r = reviewed(); del r[flag]
            with self.assertRaises(ValueError): self.generate(review=r)
        for value in (1, 'true', None):
            with self.assertRaises(ValueError): self.generate(demo=value)
        with self.assertRaisesRegex(ValueError, 'configured'):
            self.generate(demo=False)

    def test_generator_never_loads_config_or_writes_files(self):
        # All success calls use demo fixtures. Even configured review metadata
        # cannot remove demo labelling when demo=True.
        r = reviewed(); r['configured'] = True
        with patch('builtins.open', side_effect=AssertionError('Unexpected I/O')):
            result = self.generate(review=r)
        self.assertTrue(result['simulation'])
        self.assertIn('DEMO', result['source'])

    def test_missing_fields_and_injected_commands_are_rejected(self):
        for field in spec():
            data = spec(); del data[field]
            with self.subTest(field=field), self.assertRaises(ValueError): self.generate(data=data)
        for field in parameters():
            data = spec(); del data['parameters'][field]
            with self.subTest(field=field), self.assertRaises(ValueError): self.generate(data=data)
        data = spec(); data['parameters']['spindleCommand'] = '500\n$H'
        with self.assertRaises(ValueError): self.generate(data=data)
        data = spec(); data['parameters']['spindleMode'] = 'M4'
        with self.assertRaises(ValueError): self.generate(data=data)

    def test_parameters_reject_nonfinite_bool_negative_and_excess_limits(self):
        for key in parameters():
            for invalid in BAD_NUMBERS + [-1, 0]:
                data = spec(); data['parameters'][key] = invalid
                with self.subTest(key=key, invalid=invalid), self.assertRaises(ValueError): self.generate(data=data)
        for key, value in [('feed', 201), ('plungeFeed', 51), ('spindleCommand', 1001),
                           ('passDepth', .4), ('clearZ', 40.000001), ('depth', 4), ('feed', 1.0000001)]:
            data = spec(); data['parameters'][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError): self.generate(data=data)
        data = spec(); data['tool']['cuttingLength'] = .2
        with self.assertRaisesRegex(ValueError, 'cutting length'): self.generate(data=data)
        data = spec(); data['tool'].update(length=.3, cuttingLength=.3)
        with self.assertRaisesRegex(ValueError, 'holder'): self.generate(data=data)

    def test_clamps_block_cut_and_rapid_repositioning(self):
        data = spec(); data['fixture'] = fixture()
        # The raster crosses the central clamp.
        with self.assertRaisesRegex(ValueError, 'clamps'): self.generate('surfacing', data=data)
        # A taller clamp crosses the rapid return but not the perimeter's cuts.
        data = spec()
        data['fixture']['clamps'] = [{'id': 'raised', 'x': 9, 'y': 6, 'width': 2,
                                      'height': 2, 'baseZ': 4, 'heightZ': 10}]
        with self.assertRaisesRegex(ValueError, 'clamps'): self.generate('surfacing', data=data)

    def test_exact_safe_bounds_and_inward_rounding(self):
        data = spec()
        data['tool']['holderDiameter'] = 2
        data['fixture']['bounds'] = {'x': [0, 20], 'y': [0, 15], 'z': [-.3, 6]}
        result = self.generate(data=data)
        self.assertEqual(result['bounds'], {'x': [1.02, 18.98], 'y': [1.02, 13.98], 'z': [-.3, 6]})
        # A micron below/above the explicit Z limits is rejected, never rounded in.
        for key, value in [('depth', .300001), ('clearZ', 6.000001)]:
            changed = copy.deepcopy(data); changed['parameters'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): self.generate(data=changed)
        for a in 'xy':
            changed = copy.deepcopy(data); changed['area'][a][0] = -.000001
            with self.assertRaisesRegex(ValueError, 'exact fixture'): self.generate(data=changed)
        # A half-micron centreline inset rounds inward on BOTH sides.
        data['tool'].update(diameter=2.000001, holderDiameter=2.000001)
        result = self.generate(data=data)
        self.assertEqual(result['bounds']['x'], [1.020001, 18.979999])

    def test_small_area_tool_holder_and_output_caps(self):
        data = spec(); data['area']['x'] = [0, 2]
        with self.assertRaises(ValueError): self.generate(data=data)
        data = spec(); data['area']['x'] = [-25, 30]
        with self.assertRaisesRegex(ValueError, '50 x 50'): self.generate(data=data)
        data = spec(); data['parameters']['passDepth'] = .000001
        with self.assertRaisesRegex(ValueError, 'pass cap'): self.generate(data=data)
        with self.assertRaisesRegex(ValueError, 'row cap'): self.generate('surfacing', stepover=.000001)
        with patch.object(jobs, 'MAX_DRAFT_LINES', 20), self.assertRaisesRegex(ValueError, 'line cap'):
            self.generate('surfacing')
        data = spec(); data['fixture']['bounds']['x'] = [0, 20]
        with self.assertRaisesRegex(ValueError, 'holder'): self.generate(data=data)

    def test_stepover_requires_explicit_positive_finite_value_with_no_gaps(self):
        for bad in BAD_NUMBERS + [0, -1, 1.000001, .0000001]:
            with self.subTest(stepover=bad), self.assertRaises(ValueError): self.generate('surfacing', stepover=bad)
        with self.assertRaises(TypeError):
            jobs.generate_surfacing_draft(spec(), reviewed(), demo=True)


if __name__ == '__main__':
    unittest.main()
