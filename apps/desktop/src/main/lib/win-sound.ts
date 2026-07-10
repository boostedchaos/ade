/**
 * PowerShell script for playing a sound file on Windows.
 *
 * The legacy approach used `Media.SoundPlayer`, which only decodes WAV — every
 * bundled ringtone is `.mp3`, so playback was silent. WPF's `MediaPlayer`
 * (from presentationCore) decodes mp3 via the OS media stack.
 *
 * Two correctness details:
 *  - `MediaPlayer.Play()` is asynchronous. If the powershell process exits
 *    immediately, playback is cut off. We poll `Position` against
 *    `NaturalDuration` and only exit once playback finishes (capped at 30s so a
 *    failed load can't hang the process forever).
 *  - The file path is passed via the `ADE_SOUND_PATH` environment variable and
 *    read as `$env:ADE_SOUND_PATH` — it never enters the script text — so paths
 *    containing quotes, spaces, or other metacharacters can't break parsing or
 *    inject commands. `[System.Uri]` turns the absolute path into a file URI.
 *
 * Callers spawn `powershell -NoProfile -Command WIN_PLAY_SOUND_SCRIPT` with
 * `env: { ...process.env, [WIN_SOUND_PATH_ENV]: soundPath }`.
 */
export const WIN_SOUND_PATH_ENV = "ADE_SOUND_PATH";

export const WIN_PLAY_SOUND_SCRIPT = [
	"Add-Type -AssemblyName presentationCore;",
	"$p = New-Object System.Windows.Media.MediaPlayer;",
	`$p.Open([System.Uri]$env:${WIN_SOUND_PATH_ENV});`,
	"$p.Play();",
	"$deadline = (Get-Date).AddSeconds(30);",
	"while ((Get-Date) -lt $deadline) {",
	"  Start-Sleep -Milliseconds 100;",
	"  if ($p.NaturalDuration.HasTimeSpan -and $p.Position -ge $p.NaturalDuration.TimeSpan) { break }",
	"}",
].join("");
