#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deploy.py — полный авто-деплой на GitHub одной командой.

Что делает:
  1. Проверяет, что git установлен
  2. Читает deploy.config.json (создаёт шаблон при первом запуске)
  3. Инициализирует git (если ещё нет)
  4. Проверяет, существует ли репо на GitHub — если нет, создаёт через API
  5. Настраивает remote с твоим токеном
  6. Коммитит все изменения с текущей датой/временем
  7. Пушит в выбранную ветку (force — если обычный пуш не прошёл)
  8. Включает GitHub Pages (source: <branch> / root)
  9. В конце печатает ссылки на репо и на сайт

Запуск (в этой папке):
  py deploy.py          (Windows)
  python3 deploy.py     (macOS / Linux)
"""

import json
import os
import subprocess
import sys
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path

CONFIG_FILE = "deploy.config.json"
ROOT = Path(__file__).resolve().parent

# --------------------------------------------------------------------
# Красивый вывод
# --------------------------------------------------------------------
if os.name == "nt":
    # Включаем ANSI-escape в cmd.exe / Windows Terminal
    os.system("")


class C:
    RESET = "\033[0m"
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    DIM = "\033[2m"


def info(msg):  print(f"{C.BLUE}→{C.RESET} {msg}")
def ok(msg):    print(f"{C.GREEN}✓{C.RESET} {msg}")
def warn(msg):  print(f"{C.YELLOW}⚠{C.RESET} {msg}")
def err(msg):   print(f"{C.RED}✗{C.RESET} {msg}")


def pause_and_exit(code=0):
    try:
        input(f"\n{C.DIM}Нажми Enter для выхода...{C.RESET}")
    except (EOFError, KeyboardInterrupt):
        pass
    sys.exit(code)


# --------------------------------------------------------------------
# Git helpers
# --------------------------------------------------------------------
def run_git(args, check=True, capture=False):
    return subprocess.run(
        ["git"] + args,
        cwd=str(ROOT),
        check=check,
        capture_output=capture,
        text=True,
    )


def git_silent(args):
    try:
        return subprocess.run(
            ["git"] + args,
            cwd=str(ROOT),
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        return None


def check_git_installed():
    if git_silent(["--version"]) is None:
        err("Git не установлен. Скачай с https://git-scm.com/ и перезапусти скрипт.")
        pause_and_exit(1)


# --------------------------------------------------------------------
# GitHub REST API
# --------------------------------------------------------------------
def gh_api(method, endpoint, token, data=None):
    url = f"https://api.github.com{endpoint}"
    body = json.dumps(data).encode("utf-8") if data is not None else None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "deploy.py",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8") or "{}"
            try:
                return resp.status, json.loads(raw)
            except Exception:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw
    except urllib.error.URLError as e:
        err(f"Нет связи с api.github.com: {e}")
        pause_and_exit(1)


# --------------------------------------------------------------------
# Config
# --------------------------------------------------------------------
CONFIG_TEMPLATE = {
    "github_username": "",
    "repository": "reader",
    "branch": "main",
    "private": False,
    "token": ""
}


def load_or_create_config():
    path = ROOT / CONFIG_FILE
    if not path.exists():
        path.write_text(
            json.dumps(CONFIG_TEMPLATE, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        warn(f"Создан шаблон {CONFIG_FILE}.")
        print()
        print(f"  Открой {C.BOLD}{CONFIG_FILE}{C.RESET} и заполни:")
        print(f"    {C.DIM}•{C.RESET} github_username — твой логин на GitHub")
        print(f"    {C.DIM}•{C.RESET} repository     — имя репо (например: reader)")
        print(f"    {C.DIM}•{C.RESET} token          — Personal Access Token (ghp_...)")
        print(f"    {C.DIM}•{C.RESET} private        — true если хочешь приватный, false если публичный")
        print()
        print(f"  Токен создаётся тут: {C.CYAN}https://github.com/settings/tokens/new{C.RESET}")
        print(f"  Права (scopes): {C.BOLD}repo{C.RESET}")
        print()
        print("  После заполнения запусти скрипт заново.")
        pause_and_exit(0)

    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        err(f"Не могу прочитать {CONFIG_FILE}: {e}")
        pause_and_exit(1)

    missing = [k for k in ("github_username", "repository", "token") if not cfg.get(k)]
    if missing:
        err(f"В {CONFIG_FILE} пустые поля: {', '.join(missing)}")
        pause_and_exit(1)

    cfg.setdefault("branch", "main")
    cfg.setdefault("private", False)
    return cfg


# --------------------------------------------------------------------
# .gitignore
# --------------------------------------------------------------------
def ensure_gitignore():
    gi = ROOT / ".gitignore"
    needed = [
        "deploy.config.json",
        ".env",
        "__pycache__/",
        "*.pyc",
    ]
    existing = gi.read_text(encoding="utf-8") if gi.exists() else ""
    to_add = [line for line in needed if line not in existing.splitlines()]
    if to_add:
        with open(gi, "a", encoding="utf-8") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            for line in to_add:
                f.write(line + "\n")
        ok(f".gitignore дополнен: {', '.join(to_add)}")


# --------------------------------------------------------------------
# Git init + remote
# --------------------------------------------------------------------
def ensure_git_repo(cfg):
    if not (ROOT / ".git").exists():
        info("Инициализирую git...")
        run_git(["init"])
        run_git(["branch", "-M", cfg["branch"]])
    # user.name / user.email — нужны для коммита
    if git_silent(["config", "user.email"]) is None:
        run_git(["config", "user.email", f"{cfg['github_username']}@users.noreply.github.com"])
    if git_silent(["config", "user.name"]) is None:
        run_git(["config", "user.name", cfg["github_username"]])


def ensure_remote(cfg):
    repo_url = (
        f"https://{cfg['token']}@github.com/"
        f"{cfg['github_username']}/{cfg['repository']}.git"
    )
    if git_silent(["remote", "get-url", "origin"]) is None:
        run_git(["remote", "add", "origin", repo_url])
    else:
        run_git(["remote", "set-url", "origin", repo_url])


# --------------------------------------------------------------------
# Проверка/создание репо на GitHub
# --------------------------------------------------------------------
def ensure_repo_exists(cfg):
    info(f"Проверяю репо {cfg['github_username']}/{cfg['repository']}...")
    code, _ = gh_api("GET", f"/repos/{cfg['github_username']}/{cfg['repository']}", cfg["token"])

    if code == 200:
        ok("Репо уже существует")
        return

    if code == 401:
        err("Неверный или просроченный токен. Сгенерируй новый:")
        err("  https://github.com/settings/tokens/new  (scope: repo)")
        pause_and_exit(1)

    if code == 404:
        info("Репо не найден — создаю через API...")
        code, resp = gh_api("POST", "/user/repos", cfg["token"], {
            "name": cfg["repository"],
            "private": bool(cfg["private"]),
            "description": "Minimal iOS 26 FB2 reader",
            "has_issues": False,
            "has_wiki": False,
            "auto_init": False,
        })
        if code == 201:
            kind = "приватный" if cfg["private"] else "публичный"
            ok(f"Репо создан ({kind})")
        else:
            err(f"Не смог создать репо (HTTP {code}): {resp}")
            pause_and_exit(1)
        return

    err(f"Неожиданный ответ GitHub API (HTTP {code})")
    pause_and_exit(1)


# --------------------------------------------------------------------
# Commit + push
# --------------------------------------------------------------------
def commit_all():
    run_git(["add", "-A"])
    status = git_silent(["status", "--porcelain"])
    has_head = git_silent(["rev-parse", "HEAD"]) is not None

    if has_head and (not status or not status.stdout.strip()):
        warn("Нет изменений — коммит пропущен")
        return False

    if not has_head:
        msg = "initial commit"
    else:
        msg = f"update {datetime.now().strftime('%Y-%m-%d %H:%M')}"

    try:
        run_git(["commit", "-m", msg])
        ok(f'Коммит: "{msg}"')
        return True
    except subprocess.CalledProcessError:
        warn("git commit ничего не создал")
        return False


def push(cfg):
    info("Пушу в GitHub...")
    try:
        run_git(["push", "-u", "origin", cfg["branch"]])
        ok("Запушено")
        return
    except subprocess.CalledProcessError:
        warn("Обычный push не прошёл — делаю force push")

    try:
        run_git(["push", "-u", "origin", cfg["branch"], "--force"])
        ok("Force push прошёл")
    except subprocess.CalledProcessError:
        err("Push не удался даже с --force. Проверь токен и имя репо.")
        pause_and_exit(1)


# --------------------------------------------------------------------
# GitHub Pages
# --------------------------------------------------------------------
def enable_pages(cfg):
    info("Включаю GitHub Pages...")
    endpoint = f"/repos/{cfg['github_username']}/{cfg['repository']}/pages"
    code, _ = gh_api("GET", endpoint, cfg["token"])

    if code == 200:
        # Уже включено — попробуем только убедиться, что источник правильный
        code2, _ = gh_api("PUT", endpoint, cfg["token"], {
            "source": {"branch": cfg["branch"], "path": "/"}
        })
        if code2 in (200, 204):
            ok("GitHub Pages уже включён (источник обновлён)")
        else:
            ok("GitHub Pages уже включён")
        return

    if code == 404:
        code2, resp = gh_api("POST", endpoint, cfg["token"], {
            "source": {"branch": cfg["branch"], "path": "/"}
        })
        if code2 in (201, 204):
            ok("GitHub Pages включён")
        elif code2 == 409 and cfg["private"]:
            warn("Для приватных репо Pages требует GitHub Pro.")
            warn("Сделай репо публичным (private: false в config) или подключи Pro.")
        else:
            warn(f"Pages не включился (HTTP {code2}). Включи вручную: Settings → Pages.")
        return

    warn(f"Не смог проверить Pages (HTTP {code}). Можешь включить вручную: Settings → Pages.")


# --------------------------------------------------------------------
# Main
# --------------------------------------------------------------------
def main():
    print()
    print(f"{C.BOLD}📦 Deploy → GitHub{C.RESET}")
    print()

    check_git_installed()
    cfg = load_or_create_config()
    ensure_gitignore()
    ensure_git_repo(cfg)
    ensure_repo_exists(cfg)
    ensure_remote(cfg)
    commit_all()
    push(cfg)
    enable_pages(cfg)

    repo_url = f"https://github.com/{cfg['github_username']}/{cfg['repository']}"
    pages_url = f"https://{cfg['github_username']}.github.io/{cfg['repository']}/"

    print()
    print(f"{C.GREEN}{C.BOLD}✅ Всё обновилось, можешь закрывать окно.{C.RESET}")
    print()
    print(f"   {C.DIM}Репо:{C.RESET} {C.CYAN}{repo_url}{C.RESET}")
    print(f"   {C.DIM}Сайт:{C.RESET} {C.CYAN}{pages_url}{C.RESET}")
    print()
    print(f"{C.DIM}Если сайт не открылся сразу — подожди 1-2 минуты, GitHub Pages собирается.{C.RESET}")
    pause_and_exit(0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
        warn("Прервано пользователем")
        pause_and_exit(1)
    except Exception as e:
        err(f"Неожиданная ошибка: {e}")
        import traceback
        traceback.print_exc()
        pause_and_exit(1)
