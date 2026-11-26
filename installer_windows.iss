; Inno Setup Script for RestroKOT Windows Installer (RestroKOT_Setup.exe)
; Compile with Inno Setup 6+ after running build_windows.bat

#define MyAppName "RestroKOT"
#define MyAppVersion "3.5"
#define MyAppPublisher "RestroKOT POS Suite"
#define MyAppExeName "RestroKOT.exe"

[Setup]
AppId={{8F4B9A21-6C3D-4E12-9F8A-1D2E3F4A5B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir=dist
OutputBaseFilename=RestroKOT_Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\RestroKOT\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; Open Windows Firewall ports 3000 & 3001 on private LAN so Captain mobiles & Kitchen TVs can connect
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""RestroKOT POS (Port 3000)"" dir=in action=allow protocol=TCP localport=3000 profile=private"; Flags: runhidden
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""RestroKOT Intercom (Port 3001)"" dir=in action=allow protocol=TCP localport=3001 profile=private"; Flags: runhidden
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
