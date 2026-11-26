# -*- mode: python ; coding: utf-8 -*-
# PyInstaller Spec file for RestroKOT Single-File Portable Windows Executable (RestroKOT_Portable.exe)

import os
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

datas = [
    ('public', 'public'),
]

hiddenimports = [
    'app',
    'db',
    'flask',
    'jinja2',
    'werkzeug',
    'werkzeug.serving',
    'sqlite3',
    'webview',
    'clr',
    'pythonnet',
] + collect_submodules('webview')

a = Analysis(
    ['desktop_app.py'],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'numpy', 'scipy', 'pandas'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='RestroKOT_Portable',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='public/favicon.ico' if (os.path.exists('public/favicon.ico') and os.path.getsize('public/favicon.ico') > 0) else None,
)
