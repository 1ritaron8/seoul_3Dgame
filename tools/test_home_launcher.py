"""Windows launcher contract tests using mocked processes, never real UE5.

Run with: python -m unittest discover -s tools -p test_home_launcher.py -v
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from uuid import uuid4


@unittest.skipUnless(os.name == 'nt' and shutil.which('powershell.exe'), 'Windows PowerShell required')
class HomeLauncherTests(unittest.TestCase):
    def setUp(self):
        self.source = Path(__file__).resolve().parents[1]
        # mkdir avoids restrictive tempfile ACLs in the Windows execution sandbox.
        self.root = self.source / 'work' / ('launcher test ' + uuid4().hex)
        self.root.mkdir(parents=True)
        self.addCleanup(self.clean_owned_directory)
        (self.root / 'tools').mkdir()
        shutil.copyfile(self.source / 'tools' / 'play_guil.ps1', self.root / 'tools' / 'play_guil.ps1')
        shutil.copyfile(self.source / 'Play-Guil.cmd', self.root / 'Play-Guil.cmd')
        (self.root / 'tools' / 'build_shinyeong_walk.py').write_text('# mock builder\n')
        self.project = self.root / 'Guil2026'
        self.project.mkdir()
        (self.project / 'Guil2026.uproject').write_text('{}')
        self.map = self.project / 'Content' / 'GuilWalk' / 'ShinyeongWalk.umap'
        self.engine = self.root / 'Fake UE installation'
        binaries = self.engine / 'Engine' / 'Binaries' / 'Win64'
        binaries.mkdir(parents=True)
        self.editor = binaries / 'UnrealEditor.exe'
        self.editor.write_bytes(b'not an executable')
        (binaries / 'UnrealEditor-Cmd.exe').write_bytes(b'not an executable')
        packs = self.engine / 'FeaturePacks'
        packs.mkdir()
        (packs / 'TP_FirstPersonBP.upack').write_bytes(b'fake template')
        self.calls = self.root / 'calls.jsonl'
        self.wrapper = self.root / 'mock processes.ps1'
        self.wrapper.write_text(r'''
$ErrorActionPreference = 'Stop'
function Start-Process {
    [CmdletBinding()]
    param([string]$FilePath, [object[]]$ArgumentList, [switch]$Wait,
          [switch]$PassThru, [string]$WindowStyle, [string]$WorkingDirectory)
    $joined = $ArgumentList -join ' '
    $ini = if ($joined -match '(?i)-defgameini="([^"]+)"') {
        [IO.File]::ReadAllText($Matches[1])
    }
    @{file=$FilePath; arguments=$joined; wait=[bool]$Wait; window=$WindowStyle; ini=$ini} |
        ConvertTo-Json -Compress | Add-Content -LiteralPath $env:MOCK_CALLS
    if ($FilePath -match 'UnrealEditor-Cmd\.exe$') {
        if ($joined -notmatch '(?i)-abslog=(?:"([^"]+)"|([^\s]+))') {
            throw 'Build invocation did not supply an absolute log path'
        }
        $log = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
        if ($env:MOCK_MODE -in @('success', 'nonzero')) {
            New-Item -ItemType Directory -Force -Path (Split-Path $env:MOCK_MAP) | Out-Null
            [IO.File]::WriteAllText($env:MOCK_MAP, 'complete mock map')
            [IO.File]::WriteAllText($log, 'Walking map saved: /Game/GuilWalk/ShinyeongWalk')
        } elseif ($env:MOCK_MODE -eq 'existing') {
            [IO.File]::WriteAllText($log, 'Existing walking map reopened unchanged: /Game/GuilWalk/ShinyeongWalk')
        } elseif ($env:MOCK_MODE -eq 'missing') {
            [IO.File]::WriteAllText($log, 'Walking map saved: /Game/GuilWalk/ShinyeongWalk')
        } else {
            New-Item -ItemType Directory -Force -Path (Split-Path $env:MOCK_MAP) | Out-Null
            if (!(Test-Path -LiteralPath $env:MOCK_MAP)) {
                [IO.File]::WriteAllText($env:MOCK_MAP, 'incomplete mock map')
            }
            [IO.File]::WriteAllText($log, 'RuntimeError: build failed')
        }
        $code = if ($env:MOCK_MODE -eq 'nonzero') { 7 } else { 0 }
        return [pscustomobject]@{ExitCode=$code; HasExited=$true; Id=123}
    }
    if ($FilePath -notmatch 'UnrealEditor\.exe$') { throw "Unexpected process: $FilePath" }
    return [pscustomobject]@{ExitCode=0; HasExited=$true; Id=124}
}
& $env:MOCK_LAUNCHER -UnrealEditor $env:MOCK_EDITOR
exit $LASTEXITCODE
''', encoding='utf-8')

    def clean_owned_directory(self):
        self.assertEqual(self.root.resolve().parent, (self.source / 'work').resolve())
        self.assertTrue(self.root.name.startswith('launcher test '))
        shutil.rmtree(self.root)

    def run_launcher(self, mode='success'):
        env = dict(os.environ, MOCK_MODE=mode, MOCK_CALLS=str(self.calls),
                   MOCK_MAP=str(self.map), MOCK_EDITOR=str(self.editor),
                   MOCK_LAUNCHER=str(self.root / 'tools' / 'play_guil.ps1'))
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive',
                                 '-ExecutionPolicy', 'RemoteSigned', '-File', str(self.wrapper)],
                                env=env, cwd=self.root, capture_output=True, text=True,
                                timeout=45)
        calls = []
        if self.calls.exists():
            calls = [json.loads(line) for line in self.calls.read_text(encoding='utf-8-sig').splitlines()]
        return result, calls

    def test_first_run_builds_and_second_run_only_starts_game(self):
        result, calls = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(calls), 2, calls)
        self.assertTrue(calls[0]['file'].endswith('UnrealEditor-Cmd.exe'))
        args = calls[0]['arguments'].lower()
        self.assertIn('-executepythonscript=', args)
        self.assertIn('-defgameini=', args)
        self.assertIn('bAddPacks=True', calls[0]['ini'])
        self.assertIn('PackSource="TP_FirstPersonBP.upack"', calls[0]['ini'])
        self.assertIn('-abslog=', args)
        self.assertTrue(calls[0]['wait'])
        self.assertEqual(calls[0]['window'].lower(), 'hidden')
        self.assertIn('-game', calls[1]['arguments'].lower())
        self.assertTrue((self.project / 'Saved' / 'GuilWalk.home.sha256').is_file())
        before = self.map.read_bytes()
        result, calls = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(calls), 3, calls)
        self.assertTrue(calls[-1]['file'].endswith('UnrealEditor.exe'))
        self.assertIn('-game', calls[-1]['arguments'].lower())
        self.assertEqual(self.map.read_bytes(), before)

    def test_exit_zero_with_failed_partial_map_never_starts_game(self):
        result, calls = self.run_launcher('failure')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(calls), 1, calls)
        self.assertFalse((self.project / 'Saved' / 'GuilWalk.home.sha256').exists())

    def test_success_log_without_map_never_starts_game(self):
        result, calls = self.run_launcher('missing')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(calls), 1, calls)

    def test_missing_blueprint_pack_stops_before_starting_editor(self):
        (self.engine / 'FeaturePacks' / 'TP_FirstPersonBP.upack').unlink()
        result, calls = self.run_launcher()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('First Person Blueprint pack', result.stderr)
        self.assertEqual(calls, [])

    def test_nonzero_exit_never_starts_game(self):
        result, calls = self.run_launcher('nonzero')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(calls), 1, calls)

    def test_unverified_existing_map_preserved_without_template_install(self):
        self.map.parent.mkdir(parents=True)
        self.map.write_bytes(b'user existing unverified map')
        result, calls = self.run_launcher('failure')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(calls), 1, calls)
        self.assertNotIn('-defgameini=', calls[0]['arguments'].lower())
        self.assertEqual(self.map.read_bytes(), b'user existing unverified map')

    def test_existing_map_confirmation_can_launch_without_overwrite(self):
        self.map.parent.mkdir(parents=True)
        self.map.write_bytes(b'user existing complete map')
        result, calls = self.run_launcher('existing')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(calls), 2, calls)
        self.assertNotIn('-defgameini=', calls[0]['arguments'].lower())
        self.assertIn('-game', calls[1]['arguments'].lower())
        self.assertEqual(self.map.read_bytes(), b'user existing complete map')


if __name__ == '__main__':
    unittest.main()
