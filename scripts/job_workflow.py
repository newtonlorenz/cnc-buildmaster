"""Job preparation and evidence identities. No machine commands."""
import copy
import datetime
import hashlib
import json
import math
import re
from types import MappingProxyType
from pcb_gcode import require, finite


def defaults():
    return {'material': 'pcb', 'intent': 'isolation', 'sourceCompensation': 'unknown',
            'fixture': None, 'recipes': [], 'camera': None, 'toolChecks': {},
            'toolObservations': [], 'flip': None}


MAX_TOOL_OBSERVATIONS = 1000


def source_identity(operation):
    return {'name': operation['name'], 'sha256': operation['parsed']['sha256']}


def tool_observation(record):
    """Validate historical text and identity; never accept saved authority flags."""
    require(isinstance(record, dict), 'Invalid tool observation')
    source = record.get('source')
    require(isinstance(source, dict) and set(source) == {'name', 'sha256'}, 'Invalid observation source identity')
    name, digest = source['name'], source['sha256']
    require(isinstance(name, str) and 0 < len(name) <= 120 and
            all(c.isprintable() for c in name) and '/' not in name and '\\' not in name,
            'Invalid observation source name')
    require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest), 'Invalid observation source hash')
    note, date = record.get('note'), record.get('recordedAt')
    require(isinstance(note, str) and 0 < len(note) <= 2000 and note.strip() and
            all(c.isprintable() or c in '\n\t' for c in note), 'Invalid tool observation text')
    require(isinstance(date, str) and 0 < len(date) <= 40, 'Invalid tool observation date')
    try:
        datetime.datetime.fromisoformat(date)
    except ValueError as error:
        raise ValueError('Invalid tool observation date') from error
    return {'source': dict(source), 'note': note, 'recordedAt': date,
            'status': 'historical-operator-note', 'zReferenceVerified': False}


def refresh_tool_checks(job):
    """Compatibility view of latest matching history, keyed by current operation ID."""
    latest = {(r['source']['name'], r['source']['sha256']): r
              for r in job.workflow.get('toolObservations', [])}
    job.workflow['toolChecks'] = {
        o['id']: copy.deepcopy(latest[(o['name'], o['parsed']['sha256'])])
        for o in job.operations if (o['name'], o['parsed']['sha256']) in latest}


def fingerprint(job):
    identity = {'stock': job.stock, 'face': job.face, 'placement': job.placement,
                'files': [(o['parsed']['sha256'], o['role'], o['tool'], o['diameter']) for o in job.operations],
                'fixture': job.workflow['fixture'], 'material': job.workflow['material'],
                'sourceCompensation': job.workflow['sourceCompensation']}
    return hashlib.sha256(json.dumps(identity, sort_keys=True, allow_nan=False).encode()).hexdigest()


def preparation_view(public):
    """Small immutable geometry view for one locked read; never cache authority.

    Paths are deliberately excluded. All nested containers are detached so the
    response can be serialised/extended without changing a consumer's inputs.
    """
    return MappingProxyType({'revision': public['revision'], 'operations': tuple(
        MappingProxyType({
            **{k: op[k] for k in ('tool', 'diameter', 'fits', 'depthOk')},
            'warnings': tuple(op['warnings']),
            'footprint': MappingProxyType({a: tuple(op['footprint'][a]) for a in 'xy'}),
        }) for op in public['operations'])})


def _preparation_view(job, session, preview):
    if preview is None:
        preview = preparation_view(job.public(session, include_paths=False))
    require(preview['revision'] == job.revision, 'Job changed while preparing its preview')
    return preview


def scan_area(job, margin=1, *, preview=None):
    margin = finite(margin, 'Scan margin')
    require(0 <= margin <= 10, 'Scan margin must be 0–10 mm')
    require(job.operations, 'Add cutting files before planning their surface map')
    preview = _preparation_view(job, None, preview)
    require(all(o['diameter'] is not None and o['tool'] for o in preview['operations']), 'Save each cutter before deriving map coverage')
    require(all(o['fits'] and o['depthOk'] for o in preview['operations']), 'Resolve stock and depth checks before mapping this job')
    area = {a: [math.floor((min(o['footprint'][a][0] for o in preview['operations'])-margin)*1000)/1000,
                math.ceil((max(o['footprint'][a][1] for o in preview['operations'])+margin)*1000)/1000] for a in 'xy'}
    stock = job.stock
    for a, size in [('x','width'),('y','height')]:
        require(area[a][0] >= stock[a] and area[a][1] <= stock[a]+stock[size],
                'Scan margin extends outside the stock. Reduce the margin or adjust placement.')
    fixture=job.workflow.get('fixture')
    if fixture:
        for clamp in fixture['clamps']:
            require(not (area['x'][0] <= clamp['x']+clamp['width']+fixture['clearance'] and area['x'][1] >= clamp['x']-fixture['clearance'] and area['y'][0] <= clamp['y']+clamp['height']+fixture['clearance'] and area['y'][1] >= clamp['y']-fixture['clearance']), 'A clamp overlaps the proposed scan rectangle. Adjust the fixture or job placement.')
    return {'area': area, 'margin': margin, 'fingerprint': fingerprint(job),
            'probeMode': 'copper' if job.workflow['material'] == 'pcb' else 'puck',
            'note': 'Full rectangular coverage including cutter footprint. Confirm conductive contact or puck support at every point.'}


