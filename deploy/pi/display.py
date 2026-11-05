#!/usr/bin/env python3
"""Apply daily screen sleep hours in the desktop session, without stopping the Pi."""
import argparse
import datetime
import fcntl
import json
import math
import os
import re
import signal
import subprocess
import threading
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from zoneinfo import ZoneInfo

DEFAULTS = {'sleepEnabled': False, 'sleepStart': '22:00', 'sleepEnd': '07:00'}
WARMUP_SECONDS = 120


def schedule(value):
    if not isinstance(value, dict) or type(value.get('sleepEnabled')) is not bool:
        raise ValueError('Invalid sleep schedule')
    result = {key: value.get(key) for key in DEFAULTS}
    for key in ('sleepStart', 'sleepEnd'):
        if not isinstance(result[key], str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', result[key]):
            raise ValueError('Invalid sleep time')
    if result['sleepEnabled'] and result['sleepStart'] == result['sleepEnd']:
        raise ValueError('Sleep and wake times must differ')
    return result


def should_sleep(config, now):
    if not config['sleepEnabled']:
        return False
    current = now.hour * 60 + now.minute
    def minutes(value):
        hour, minute = map(int, value.split(':'))
        return hour * 60 + minute
    start, end = minutes(config['sleepStart']), minutes(config['sleepEnd'])
    # Start is inclusive; wake time is exclusive. Overnight windows wrap midnight.
    return start <= current < end if start < end else current >= start or current < end


def power_phase(config, now):
    if not should_sleep(config, now):
        return 'awake'
    hour, minute = map(int, config['sleepEnd'].split(':'))
    remaining = (hour * 3600 + minute * 60 - now.hour * 3600 - now.minute * 60 - now.second) % 86400
    def later(seconds):
        if now.tzinfo is None:
            return now + datetime.timedelta(seconds=seconds)
        return (now.astimezone(datetime.timezone.utc) + datetime.timedelta(seconds=seconds)).astimezone(now.tzinfo)
    if (remaining <= WARMUP_SECONDS and not should_sleep(config, later(remaining))) or not should_sleep(config, later(WARMUP_SECONDS)):
        return 'warming'
    return 'sleeping'


def local_now():
    return datetime.datetime.now(ZoneInfo(time_zone()))


def set_kiosk(running):
    result = subprocess.run(['systemctl', '--user', 'is-active', 'imframe-kiosk.service'],
                            capture_output=True, text=True, timeout=5)
    active = result.stdout.strip() in ('active', 'activating', 'reloading')
    if active != running:
        subprocess.run(['systemctl', '--user', 'start' if running else 'stop', 'imframe-kiosk.service'],
                       capture_output=True, text=True, check=True, timeout=25)
    return running


def exchange(report):
    request = urllib.request.Request('http://127.0.0.1:3000/api/display-agent',
                                     data=json.dumps(report).encode(),
                                     headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def physical_outputs():
    result = subprocess.run(['wlr-randr', '--json'], capture_output=True, text=True, check=True, timeout=5)
    # labwc creates this virtual output while HDMI is disconnected/disabled.
    # Its power state says nothing about the actual monitor.
    return [output for output in json.loads(result.stdout) if not output['name'].startswith('NOOP-')]


def power_states():
    result = subprocess.run(['wlopm'], capture_output=True, text=True, check=True, timeout=5)
    power = {match[1]: match[2] for line in result.stdout.splitlines()
             if (match := re.fullmatch(r'(\S+)\s+(on|off)', line.strip()))}
    states = []
    for output in physical_outputs():
        if not output['enabled']:
            states.append('off')
        elif output['name'] in power:
            states.append(power[output['name']])
        else:
            raise RuntimeError('The display changed while reading its power state.')
    return states


def set_power(sleeping):
    # DPMS preserves output mode/layout. Disabling an output with wlr-randr does not.
    subprocess.run(['wlopm', '--off' if sleeping else '--on', '*'],
                   capture_output=True, text=True, check=True, timeout=5)


def signal_desktop(program, event):
    result = subprocess.run(['pkill', f'-{event}', '-u', str(os.getuid()), '-x', program],
                            capture_output=True, text=True, timeout=5)
    # No matching process is normal, including when the desktop is shutting down.
    if result.returncode not in (0, 1):
        raise RuntimeError(f'Could not signal {program}.')


def configure_labwc(path, defaults=Path('/etc/xdg/labwc/rc.xml')):
    """Let the display service and output profiles control HDMI reconnects."""
    original = path.read_bytes() if path.exists() else None
    source = original if original is not None else defaults.read_bytes() if defaults.exists() else b'<labwc_config/>'
    root = ET.fromstring(source, parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))
    namespace = root.tag.split('}')[0] + '}' if root.tag.startswith('{') else ''
    if namespace:
        ET.register_namespace('', namespace[1:-1])
    core = root.find(namespace + 'core')
    if core is None:
        core = ET.SubElement(root, namespace + 'core')
    option = core.find(namespace + 'autoEnableOutputs')
    if option is not None and option.text == 'no':
        return
    if option is None:
        option = ET.SubElement(core, namespace + 'autoEnableOutputs')
    option.text = 'no'
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = path.with_name(path.name + '.before-imframe-sleep')
    if original is not None and not backup.exists():
        backup.write_bytes(original)
    temporary = path.with_suffix('.tmp')
    ET.ElementTree(root).write(temporary, encoding='utf-8', xml_declaration=True)
    temporary.chmod(0o600)
    temporary.replace(path)


class DisplayOutputs:
    def __init__(self, path):
        self.path = path
        try:
            saved = json.loads(path.read_text())
            self.saved = {name: value for name, value in saved.items() if self.valid(value)} if isinstance(saved, dict) else {}
        except (OSError, ValueError):
            self.saved = {}

    @staticmethod
    def valid(value):
        try:
            mode, position = value['mode'], value['position']
            return (all(type(mode[key]) is int and mode[key] > 0 for key in ('width', 'height'))
                    and all(type(position[key]) is int for key in ('x', 'y'))
                    and all(isinstance(number, (int, float)) and not isinstance(number, bool)
                            and math.isfinite(number) and number > 0 for number in (mode['refresh'], value['scale']))
                    and value['transform'] in ('normal', '90', '180', '270', 'flipped', 'flipped-90', 'flipped-180', 'flipped-270')
                    and type(value['adaptive_sync']) is bool)
        except (KeyError, TypeError):
            return False

    def remember(self, outputs):
        saved = dict(self.saved)
        for output in outputs:
            mode = next((mode for mode in output['modes'] if mode['current']), None)
            if output['enabled'] and mode:
                saved[output['name']] = {key: output[key] for key in ('position', 'transform', 'scale', 'adaptive_sync')}
                saved[output['name']]['mode'] = {key: mode[key] for key in ('width', 'height', 'refresh')}
        if saved == self.saved:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(saved) + '\n')
        temporary.chmod(0o600)
        temporary.replace(self.path)
        self.saved = saved

    def prepare(self, sleeping):
        if sleeping:
            # Save the real mode before the monitor's input detection makes it
            # disappear. Suspend every copy: merged labwc autostart can run two.
            self.remember(physical_outputs())
            signal_desktop('kanshi', 'STOP')
            return
        try:
            for output in physical_outputs():
                if output['enabled']:
                    continue
                saved = self.saved.get(output['name'], {})
                mode = saved.get('mode')
                supported = any(all(mode and abs(candidate[key] - mode[key]) < 0.01
                                    for key in ('width', 'height', 'refresh')) for candidate in output['modes'])
                command = ['wlr-randr', '--output', output['name'], '--on']
                if supported:
                    command += ['--mode', f"{mode['width']}x{mode['height']}@{mode['refresh']}Hz",
                                '--pos', f"{saved['position']['x']},{saved['position']['y']}",
                                '--transform', saved['transform'], '--scale', str(saved['scale']),
                                '--adaptive-sync', 'enabled' if saved['adaptive_sync'] else 'disabled']
                else:
                    # A new monitor or first boot has no saved mode yet.
                    command += ['--preferred']
                subprocess.run(command, capture_output=True, text=True, check=True, timeout=5)
        finally:
            # Also recover managers left stopped by a crash or service restart.
            signal_desktop('kanshi', 'CONT')
        self.remember(physical_outputs())


