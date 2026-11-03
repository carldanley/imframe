import datetime
import importlib.util
import json
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

spec = importlib.util.spec_from_file_location('frame_display', Path(__file__).resolve().parents[1] / 'deploy/pi/display.py')
display = importlib.util.module_from_spec(spec)
spec.loader.exec_module(display)
NIGHT = {'sleepEnabled': True, 'sleepStart': '22:00', 'sleepEnd': '07:00'}


def at(time):
    return datetime.datetime.fromisoformat('2026-11-03T' + time)


class DisplayTests(unittest.TestCase):
    def test_overnight_window_and_exact_boundaries(self):
        for time, expected in [('21:59', False), ('22:00', True), ('23:59', True), ('00:00', True), ('06:59', True), ('07:00', False)]:
            with self.subTest(time=time):
                self.assertEqual(display.should_sleep(NIGHT, at(time)), expected)

    def test_daytime_window_and_disabled_schedule(self):
        config = {**NIGHT, 'sleepStart': '09:00', 'sleepEnd': '17:00'}
        for time, expected in [('08:59', False), ('09:00', True), ('16:59', True), ('17:00', False), ('23:00', False)]:
            self.assertEqual(display.should_sleep(config, at(time)), expected)
        self.assertFalse(display.should_sleep({**NIGHT, 'sleepEnabled': False}, at('23:00')))

    def test_dst_uses_local_wall_clock_including_skipped_wake_time(self):
        zone = ZoneInfo('America/New_York')
        config = {**NIGHT, 'sleepEnd': '02:30'}
        before = datetime.datetime.fromisoformat('2026-03-08T06:59:00+00:00').astimezone(zone)
        after = datetime.datetime.fromisoformat('2026-03-08T07:00:00+00:00').astimezone(zone)
        self.assertTrue(display.should_sleep(config, before))
        self.assertFalse(display.should_sleep(config, after))
        for utc in ['2026-11-01T05:30:00+00:00', '2026-11-01T06:30:00+00:00']:
            self.assertTrue(display.should_sleep(NIGHT, datetime.datetime.fromisoformat(utc).astimezone(zone)))

    def test_rejects_invalid_or_ambiguous_schedule(self):
        for change in [{'sleepEnabled': 1}, {'sleepStart': '24:00'}, {'sleepEnd': '7:00'}, {'sleepStart': None}, {'sleepEnd': '22:00'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                display.schedule({**NIGHT, **change})

    def test_cached_schedule_sleeps_and_wakes_after_restart_with_app_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'display.json'
            display.DisplayAgent(path).save(NIGHT)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            agent = display.DisplayAgent(path)
            with patch.object(display, 'exchange', side_effect=urllib.error.URLError('offline')), \
                 patch.object(display, 'power_states', side_effect=[['on'], ['off'], ['off'], ['on']]), \
                 patch.object(display, 'set_power') as power:
                agent.tick(at('23:00'))
                self.assertTrue(agent.report['sleeping'])
                agent.tick(at('07:00'))
                self.assertFalse(agent.report['sleeping'])
                self.assertEqual([call.args for call in power.call_args_list], [(True,), (False,)])

    def test_disabling_schedule_wakes_and_persists(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = display.DisplayAgent(Path(directory) / 'display.json')
            agent.save(NIGHT)
            disabled = {**NIGHT, 'sleepEnabled': False}
            with patch.object(display, 'exchange', return_value=disabled), \
                 patch.object(display, 'power_states', side_effect=[['off'], ['on']]), \
                 patch.object(display, 'set_power') as power:
                agent.tick(at('23:00'))
                power.assert_called_once_with(False)
                self.assertEqual(json.loads(agent.path.read_text()), disabled)

    def test_no_repeated_power_command_but_rechecks_after_external_wake(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(display, 'exchange', return_value=NIGHT), \
             patch.object(display, 'power_states', side_effect=[['off'], ['on'], ['off']]), \
             patch.object(display, 'set_power') as power:
            agent = display.DisplayAgent(Path(directory) / 'display.json')
            agent.tick(at('23:00'))
            power.assert_not_called()
            agent.tick(at('23:01'))
            power.assert_called_once_with(True)

    def test_bad_api_response_does_not_replace_last_valid_schedule(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(display, 'exchange', return_value={}), \
             patch.object(display, 'power_states', return_value=['off']):
            agent = display.DisplayAgent(Path(directory) / 'display.json')
            agent.save(NIGHT)
            agent.tick(at('23:00'))
            self.assertEqual(agent.config, NIGHT)

    def test_failed_persistence_does_not_activate_a_schedule_that_cannot_survive_restart(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(display, 'exchange', return_value=NIGHT), \
             patch.object(display, 'power_states', return_value=['on']), patch.object(display, 'set_power') as power:
            agent = display.DisplayAgent(Path(directory) / 'display.json')
            with patch.object(agent, 'save', side_effect=OSError('disk full')):
                agent.tick(at('23:00'))
            power.assert_not_called()
            self.assertIn('save sleep hours', agent.report['error'])

    def test_failed_power_command_reports_unknown_instead_of_claiming_sleep(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(display, 'exchange', return_value=NIGHT), \
             patch.object(display, 'power_states', return_value=['on']), \
             patch.object(display, 'set_power', side_effect=subprocess.TimeoutExpired('wlopm', 5)):
            agent = display.DisplayAgent(Path(directory) / 'display.json')
            agent.tick(at('23:00'))
            self.assertIsNone(agent.report['sleeping'])
            self.assertIsNotNone(agent.report['error'])

    def test_corrupt_cache_falls_back_to_awake(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'display.json'
            path.write_text('{broken')
            self.assertFalse(display.DisplayAgent(path).config['sleepEnabled'])

    def test_fixed_dpms_commands_and_multiple_outputs(self):
        with patch.object(display.subprocess, 'run', return_value=SimpleNamespace(stdout='HDMI-A-1 off\nHDMI-A-2 on\n')) as run:
            self.assertEqual(display.power_states(), ['off', 'on'])
            display.set_power(True)
            run.assert_called_with(['wlopm', '--off', '*'], capture_output=True, text=True, check=True, timeout=5)
            display.set_power(False)
            run.assert_called_with(['wlopm', '--on', '*'], capture_output=True, text=True, check=True, timeout=5)


if __name__ == '__main__':
    unittest.main()
