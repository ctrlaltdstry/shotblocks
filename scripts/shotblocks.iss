; Inno Setup script for the Shotblocks installer.
;
; Wraps the clean tree produced by scripts/package.ps1 (dist/shotblocks/)
; into a one-click .exe that drops the plugin into the user's Cinema 4D
; 2026 plugins folder. The plugin is just a folder (no registry, no
; service), so the installer's only real job is finding the right
; plugins directory on an arbitrary machine and copying the tree there.
;
; Build (after installing Inno Setup 6 and running package.ps1):
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" scripts\shotblocks.iss
; Output: dist\shotblocks-v1.1.0-setup.exe
;
; UNSIGNED - SmartScreen will show a one-time warning (EV cert deferred
; to a later release). See .agent/plans/v1-plan-6-beta-installer.md for
; the trust rationale.

#define AppName "Shotblocks"
#define AppVersion "1.1.0"
#define AppPublisher "mkslate"
#define AppURL "https://mkslate.com"
; Staged clean tree, relative to this .iss file (scripts/ -> ..\dist\shotblocks).
#define StageDir "..\dist\shotblocks"
; Branding assets live under host\shotblocks\ (committed, unlike dist\).
#define IconFile "..\host\shotblocks\installer-icon.ico"

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
; Branding. SetupIconFile is the .exe's own icon (Explorer / downloads /
; taskbar) - a multi-res .ico generated from SB_UM_Icon.png.
SetupIconFile={#IconFile}
; Wizard graphics (the in-window images). BMP only; 1x + 2x supplied so Inno
; auto-picks for the user's DPI. Sidebar = welcome/finished left panel,
; corner = top-right of interior pages.
WizardImageFile=..\host\shotblocks\wizard-sidebar.bmp,..\host\shotblocks\wizard-sidebar2x.bmp
WizardSmallImageFile=..\host\shotblocks\wizard-corner.bmp,..\host\shotblocks\wizard-corner2x.bmp
; No admin: the per-user C4D prefs plugins folder needs no elevation, which
; matches Maxon's recommendation for third-party plugins.
PrivilegesRequired=lowest
; The plugin installs into the C4D plugins folder, chosen at runtime by
; code (see CurPageChanged / the [Code] section). DisableDirPage=no lets
; the user confirm or browse from the detected default.
DefaultDirName={code:GetDefaultPluginsDir}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Single-file installer in dist/ next to the zip.
OutputDir=..\dist
OutputBaseFilename=shotblocks-v{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; The plugin tree is small; show a license/info page with the unsigned note.
DirExistsWarning=no
; Always re-run folder detection. Without this, Inno remembers the last
; install dir per AppId (UsePreviousAppDir defaults to yes) and silently
; ignores DefaultDirName / our detection code on a reinstall.
UsePreviousAppDir=no
AppId={{6F2A1C84-2E3D-4B7A-9C1E-7B0C5A9E4D21}}

[Files]
; Recurse the staged clean tree into <plugins>\shotblocks\.
Source: "{#StageDir}\*"; DestDir: "{app}\shotblocks"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; A Start-menu shortcut to the bundled user manual (the plugin itself has
; no .exe to launch - it lives inside C4D).
Name: "{group}\Shotblocks User Manual"; Filename: "{app}\shotblocks\docs\index.html"
Name: "{group}\Uninstall Shotblocks"; Filename: "{uninstallexe}"

[Messages]
; Re-word the ready page so the user clearly sees WHERE it installs.
WelcomeLabel2=This will install [name/ver] into your Cinema 4D 2026 plugins folder.%n%nShotblocks is a plain plugin folder - no system changes. After install, restart Cinema 4D.

[Code]
{ --- C4D 2026 plugins-folder detection ---------------------------------
  The per-user prefs path has an install-specific build-hash suffix
  (e.g. "Maxon Cinema 4D 2026_1ABCDC12") that differs per machine, so we
  cannot hardcode it. We glob %APPDATA%\Maxon\Maxon Cinema 4D 2026_*.

  There can be MORE THAN ONE match: alongside the real active prefs
  folder, C4D may keep a stripped secondary profile with a "_p" suffix
  (and others). Picking the first match can land in the wrong one - the
  plugin then never loads even though the installer "succeeds".

  So we score candidates and pick the best:
    3 = has settings.userinstallation.json  (the live active install)
    2 = has a non-empty prefs\ subfolder     (a real, used profile)
    1 = exists but looks bare                (last resort)
  Within a tie we prefer one that already has a plugins\ folder. The
  authoritative marker is settings.userinstallation.json - it sits in the
  active install root and not in the "_p" secondary profile. }

function ScorePrefsFolder(Dir: String): Integer;
begin
  Result := 1;
  if FileExists(Dir + '\settings.userinstallation.json') then
    Result := 3
  else if DirExists(Dir + '\prefs') then
    Result := 2;
end;

function FindC4DPrefsPlugins(): String;
var
  MaxonDir, Dir: String;
  FindRec: TFindRec;
  Score, BestScore: Integer;
begin
  Result := '';
  BestScore := -1;
  MaxonDir := ExpandConstant('{userappdata}\Maxon');
  if not DirExists(MaxonDir) then
    Exit;
  if FindFirst(MaxonDir + '\Maxon Cinema 4D 2026_*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
        begin
          Dir := MaxonDir + '\' + FindRec.Name;
          Score := ScorePrefsFolder(Dir);
          { Prefer a higher score; on a tie prefer one that already has a
            plugins\ subfolder (an in-use install). }
          if (Score > BestScore)
             or ((Score = BestScore) and DirExists(Dir + '\plugins')) then
          begin
            BestScore := Score;
            Result := Dir + '\plugins';
          end;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function GetDefaultPluginsDir(Param: String): String;
var
  Detected: String;
begin
  Detected := FindC4DPrefsPlugins();
  if Detected <> '' then
    Result := Detected
  else
    { No C4D 2026 prefs folder found - default to the expected parent so
      the user can browse to the right place. Don't trap them. }
    Result := ExpandConstant('{userappdata}\Maxon');
end;

{ Warn (don't block) if the chosen folder doesn't look like a C4D 2026
  plugins folder, so a non-standard but valid layout isn't trapped. }
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Dir: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    Dir := WizardDirValue();
    if Pos('\plugins', Lowercase(Dir)) = 0 then
    begin
      if MsgBox('The selected folder does not look like a Cinema 4D "plugins" '
        + 'folder:' + #13#10 + Dir + #13#10#13#10
        + 'Shotblocks must go in your Cinema 4D 2026 plugins folder to load. '
        + 'Install here anyway?', mbConfirmation, MB_YESNO) = IDNO then
        Result := False;
    end;
  end;
end;
