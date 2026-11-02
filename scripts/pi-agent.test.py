import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('frame_agent', Path(__file__).resolve().parents[1] / 'deploy/pi/agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTests(unittest.TestCase):
    def test_managed_frame_does_not_poll_registry_without_request(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(agent, 'exchange', return_value={'managedBy': 'hub'}), patch.object(agent.subprocess, 'run') as run:
            agent.run(Path(directory))
            run.assert_not_called()

    def test_requested_update_uses_fixed_command_and_reports_success(self):
        calls = []
        remote = {'managedBy': 'hub', 'requested': {'id': 'test-request'}}
        def exchange(data):
            calls.append(data)
            return remote
        with tempfile.TemporaryDirectory() as directory, patch.object(agent, 'exchange', side_effect=exchange), patch.object(agent.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            agent.run(Path(directory), '/fixed/updater.sh')
            run.assert_called_once_with(['bash', '/fixed/updater.sh'], check=False, timeout=540)
            self.assertEqual(calls[1]['state'], 'running')
            self.assertEqual(calls[-1]['state'], 'succeeded')

    def test_completed_request_does_not_run_again(self):
        remote = {'managedBy': 'hub', 'requested': {'id': 'test'}, 'result': {'id': 'test', 'state': 'succeeded'}}
        with tempfile.TemporaryDirectory() as directory, patch.object(agent, 'exchange', return_value=remote), patch.object(agent.subprocess, 'run') as run:
            agent.run(Path(directory))
            run.assert_not_called()

    def test_standalone_checks_are_limited_to_every_fifteen_minutes(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(agent, 'exchange', return_value={}), patch.object(agent.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            agent.run(Path(directory))
            agent.run(Path(directory))
            self.assertEqual(run.call_count, 1)

    def test_failure_is_reported(self):
        calls = []
        def exchange(data):
            calls.append(data)
            return {'managedBy': 'hub', 'requested': {'id': 'test'}}
        with tempfile.TemporaryDirectory() as directory, patch.object(agent, 'exchange', side_effect=exchange), patch.object(agent.subprocess, 'run', return_value=SimpleNamespace(returncode=1)):
            with self.assertRaises(SystemExit):
                agent.run(Path(directory))
            self.assertEqual(calls[-1]['state'], 'failed')


if __name__ == '__main__':
    unittest.main()
