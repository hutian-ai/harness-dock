#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef PackageVersion
  #error PackageVersion is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef ArtifactName
  #error ArtifactName is required
#endif

[Setup]
AppId={{430F887C-D140-4B01-A59F-CC44E1080A33}
AppName=界舟 · Harness Dock
AppVersion={#PackageVersion}
AppPublisher=hutian-ai
AppPublisherURL=https://hutian-ai.github.io/harness-dock/
DefaultDirName={localappdata}\Programs\HarnessDock
DefaultGroupName=界舟 · Harness Dock
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.22000
OutputDir={#OutputDir}
OutputBaseFilename={#ArtifactName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\HarnessDock.exe
CloseApplications=no
RestartApplications=no
LicenseFile={#PayloadDir}\resources\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
#if FileExists(AddBackslash(CompilerPath) + "Languages\ChineseSimplified.isl")
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\HarnessDock.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\resources\*"; DestDir: "{app}\resources"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\README.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\release.json"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\界舟 · Harness Dock"; Filename: "{app}\HarnessDock.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\界舟 · Harness Dock"; Filename: "{app}\HarnessDock.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\HarnessDock.exe"; Description: "Open Harness Dock"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
// Never terminate a daemon or overwrite/delete a running installation.
// Device identity, native logins, execution history and independent installations
// live outside {app} and are not part of the uninstall file list.
function DirectoryIdle(Directory: String): Boolean;
var
  Locator, Services, Processes, Process: Variant;
  I: Integer;
  ExecutablePath: String;
begin
  Result := False;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('', 'root\CIMV2');
    Processes := Services.ExecQuery('SELECT ExecutablePath FROM Win32_Process');
    Directory := Lowercase(AddBackslash(Directory));
    for I := 0 to Processes.Count - 1 do begin
      Process := Processes.ItemIndex(I);
      if not VarIsNull(Process.ExecutablePath) then begin
        ExecutablePath := Process.ExecutablePath;
        ExecutablePath := Lowercase(ExecutablePath);
        if (Pos(Directory, ExecutablePath) = 1) and
           not (IsUninstaller and (ExecutablePath = Lowercase(ExpandConstant('{uninstallexe}')))) then Exit;
      end;
    end;
    Result := True;
  except
    Log('Could not verify whether the installation directory is idle.');
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not DirectoryIdle(ExpandConstant('{app}')) then
    Result := 'Close Harness Dock before installing. If a background service is running from this folder, stop it from Overview only when no tasks are active or awaiting confirmation. Then retry.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := DirectoryIdle(ExpandConstant('{app}'));
  if not Result then
    SuppressibleMsgBox('Close Harness Dock first. If a background service is running from this folder, stop it from Overview only when no tasks are active or awaiting confirmation. Device settings and history will be preserved.', mbError, MB_OK, IDOK);
end;
