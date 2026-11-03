#!/usr/bin/env python3
"""Apply daily screen sleep hours in the desktop session, without stopping the Pi."""
import argparse
import datetime
import fcntl
import json
import os
import re
import signal
import subprocess
import threading
import urllib.error
import urllib.request
from pathlib import Path

DEFAULTS = {'sleepEnabled': False, 'sleepStart': '22:00', 'sleepEnd': '07:00'}


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


def exchange(report):
    request = urllib.request.Request('http://127.0.0.1:3000/api/display-agent',
                                     data=json.dumps(report).encode(),
                                     headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def power_states():
    result = subprocess.run(['wlopm'], capture_output=True, text=True, check=True, timeout=5)
    states = [match[2] for line in result.stdout.splitlines()
              if (match := re.fullmatch(r'(\S+)\s+(on|off)', line.strip()))]
    if not states:
        raise RuntimeError('No display is connected to the Pi desktop.')
    return states


def set_power(sleeping):
    # DPMS preserves output mode/layout. Disabling an output with wlr-randr does not.
    subprocess.run(['wlopm', '--off' if sleeping else '--on', '*'],
                   capture_output=True, text=True, check=True, timeout=5)


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
        self.report = {'sleeping': None, 'timeZone': time_zone(), 'error': None}

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
            desired = should_sleep(self.config, now or datetime.datetime.now().astimezone())
            target = 'off' if desired else 'on'
            states = power_states()
            if any(state != target for state in states):
                set_power(desired)
                states = power_states()
            self.report['sleeping'] = all(state == 'off' for state in states)
            self.report['error'] = cache_error if all(state == target for state in states) else 'The screen did not switch power state. Check the Pi display connection.'
        except (OSError, subprocess.SubprocessError, RuntimeError):
            self.report['sleeping'] = None
            self.report['error'] = 'Screen power control is unavailable. Check the Pi desktop and wlopm installation.'
        if self.report != prior:
            try:
                exchange(self.report)
            except (OSError, ValueError):
                pass


def run():
    directory = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'imframe'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / 'display.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        agent = DisplayAgent(directory / 'display.json')
        stopping = threading.Event()
        for event in (signal.SIGTERM, signal.SIGINT):
            signal.signal(event, lambda *_: stopping.set())
        try:
            while not stopping.is_set():
                agent.tick()
                stopping.wait(10)
        finally:
            set_power(False)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wake', action='store_true', help='Restore screen power when the service stops.')
    if parser.parse_args().wake:
        set_power(False)
    else:
        run()
