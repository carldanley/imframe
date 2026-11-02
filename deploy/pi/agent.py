#!/usr/bin/env python3
"""Run the fixed Pi updater when Hub asks; standalone frames still check every 15 minutes."""
import fcntl
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


def exchange(payload):
    request = urllib.request.Request(
        'http://127.0.0.1:3000/api/update-agent',
        data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'}, method='POST',
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def run(directory=Path('/opt/imframe'), updater='/usr/local/libexec/imframe/update.sh'):
    # The host, never the container, owns Docker access and the allowed image tag.
    with (directory / 'agent.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state_file = directory / 'agent.json'
        try:
            state = json.loads(state_file.read_text())
        except FileNotFoundError:
            state = {}
        try:
            remote = exchange({})
        except (urllib.error.URLError, TimeoutError, ValueError):
            remote = {}
        request = remote.get('requested') or {}
        result = remote.get('result') or {}
        requested = request.get('id') and not (result.get('id') == request['id'] and result.get('state') in ('succeeded', 'failed'))
        if not requested:
            if remote.get('managedBy'):
                return
            if time.time() - state.get('lastCheck', 0) < 900:
                return
        request_id = request.get('id') if requested else None
        if request_id:
            exchange({'id': request_id, 'state': 'running', 'message': 'Checking for a container update.'})
        state['lastCheck'] = time.time()
        temporary = state_file.with_suffix('.tmp')
        temporary.write_text(json.dumps(state) + '\n')
        temporary.chmod(0o600)
        temporary.replace(state_file)
        try:
            completed = subprocess.run(['bash', updater], check=False, timeout=540)
            success = completed.returncode == 0
        except subprocess.TimeoutExpired:
            success = False
        if request_id:
            payload = {'id': request_id, 'state': 'succeeded' if success else 'failed',
                       'message': 'Frame is up to date.' if success else 'Update failed; check the Pi update service log.'}
            # The container can briefly be unavailable during a healthy replacement.
            for attempt in range(6):
                try:
                    exchange(payload)
                    break
                except (urllib.error.URLError, TimeoutError, ValueError):
                    if attempt == 5:
                        raise
                    time.sleep(2)
        if not success:
            raise SystemExit(1)


if __name__ == '__main__':
    os.umask(0o077)
    run()