def wake(directory):
    DisplayOutputs(directory / 'outputs.json').prepare(False)
    set_power(False)


def cleanup(directory):
    # Preserve scheduled darkness across service updates and restarts. Explicit
    # --wake remains available for maintenance; the schedule resumes on startup.
    agent = DisplayAgent(directory / 'display.json')
    if should_sleep(agent.config, local_now()):
        agent.outputs.prepare(True)
        set_power(True)
        set_kiosk(False)
    else:
        wake(directory)


def time_zone():
    try:
        return str(Path('/etc/localtime').resolve().relative_to('/usr/share/zoneinfo'))
    except ValueError:
        return datetime.datetime.now().astimezone().tzname() or 'local time'


class DisplayAgent:
    def __init__(self, path):
        self.path = path
        try:
            self.config = schedule(json.loads(path.read_text()))
        except (OSError, ValueError):
            self.config = dict(DEFAULTS)
        self.outputs = DisplayOutputs(path.parent / 'outputs.json')
        self.report = {'sleeping': None, 'timeZone': time_zone(), 'error': None, 'kioskRunning': None}

    def save(self, config):
        if config == self.config and self.path.exists():
            return
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(config) + '\n')
        temporary.chmod(0o600)
        temporary.replace(self.path)
        self.config = config

    def tick(self, now=None):
        cache_error = None
        try:
            config = schedule(exchange(self.report))
        except (OSError, ValueError):
            # Container updates or network outages never prevent a scheduled wake.
            pass
        else:
            try:
                self.save(config)
            except OSError:
                cache_error = 'The Pi could not save sleep hours. Check its free disk space.'
        prior = self.report.copy()
        self.report['timeZone'] = time_zone()
        try:
            phase = power_phase(self.config, now or local_now())
            desired = phase != 'awake'
            target = 'off' if desired else 'on'
            if phase == 'sleeping':
                self.report['kioskRunning'] = set_kiosk(False)
            self.outputs.prepare(desired)
            states = power_states()
            if not states and not desired:
                raise RuntimeError('No physical display is connected.')
            if any(state != target for state in states):
                set_power(desired)
                states = power_states()
            self.report['sleeping'] = all(state == 'off' for state in states)
            self.report['error'] = cache_error if all(state == target for state in states) else 'The screen did not switch power state. Check the Pi display connection.'
            # Stopping Chromium releases its decoders, memory and network work.
            # During warmup it starts behind the still-sleeping HDMI output.
            if phase != 'sleeping':
                self.report['kioskRunning'] = set_kiosk(True)
        except (OSError, ValueError, subprocess.SubprocessError, RuntimeError):
            self.report['sleeping'] = None
            self.report['error'] = 'Screen power control is unavailable. Check the Pi desktop, wlopm, and wlr-randr installation.'
        if self.report != prior:
            try:
                exchange(self.report)
            except (OSError, ValueError):
                pass


def run(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / 'display.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        signal_desktop('labwc', 'HUP')
        agent = DisplayAgent(directory / 'display.json')
        stopping = threading.Event()
        for event in (signal.SIGTERM, signal.SIGINT):
            signal.signal(event, lambda *_: stopping.set())
        try:
            while not stopping.is_set():
                agent.tick()
                stopping.wait(10)
        finally:
            cleanup(directory)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--wake', action='store_true', help='Restore screen power when the service stops.')
    action.add_argument('--configure', action='store_true', help='Prevent labwc from waking sleeping HDMI outputs on reconnect.')
    action.add_argument('--cleanup', action='store_true', help='Leave the screen asleep during scheduled service updates.')
    action.add_argument('--is-sleeping', action='store_true', help='Exit successfully when a sleep window is active.')
    args = parser.parse_args()
    directory = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'imframe'
    if args.configure:
        configure_labwc(Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'labwc/rc.xml')
    elif args.wake:
        wake(directory)
    elif args.cleanup:
        cleanup(directory)
    elif args.is_sleeping:
        raise SystemExit(0 if should_sleep(DisplayAgent(directory / 'display.json').config, local_now()) else 1)
    else:
        run(directory)
