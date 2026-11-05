import datetime
import importlib.util
import json
import subprocess
import tempfile
import unittest
import urllib.error
import xml.etree.ElementTree as ET
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
    def setUp(self):
        self.output_guard = patch.object(display.DisplayOutputs, 'prepare').start()
        self.addCleanup(patch.stopall)

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
        with patch.object(display.subprocess, 'run', return_value=SimpleNamespace(stdout='HDMI-A-1 off\nHDMI-A-2 on\n')) as run, \
             patch.object(display, 'physical_outputs', return_value=[{'name': name, 'enabled': True} for name in ['HDMI-A-1', 'HDMI-A-2']]):
            self.assertEqual(display.power_states(), ['off', 'on'])
            display.set_power(True)
            run.assert_called_with(['wlopm', '--off', '*'], capture_output=True, text=True, check=True, timeout=5)
            display.set_power(False)
            run.assert_called_with(['wlopm', '--on', '*'], capture_output=True, text=True, check=True, timeout=5)

    def test_disconnected_monitor_during_sleep_is_not_a_wake_request(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(display, 'exchange', return_value=NIGHT), \
             patch.object(display, 'power_states', return_value=[]), patch.object(display, 'set_power') as power:
            agent = display.DisplayAgent(Path(directory) / 'display.json')
            agent.tick(at('23:00'))
            self.assertTrue(agent.report['sleeping'])
            self.assertIsNone(agent.report['error'])
            power.assert_not_called()
            agent.tick(at('07:00'))
            self.assertIsNone(agent.report['sleeping'])
            self.assertIsNotNone(agent.report['error'])


def monitor(enabled=True, refresh=100.0):
    return {'name': 'HDMI-A-1', 'enabled': enabled, 'position': {'x': 0, 'y': 0}, 'scale': 1.0,
            'transform': 'normal', 'adaptive_sync': False,
            'modes': [{'width': 1920, 'height': 1080, 'refresh': refresh, 'current': enabled, 'preferred': False}]}


class ReconnectTests(unittest.TestCase):
    def test_reconnect_stays_disabled_and_wake_after_restart_restores_100hz(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(display, 'signal_desktop') as signals, \
             patch.object(display, 'physical_outputs') as outputs, patch.object(display.subprocess, 'run') as run:
            path = Path(directory) / 'outputs.json'
            guard = display.DisplayOutputs(path)
            outputs.return_value = [monitor()]
            guard.prepare(True)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            signals.assert_called_with('kanshi', 'STOP')
            outputs.return_value = [monitor(enabled=False)]
            guard.prepare(True)
            run.assert_not_called()
            # Losing the HDMI head must not replace the saved mode with NOOP-1.
            outputs.return_value = []
            guard.prepare(True)
            guard = display.DisplayOutputs(path)
            outputs.side_effect = [[monitor(enabled=False)], [monitor()]]
            guard.prepare(False)
            command = run.call_args.args[0]
            self.assertEqual(command[:4], ['wlr-randr', '--output', 'HDMI-A-1', '--on'])
            self.assertIn('1920x1080@100.0Hz', command)
            self.assertIn('0,0', command)
            signals.assert_called_with('kanshi', 'CONT')

    def test_virtual_fallback_does_not_count_as_an_awake_monitor(self):
        responses = [SimpleNamespace(stdout='NOOP-1 on\n'), SimpleNamespace(stdout=json.dumps([
            monitor(enabled=False), {'name': 'NOOP-1', 'enabled': True}]))]
        with patch.object(display.subprocess, 'run', side_effect=responses):
            self.assertEqual(display.power_states(), ['off'])

    def test_new_monitor_uses_preferred_mode_and_resumes_managers(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(display, 'signal_desktop') as signals, \
             patch.object(display, 'physical_outputs', return_value=[monitor(enabled=False)]), \
             patch.object(display.subprocess, 'run') as run:
            display.DisplayOutputs(Path(directory) / 'outputs.json').prepare(False)
            self.assertEqual(run.call_args.args[0], ['wlr-randr', '--output', 'HDMI-A-1', '--on', '--preferred'])
            signals.assert_called_once_with('kanshi', 'CONT')

    def test_failed_wake_still_resumes_desktop_output_managers(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(display, 'signal_desktop') as signals, \
             patch.object(display, 'physical_outputs', return_value=[monitor(enabled=False)]), \
             patch.object(display.subprocess, 'run', side_effect=subprocess.TimeoutExpired('wlr-randr', 5)):
            with self.assertRaises(subprocess.TimeoutExpired):
                display.DisplayOutputs(Path(directory) / 'outputs.json').prepare(False)
            signals.assert_called_once_with('kanshi', 'CONT')

    def test_cannot_sleep_if_display_mode_cannot_be_saved(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(display, 'signal_desktop') as signals, \
             patch.object(display, 'physical_outputs', return_value=[monitor()]), \
             patch.object(Path, 'write_text', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                display.DisplayOutputs(Path(directory) / 'outputs.json').prepare(True)
            signals.assert_not_called()

    def test_service_stop_recovers_output_managers_and_power(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(display.DisplayOutputs, 'prepare') as prepare, \
             patch.object(display, 'set_power') as power:
            display.wake(Path(directory))
            prepare.assert_called_once_with(False)
            power.assert_called_once_with(False)

    def test_corrupt_output_cache_does_not_prevent_waking(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'outputs.json'
            for content in ['{broken', '[]', '{"HDMI-A-1":null}', '{"HDMI-A-1":{"mode":"invalid"}}']:
                path.write_text(content)
                with self.subTest(content=content):
                    self.assertEqual(display.DisplayOutputs(path).saved, {})

    def test_labwc_configuration_preserves_existing_preferences_and_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rc.xml'
            original = b'<openbox_config xmlns="http://openbox.org/3.4/rc"><!-- keep --><core><gap>4</gap><autoEnableOutputs>yes</autoEnableOutputs></core><keyboard><repeatRate>25</repeatRate></keyboard></openbox_config>'
            path.write_bytes(original)
            display.configure_labwc(path)
            first = path.read_bytes()
            display.configure_labwc(path)
            self.assertEqual(first, path.read_bytes())
            self.assertEqual(path.with_name('rc.xml.before-imframe-sleep').read_bytes(), original)
            ns = {'x': 'http://openbox.org/3.4/rc'}
            root = ET.parse(path)
            self.assertEqual(root.find('x:core/x:autoEnableOutputs', ns).text, 'no')
            self.assertEqual(root.find('x:core/x:gap', ns).text, '4')
            self.assertEqual(root.find('x:keyboard/x:repeatRate', ns).text, '25')
            self.assertIn(b'<!-- keep -->', first)

    def test_first_setup_retains_system_desktop_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            defaults = Path(directory) / 'system.xml'
            defaults.write_text('<labwc_config><keyboard><repeatRate>30</repeatRate></keyboard></labwc_config>')
            path = Path(directory) / 'user/rc.xml'
            display.configure_labwc(path, defaults)
            self.assertEqual(ET.parse(path).find('core/autoEnableOutputs').text, 'no')
            self.assertEqual(ET.parse(path).find('keyboard/repeatRate').text, '30')


if __name__ == '__main__':
    unittest.main()
