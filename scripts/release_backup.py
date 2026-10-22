#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
消防小本本 (Fire Notebook) — 自動版本備份與 README 更新工具
用法:
  python scripts/release_backup.py --version v2.1.0 --slug "UI2.0-方案A零閃爍與新LOGO" --summary "1. 手機捲動改為方案A自然捲走(100%零閃爍)；2. 更換消防業務與救護包新LOGO；3. 預設載入當年度全部案件＋跨年未結案；4. 手機公文內文與新增建檔採用Bottom Sheet抽屜模式"
"""

import argparse
import datetime
import hashlib
import json
import pathlib
import shutil
import zipfile

ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent
OUTPUTS_DIR = ROOT_DIR / "outputs"
PWA_DIR = ROOT_DIR / "pwa"
BACKUPS_DIR = ROOT_DIR / "backups"
VERSIONS_JSON = BACKUPS_DIR / "versions.json"

TRACKED_OUTPUT_FILES = [
    "Code.gs",
    "Index.html",
    "UI-Preview.html",
    "Desktop-Icon.ico",
    "Desktop-Icon.png",
    "Desktop-Icon-192.png",
    "Desktop-Icon-180.png",
]


def sha256_of(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def create_backup(version: str, slug: str, summary: str, changes: list[str]) -> dict:
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    timestamp_str = now.strftime("%Y-%m-%d %H:%M:%S")
    folder_name = f"{version}_{date_str}_{slug}"
    target_dir = BACKUPS_DIR / folder_name
    target_dir.mkdir(parents=True, exist_ok=True)

    copied_files = []
    out_sub = target_dir / "outputs"
    out_sub.mkdir(parents=True, exist_ok=True)

    for fname in TRACKED_OUTPUT_FILES:
        src = OUTPUTS_DIR / fname
        if src.exists():
            dst = out_sub / fname
            shutil.copy2(src, dst)
            copied_files.append({
                "relativePath": f"outputs/{fname}",
                "sizeBytes": dst.stat().st_size,
                "sha256": sha256_of(dst),
            })

    if PWA_DIR.exists():
        pwa_sub = target_dir / "pwa"
        pwa_sub.mkdir(parents=True, exist_ok=True)
        for src in sorted(PWA_DIR.rglob("*")):
            if src.is_file():
                rel = src.relative_to(PWA_DIR)
                dst = pwa_sub / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                copied_files.append({
                    "relativePath": f"pwa/{rel.as_posix()}",
                    "sizeBytes": dst.stat().st_size,
                    "sha256": sha256_of(dst),
                })

    manifest = {
        "version": version,
        "slug": slug,
        "date": date_str,
        "createdAt": timestamp_str,
        "folderName": folder_name,
        "summary": summary,
        "changes": changes,
        "files": copied_files,
    }

    manifest_path = target_dir / "VERSION_MANIFEST.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    # Create a .zip archive of this version snapshot
    zip_path = BACKUPS_DIR / f"{folder_name}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(target_dir.rglob("*")):
            if file_path.is_file():
                zf.write(file_path, file_path.relative_to(target_dir).as_posix())

    # Update versions.json registry
    registry = []
    if VERSIONS_JSON.exists():
        try:
            registry = json.loads(VERSIONS_JSON.read_text(encoding="utf-8"))
        except Exception:
            registry = []

    registry = [entry for entry in registry if entry.get("version") != version]
    registry.insert(0, manifest)
    VERSIONS_JSON.write_text(json.dumps(registry, ensure_ascii=False, indent=2), encoding="utf-8")

    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="建立消防小本本版本備份快照")
    parser.add_argument("--version", required=True, help="版本號，例如 v2.1.0")
    parser.add_argument("--slug", required=True, help="簡短版本標籤，例如 UI2.0-方案A零閃爍與新LOGO")
    parser.add_argument("--summary", required=True, help="版本重點摘要")
    parser.add_argument("--change", action="append", default=[], help="單條變更項目（可重複指定）")
    args = parser.parse_args()

    changes_list = args.change if args.change else [s.strip() for s in args.summary.split("；") if s.strip()]
    info = create_backup(args.version, args.slug, args.summary, changes_list)
    print(f"Backup created: {info['folderName']} ({len(info['files'])} files)")