def map_source_current(job, session, machine):
    """Geometry equality cannot restore authority lost in an earlier setup epoch."""
    source = machine.get('mapSource')
    if not isinstance(source, dict): return False
    source_epoch, setup_epoch = source.get('setupEpoch'), machine.get('jobSetupEpoch')
    return bool(type(source_epoch) is int and type(setup_epoch) is int
                and source_epoch == setup_epoch and not source.get('invalidated')
                and source.get('fingerprint') == fingerprint(job)
                and job.valid_alignment(session))


def plan_status(job, session, machine, *, preview=None):
    j = _preparation_view(job, session, preview)
    identity = fingerprint(job)
    matches = map_source_current(job, session, machine)
    measured = bool(matches and machine.get('phase') == 'complete' and machine.get('result'))
    checks = [
        {'id':'files', 'label':'Prepare the job', 'complete':bool(j['operations']) and all(o['tool'] and o['diameter'] is not None and o['fits'] and o['depthOk'] and not any(not w.startswith('The initial approach') for w in o['warnings']) for o in j['operations']), 'detail':'Load CAM files, set stock and identify every cutter.'},
        {'id':'alignment', 'label':'Check placement', 'complete':job.valid_alignment(session), 'detail':'Two references align the job; a third checks the result.'},
        {'id':'surface', 'label':'Measure the surface', 'complete':measured, 'detail':'Use this job’s cutting area and the correct contact method.'},
        {'id':'handoff', 'label':'Review in UGS', 'complete':False, 'detail':'Map import, material Z and compensation are separate checks.'},
    ]
    return {'fingerprint':identity, 'steps':checks, 'mapMatchesJob':matches, 'measured':measured,
            'sourceCompensation':job.workflow['sourceCompensation'], 'cuttingReleased':False,
            'nextStep':next((s['id'] for s in checks if not s['complete']), 'handoff')}


def configure_workflow(job, payload):
    require(isinstance(payload, dict), 'Expected process settings')
    material = payload.get('material'); intent = payload.get('intent'); compensation=payload.get('sourceCompensation')
    require(material in ('pcb','wood','plastic','other'), 'Choose the actual stock material')
    require(intent in ('isolation','engraving','profile','surfacing'), 'Choose a supported task')
    require(compensation in ('unknown','none','applied'), 'Declare the source compensation state')
    if any(job.workflow[k] != v for k,v in [('material',material),('intent',intent),('sourceCompensation',compensation)]):
        job.workflow.update(material=material,intent=intent,sourceCompensation=compensation)
        job.changed()


def restore_workflow(data, operations=(), saved_operations=()):
    """Restore planning records, never a tool reference or camera approval."""
    result=defaults()
    if data is None:return result
    require(isinstance(data,dict), 'Invalid workflow record')
    class Draft:
        workflow=result
        def changed(self):pass
    configure_workflow(Draft(), {k:data.get(k,result[k]) for k in ('material','intent','sourceCompensation')})
    from job_tools import validate_fixture, validate_recipe
    if data.get('fixture') is not None:result['fixture']=validate_fixture(data['fixture'])
    recipes=data.get('recipes',[])
    require(isinstance(recipes,list) and len(recipes)<=100,'Too many recipe records')
    result['recipes']=[validate_recipe(r)['record'] for r in recipes]
    observations = data.get('toolObservations')
    if observations is None:
        # Legacy toolChecks used ephemeral IDs. Migrate only when the saved
        # operation identifies a hash-checked source that exists in this package.
        checks = data.get('toolChecks', {})
        require(isinstance(checks, dict) and len(checks) <= MAX_TOOL_OBSERVATIONS,
                'Invalid saved tool observations')
        require(isinstance(saved_operations, (list, tuple)) and len(saved_operations) <= 12,
                'Invalid saved operations')
        sources = {(o['name'], o['parsed']['sha256']) for o in operations}
        observations = []
        for op in saved_operations:
            if not isinstance(op, dict) or not isinstance(op.get('id'), str): continue
            if not isinstance(op.get('name'), str) or not isinstance(op.get('sha256'), str): continue
            record = checks.get(op['id'])
            if isinstance(record, dict) and (op['name'], op['sha256']) in sources:
                observations.append({**record, 'source': {'name': op['name'], 'sha256': op['sha256']}})
    require(isinstance(observations, list) and len(observations) <= MAX_TOOL_OBSERVATIONS,
            'Too many or invalid tool observations')
    result['toolObservations'] = [tool_observation(r) for r in observations]
    # Camera approval and live tool references are never reopened. The caller
    # derives toolChecks after loading, without trusting its saved contents.
    return copy.deepcopy(result)
