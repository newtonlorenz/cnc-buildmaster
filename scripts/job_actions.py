"""Offline job tools. Never connects to a controller or sends G-code."""
import datetime
from pcb_gcode import require
from job_workflow import source_identity, tool_observation, refresh_tool_checks, MAX_TOOL_OBSERVATIONS
from job_tools import (validate_fixture, inspect_fixture_paths, calibrate_camera_offset,
                       validate_recipe, vbit_effective_diameter, generate_calibration_coupon,
                       generate_surfacing_draft, validate_tool, REVIEW_FLAGS)

ACTIONS = {'pcb-fixture', 'pcb-fixture-check', 'pcb-camera', 'pcb-recipe', 'pcb-vbit', 'pcb-generate', 'pcb-tool-note'}

def perform(job, action, body, profile, demo):
    if action == 'pcb-fixture':
        job.workflow['fixture'] = validate_fixture(body.get('fixture'))
        job.workflow.pop('fixtureInspection', None)
        job.changed()
    elif action == 'pcb-fixture-check':
        require(job.workflow['fixture'] is not None, 'Save the fixture dimensions first')
        require(job.operations, 'Load a cutting file before inspecting its paths')
        # A shared envelope is still supported, but must cover every operation.
        # A per-operation map avoids substituting one small tool for larger tools.
        supplied = body.get('tools')
        require(not ('tools' in body and 'tool' in body), 'Choose shared or per-operation tool envelopes')
        if 'tools' in body:
            require(isinstance(supplied, dict) and set(supplied) == {o['id'] for o in job.operations},
                    'Supply a tool envelope for every operation')
        envelopes = {}
        for op in job.operations:
            envelope = validate_tool(supplied[op['id']] if 'tools' in body else body.get('tool'))
            require(op['diameter'] is not None, op['name'] + ': save the effective cutting diameter first')
            require(envelope['diameter'] >= op['diameter'],
                    op['name'] + ': tool envelope is smaller than the recorded cutting diameter')
            envelopes[op['id']] = envelope
        result = [{'name': o['name'], 'operationId': o['id'], 'tool': envelopes[o['id']],
                   **inspect_fixture_paths(o['parsed'], job.placement,
                   job.workflow['fixture'], envelopes[o['id']])} for o in job.operations]
        return {'operations': result, 'modelClear': all(r['modelClear'] for r in result),
                'physicalQualification':'not-assessed'}
    elif action == 'pcb-camera':
        result = calibrate_camera_offset(body.get('samples'), body.get('check'),
                    common_z=body.get('commonZ'), tolerance=body.get('tolerance'))
        job.workflow['camera'] = result
        job.changed()
        return result
    elif action == 'pcb-recipe':
        result = validate_recipe(body.get('recipe'))
        require(len(job.workflow['recipes']) < 100, 'Save or start another job before adding more than 100 records')
        job.workflow['recipes'].append(result['record'])
        job.changed()
        return result
    elif action == 'pcb-vbit':
        return {'diameter': vbit_effective_diameter(body.get('tipDiameter'), body.get('angle'),
                      body.get('depth'), max_diameter=body.get('maxDiameter'))}
    elif action == 'pcb-tool-note':
        key = body.get('operationId'); note = body.get('note')
        op = next((o for o in job.operations if o['id'] == key), None)
        require(op is not None, 'Choose an existing operation')
        require(isinstance(note, str) and 1 <= len(note.strip()) <= 2000, 'Enter a tool-change observation')
        require(len(job.workflow['toolObservations']) < MAX_TOOL_OBSERVATIONS, 'Too many tool observations; preserve this job and start another')
        record = tool_observation({'source': source_identity(op), 'note': note.strip(),
                                  'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        job.workflow['toolObservations'].append(record)
        refresh_tool_checks(job)
        job.changed()
    elif action == 'pcb-generate':
        require(body.get('kind') in ('coupon','surfacing'), 'Choose coupon or surfacing')
        flags = body.get('reviewed')
        require(isinstance(flags, dict), 'Review the machine, material, tool and workholding first')
        limits = profile['baseline']
        reviewed = {k: flags.get(k) for k in REVIEW_FLAGS}
        reviewed.update(configured=demo or profile['configured'], maxFeed=min(float(limits['110']), float(limits['111'])),
                        maxPlungeFeed=float(limits['112']), maxSpindleCommand=float(limits.get('30', 1000 if demo else 0)))
        # Limits come from the machine record, never a client request.
        if body['kind']=='surfacing':
            return generate_surfacing_draft(body.get('spec'), reviewed, stepover=body.get('stepover'), demo=demo)
        return generate_calibration_coupon(body.get('spec'), reviewed, demo=demo)
