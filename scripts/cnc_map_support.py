"""Presentation and offline planning helpers; no machine access."""
import math


def fault_details(reason):
    text = str(reason)
    lower = text.lower()
    title = 'Session stopped'
    next_step = 'Review the details, make sure the machine is stopped, then start a fresh setup.'
    if 'heartbeat' in lower or 'browser connection' in lower:
        title = 'The browser lost contact'
        next_step = 'Keep this page visible during operation. Check the machine has stopped, then start a fresh setup.'
    elif 'command deadline' in lower:
        title = 'UGS did not confirm the command'
        next_step = 'The command response or stopped-position check timed out. Inspect the machine, then start a fresh setup. The command was not retried.'
    elif 'spread' in lower or 'drift' in lower:
        title = 'The measurements did not agree'
        next_step = 'Check puck seating, workholding and mechanical play before another scan. Raw evidence is retained.'
    elif 'reference' in lower or 'offset' in lower or 'reconnect' in lower:
        title = 'The position reference changed'
        next_step = 'The old corners and map cannot be trusted. Check UGS and the setup, then teach again and establish a fresh surface reference.'
    elif any(word in lower for word in ('profile', 'serial port', 'port expected', 'units must')):
        title = 'UGS is using a different connection'
        next_step = 'Check the selected serial device, GRBL controller and units in UGS. Run Check connection to see what is available.'
    elif 'disconnected' in lower or 'connection refused' in lower:
        title = 'UGS is unavailable'
        next_step = 'Check that UGS is open and connected to the CNC, then run Check connection. A new connection requires a fresh position reference.'
    elif 'alarm' in lower:
        title = 'The controller reported an alarm'
        next_step = 'Inspect the machine and resolve the alarm in UGS. Start a fresh setup after checking the position reference.'
    elif 'extension' in lower:
        title = 'Smooth Hold is unavailable'
        next_step = 'Run Check connection. Single steps remain available when the setup is valid; the native jog extension must be loaded for Hold.'
    elif 'operator pressed stop' in lower:
        title = 'You stopped the session'
    return {'title': title, 'detail': text, 'nextStep': next_step}


def scan_route(config):
    """Demo equivalent of the runner's eight serpentine candidates, including return."""
    candidates = []
    for swap in (False, True):
        a, b = ('y', 'x') if swap else ('x', 'y')
        for reverse_a in (False, True):
            for reverse_b in (False, True):
                av = config['grid'][a][::(-1 if reverse_a else 1)]
                bv = config['grid'][b][::(-1 if reverse_b else 1)]
                points = [{a: u, b: v} for i, v in enumerate(bv) for u in (av[::-1] if i % 2 else av)]
                start = next(i for i, p in enumerate(points) if all(p[k] == config['start'][k] for k in 'xy'))
                points = points[start:] + points[:start]
                points.append(points[0].copy())
                distance = sum(math.hypot(q['x']-p['x'], q['y']-p['y']) for p, q in zip(points, points[1:]))
                candidates.append({'points': points, 'distance': distance})
    return min(candidates, key=lambda route: route['distance'])


def corner_issue(corners):
    """Explain incoherent named corners while preserving their actual measurements."""
    for axis, sides, index in [('x', ('left', 'right'), 1), ('y', ('front', 'back'), 0)]:
        for side in sides:
            group = [p for p in corners if p['name'].split('-')[index] == side]
            if len({p[axis] for p in group}) > 1:
                values = ', '.join(f"{p['name']}: {p[axis]:.3f}" for p in group)
                return f'{side.capitalize()} corners need the same {axis.upper()}. Recorded {values} mm. Reposition and update the incorrect corner.'
    return None
