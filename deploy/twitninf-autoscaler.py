#!/usr/bin/env python3
"""Autoscaling borné par la RAM des répliques web TwitNinf sur le VPS A.

Une surcharge globale persistante ajoute les C un par un tant que la marge
mémoire le permet. Les processus créés ont toujours NODE_ROLE=web et ne peuvent
donc lancer ni PolicierCongo, ni cron, ni migration.
"""

from __future__ import annotations

import argparse
import fcntl
import itertools
import json
import math
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any


def env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


def env_float(name: str, default: float) -> float:
    return float(os.environ.get(name, str(default)))


APP_DIR = Path(os.environ.get("AUTOSCALE_APP_DIR", "/home/debian/api"))
SERVER_SCRIPT = os.environ.get("AUTOSCALE_SERVER_SCRIPT", "src/server.js")
PM2_USER = os.environ.get("AUTOSCALE_PM2_USER", "debian")
PM2_HOME = os.environ.get("AUTOSCALE_PM2_HOME", f"/home/{PM2_USER}/.pm2")
PM2_BIN = os.environ.get("AUTOSCALE_PM2_BIN", "/usr/bin/pm2")

UPSTREAM_INCLUDE = Path(
    os.environ.get(
        "AUTOSCALE_UPSTREAM_INCLUDE",
        "/etc/nginx/twitninf-autoscale-upstreams.conf",
    )
)
READ_ROUTING_INCLUDE = Path(
    os.environ.get(
        "AUTOSCALE_READ_ROUTING_INCLUDE",
        "/etc/nginx/twitninf-read-routing.map",
    )
)
METRICS_LOG = Path(
    os.environ.get("AUTOSCALE_METRICS_LOG", "/var/log/nginx/twitninf-upstream.log")
)
STATE_FILE = Path(
    os.environ.get("AUTOSCALE_STATE_FILE", "/var/lib/twitninf-autoscaler/state.json")
)
LOCK_FILE = Path(
    os.environ.get("AUTOSCALE_LOCK_FILE", "/run/lock/twitninf-autoscaler.lock")
)

HARD_MAX_REPLICAS = 32
MAX_REPLICAS = max(1, min(env_int("AUTOSCALE_MAX_REPLICAS", 32), HARD_MAX_REPLICAS))


def replica_port(index: int) -> int:
    # C1-C3 conservent leurs ports historiques. 3008-3099 ne sont pas réservés
    # à TwitNinf (3010 est déjà utilisé), donc C4+ vit dans une plage isolée.
    return 3004 + index if index <= 3 else 3100 + index


REPLICAS = tuple(
    {"name": f"twitninf-api-c{index}", "label": f"c{index}", "port": replica_port(index)}
    for index in range(1, MAX_REPLICAS + 1)
)
REPLICA_BY_LABEL = {str(item["label"]): item for item in REPLICAS}

WINDOW_SECONDS = env_int("AUTOSCALE_WINDOW_SECONDS", 30)
MIN_REQUESTS_PER_SIDE = env_int("AUTOSCALE_MIN_REQUESTS_PER_SIDE", 30)
HIGH_P95_SECONDS = env_float("AUTOSCALE_HIGH_P95_SECONDS", 0.8)
HIGH_ERROR_RATE = env_float("AUTOSCALE_HIGH_ERROR_RATE", 0.05)
READ_BIAS_P95_SECONDS = env_float("AUTOSCALE_READ_BIAS_P95_SECONDS", 0.4)
READ_BIAS_ERROR_RATE = env_float("AUTOSCALE_READ_BIAS_ERROR_RATE", 0.02)
READ_BIAS_HIGH_STREAK = env_int("AUTOSCALE_READ_BIAS_HIGH_STREAK", 2)
READ_BIAS_LOW_STREAK = env_int("AUTOSCALE_READ_BIAS_LOW_STREAK", 12)
# Comparaison B vs A, pas seuil absolu — voir `b_can_absorb_reads`.
READ_BIAS_B_P95_RATIO = env_float("AUTOSCALE_READ_BIAS_B_P95_RATIO", 0.9)
READ_BIAS_B_ERROR_MARGIN = env_float("AUTOSCALE_READ_BIAS_B_ERROR_MARGIN", 0.01)
LOW_P95_SECONDS = env_float("AUTOSCALE_LOW_P95_SECONDS", 0.3)
LOW_ERROR_RATE = env_float("AUTOSCALE_LOW_ERROR_RATE", 0.01)
HIGH_STREAK_REQUIRED = env_int("AUTOSCALE_HIGH_STREAK", 1)
LOW_STREAK_REQUIRED = env_int("AUTOSCALE_LOW_STREAK", 120)
SCALE_OUT_COOLDOWN = env_int("AUTOSCALE_OUT_COOLDOWN_SECONDS", 5)
SCALE_IN_COOLDOWN = env_int("AUTOSCALE_IN_COOLDOWN_SECONDS", 600)
MIN_AVAILABLE_BEFORE_MB = env_int("AUTOSCALE_MIN_AVAILABLE_BEFORE_MB", 4608)
MIN_AVAILABLE_AFTER_MB = env_int("AUTOSCALE_MIN_AVAILABLE_AFTER_MB", 3072)
REPLICA_MEMORY_BUDGET_MB = max(256, env_int("AUTOSCALE_REPLICA_MEMORY_BUDGET_MB", 1536))
MAX_SCALE_OUT_BATCH = max(1, min(env_int("AUTOSCALE_MAX_SCALE_OUT_BATCH", 1), 8))
START_TIMEOUT_SECONDS = env_int("AUTOSCALE_START_TIMEOUT_SECONDS", 75)
WARMUP_SECONDS = env_int("AUTOSCALE_WARMUP_SECONDS", 3)
DRAIN_SECONDS = env_int("AUTOSCALE_DRAIN_SECONDS", 15)
MAX_LOG_BYTES = env_int("AUTOSCALE_MAX_LOG_BYTES", 32 * 1024 * 1024)
MANUAL_LOCK_WAIT_SECONDS = env_int("AUTOSCALE_MANUAL_LOCK_WAIT_SECONDS", 10)
MANUAL_SCALE_OUT_PAUSE_SECONDS = env_int("AUTOSCALE_MANUAL_SCALE_OUT_PAUSE_SECONDS", 90)

BASE_A_ADDR = "127.0.0.1:3001"
BASE_B_ADDR = "10.8.0.2:3001"
LOCAL_ADDRS = {BASE_A_ADDR, *(f"127.0.0.1:{r['port']}" for r in REPLICAS)}


def emit(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, **fields}, sort_keys=True), flush=True)


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"commande échouée ({result.returncode}): {' '.join(command)}: {detail}")
    return result


def pm2(*args: str, process_env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    assignments = [f"PM2_HOME={PM2_HOME}"]
    assignments.extend(f"{key}={value}" for key, value in (process_env or {}).items())
    command = ["/usr/bin/sudo", "-u", PM2_USER, "/usr/bin/env", *assignments, PM2_BIN, *args]
    return run(command, check=check)


def pm2_processes() -> dict[str, dict[str, Any]]:
    result = pm2("jlist")
    start = result.stdout.find("[")
    if start < 0:
        raise RuntimeError("pm2 jlist n'a pas renvoyé de JSON")
    payload, _ = json.JSONDecoder().raw_decode(result.stdout[start:])
    return {str(item.get("name")): item for item in payload}


def is_pm2_online(processes: dict[str, dict[str, Any]], name: str) -> bool:
    item = processes.get(name, {})
    return item.get("pm2_env", {}).get("status") == "online"


def health(replica: dict[str, Any], timeout: float = 1.5) -> bool:
    # La readiness ne doit jamais dépendre de PostgreSQL, Redis ou d'un moteur
    # annexe. Sous forte charge, l'ancien /api/health expirait et faisait
    # retirer des C parfaitement vivants exactement au pire moment.
    url = f"http://127.0.0.1:{replica['port']}/api/health/live"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            body = json.load(response)
        return (
            response.status == 200
            and body.get("success") is True
            and body.get("role") == "web"
            and body.get("policiercongo_local") is False
            and body.get("instance") == f"autoscale-{replica['label']}"
        )
    except Exception:
        return False


def healthy_replicas(processes: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    processes = processes or pm2_processes()
    return [
        replica
        for replica in REPLICAS
        if is_pm2_online(processes, replica["name"]) and health(replica)
    ]


def configured_replicas(processes: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Répliques présentes dans Nginx et encore en ligne dans PM2, sans I/O DB."""
    processes = processes or pm2_processes()
    try:
        content = UPSTREAM_INCLUDE.read_text(encoding="utf-8")
    except FileNotFoundError:
        content = ""
    configured = {
        line.rsplit("#", 1)[1].strip().lower()
        for line in content.splitlines()
        if "#" in line
    }
    return [
        replica
        for replica in REPLICAS
        if replica["label"] in configured and is_pm2_online(processes, replica["name"])
    ]


def delete_orphan_replicas(
    processes: dict[str, dict[str, Any]], active: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Supprime les processus C que Nginx ne considère plus comme désirés.

    Cela répare notamment les lancements interrompus et empêche un ancien C
    sauvegardé par PM2 de revenir tout seul après un déploiement ou un reboot.
    """
    active_names = {str(replica["name"]) for replica in active}
    orphans = [
        replica
        for replica in REPLICAS
        if replica["name"] in processes and replica["name"] not in active_names
    ]
    for replica in orphans:
        delete_replica(replica)
    if orphans:
        save_pm2_state()
        emit("orphan_replicas_deleted", replicas=[item["label"] for item in orphans])
    return orphans


def upstream_content(replicas: list[dict[str, Any]]) -> str:
    lines = ["# Géré automatiquement par twitninf-autoscaler. Ne pas éditer.\n"]
    for replica in sorted(replicas, key=lambda item: item["port"]):
        lines.append(
            f"server 127.0.0.1:{replica['port']} weight=13 "
            f"max_fails=2 fail_timeout=10s; # {replica['label']}\n"
        )
    return "".join(lines)


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


def apply_upstreams(replicas: list[dict[str, Any]]) -> bool:
    new_content = upstream_content(replicas)
    old_content = UPSTREAM_INCLUDE.read_text(encoding="utf-8") if UPSTREAM_INCLUDE.exists() else ""
    if new_content == old_content:
        return True

    atomic_write(UPSTREAM_INCLUDE, new_content)
    tested = run(["/usr/sbin/nginx", "-t"], check=False)
    if tested.returncode != 0:
        atomic_write(UPSTREAM_INCLUDE, old_content)
        emit("nginx_rejected", error=(tested.stderr or tested.stdout).strip())
        return False

    reloaded = run(["/usr/bin/systemctl", "reload", "nginx"], check=False)
    if reloaded.returncode != 0:
        atomic_write(UPSTREAM_INCLUDE, old_content)
        run(["/usr/sbin/nginx", "-t"], check=False)
        run(["/usr/bin/systemctl", "reload", "nginx"], check=False)
        emit("nginx_reload_failed", error=(reloaded.stderr or reloaded.stdout).strip())
        return False

    emit("upstreams_applied", replicas=[item["label"] for item in replicas])
    return True


def read_bias_content(enabled: bool) -> str:
    lines = ["# Gere automatiquement par twitninf-autoscaler.\n"]
    if enabled:
        lines.extend(["GET twitninf_api_read;\n", "HEAD twitninf_api_read;\n"])
    return "".join(lines)


def read_bias_enabled() -> bool:
    try:
        return "twitninf_api_read" in READ_ROUTING_INCLUDE.read_text(encoding="utf-8")
    except FileNotFoundError:
        return False


def apply_read_bias(enabled: bool) -> bool:
    new_content = read_bias_content(enabled)
    old_content = READ_ROUTING_INCLUDE.read_text(encoding="utf-8") if READ_ROUTING_INCLUDE.exists() else ""
    if new_content == old_content:
        return True
    atomic_write(READ_ROUTING_INCLUDE, new_content)
    tested = run(["/usr/sbin/nginx", "-t"], check=False)
    if tested.returncode != 0:
        atomic_write(READ_ROUTING_INCLUDE, old_content)
        emit("read_bias_nginx_rejected", error=(tested.stderr or tested.stdout).strip())
        return False
    reloaded = run(["/usr/bin/systemctl", "reload", "nginx"], check=False)
    if reloaded.returncode != 0:
        atomic_write(READ_ROUTING_INCLUDE, old_content)
        run(["/usr/sbin/nginx", "-t"], check=False)
        run(["/usr/bin/systemctl", "reload", "nginx"], check=False)
        emit("read_bias_reload_failed", error=(reloaded.stderr or reloaded.stdout).strip())
        return False
    emit("read_bias_changed", enabled=enabled)
    return True


def mem_available_mb() -> int:
    for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    raise RuntimeError("MemAvailable absent de /proc/meminfo")


def additional_replica_capacity(active_count: int, available_mb: int | None = None) -> int:
    """Nombre de C encore lançables sans entamer la réserve système."""
    available_mb = mem_available_mb() if available_mb is None else available_mb
    if available_mb < MIN_AVAILABLE_BEFORE_MB:
        return 0
    memory_slots = max(0, (available_mb - MIN_AVAILABLE_AFTER_MB) // REPLICA_MEMORY_BUDGET_MB)
    return max(0, min(MAX_REPLICAS - active_count, memory_slots))


def wait_until_ready(replica: dict[str, Any]) -> bool:
    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    first_ready_at: float | None = None
    while time.monotonic() < deadline:
        if health(replica):
            if first_ready_at is None:
                first_ready_at = time.monotonic()
            if time.monotonic() - first_ready_at >= WARMUP_SECONDS:
                return True
        else:
            first_ready_at = None
        time.sleep(1)
    return False


def delete_replica(replica: dict[str, Any]) -> None:
    pm2("delete", replica["name"], check=False)


def save_pm2_state() -> None:
    # Sans sauvegarde, `pm2 resurrect` peut recréer un C retiré depuis des
    # heures. Le dump doit refléter chaque changement du parc élastique.
    pm2("save", "--force", check=False)


def launch_replica(replica: dict[str, Any]) -> bool:
    """Lance un processus sans l'exposer encore dans Nginx."""
    delete_replica(replica)
    process_env = {
        "PORT": str(replica["port"]),
        "HOST": "127.0.0.1",
        "NODE_ENV": "production",
        "NODE_ROLE": "web",
        "POLICIERCONGO_LOCAL_ENABLED": "false",
        "INSTANCE_ID": f"autoscale-{replica['label']}",
    }
    result = pm2(
        "start",
        str(APP_DIR / SERVER_SCRIPT),
        "--name",
        replica["name"],
        "--cwd",
        str(APP_DIR),
        "--time",
        "--kill-timeout",
        "10000",
        process_env=process_env,
        check=False,
    )
    if result.returncode == 0:
        return True
    emit("scale_out_start_failed", replica=replica["label"], error=(result.stderr or result.stdout).strip())
    delete_replica(replica)
    return False


def wait_until_replicas_ready(
    replicas: list[dict[str, Any]], warmup_seconds: int = WARMUP_SECONDS
) -> list[dict[str, Any]]:
    """Attend plusieurs demarrages en parallele, puis rend les C stables."""
    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    first_ready_at: dict[str, float] = {}
    ready: list[dict[str, Any]] = []
    while time.monotonic() < deadline and len(ready) < len(replicas):
        for replica in replicas:
            label = str(replica["label"])
            if replica in ready:
                continue
            if health(replica):
                first_ready_at.setdefault(label, time.monotonic())
                if time.monotonic() - first_ready_at[label] >= warmup_seconds:
                    ready.append(replica)
            else:
                first_ready_at.pop(label, None)
        if len(ready) < len(replicas):
            # Sondage a 250 ms et non a 1 s. Un C repond a /api/health/live en
            # ~1,6 s : a 1 s de granularite, on perdait jusqu'a une seconde a
            # le constater, puis la meme granularite s'appliquait a chaque pas
            # du warmup. La sonde ne touche ni PostgreSQL ni Redis, elle ne
            # coute donc rien au noeud qui demarre.
            time.sleep(0.25)
    return ready


def start_replicas(
    replicas: list[dict[str, Any]],
    current: list[dict[str, Any]],
    warmup_seconds: int = WARMUP_SECONDS,
) -> list[dict[str, Any]]:
    if not replicas:
        return []
    available_before = mem_available_mb()
    capacity = additional_replica_capacity(len(current), available_before)
    replicas = replicas[:capacity]
    if not replicas:
        emit(
            "scale_out_blocked_memory",
            available_mb=available_before,
            reserved_mb=MIN_AVAILABLE_AFTER_MB,
            replica_budget_mb=REPLICA_MEMORY_BUDGET_MB,
        )
        return []

    launched = [replica for replica in replicas if launch_replica(replica)]
    ready = wait_until_replicas_ready(launched, warmup_seconds)
    failed = [replica for replica in launched if replica not in ready]
    for replica in failed:
        emit("scale_out_health_failed", replica=replica["label"])
        delete_replica(replica)
    if not ready:
        if launched:
            save_pm2_state()
        return []

    available_after = mem_available_mb()
    if available_after < MIN_AVAILABLE_AFTER_MB:
        emit(
            "scale_out_rolled_back_memory",
            replicas=[replica["label"] for replica in ready],
            available_mb=available_after,
            required_mb=MIN_AVAILABLE_AFTER_MB,
        )
        for replica in ready:
            delete_replica(replica)
        save_pm2_state()
        return []

    if not apply_upstreams([*current, *ready]):
        for replica in ready:
            delete_replica(replica)
        save_pm2_state()
        return []

    save_pm2_state()
    for replica in ready:
        emit(
            "scaled_out",
            replica=replica["label"],
            port=replica["port"],
            available_mb=available_after,
        )
    return ready


def start_replica(
    replica: dict[str, Any], current: list[dict[str, Any]], warmup_seconds: int = 0
) -> bool:
    return bool(start_replicas([replica], current, warmup_seconds))


def stop_replica(
    replica: dict[str, Any],
    remaining: list[dict[str, Any]],
    drain_seconds: int = DRAIN_SECONDS,
) -> bool:
    if not apply_upstreams(remaining):
        return False
    if drain_seconds > 0:
        time.sleep(drain_seconds)
    delete_replica(replica)
    save_pm2_state()
    emit("scaled_in", replica=replica["label"], port=replica["port"])
    return True


def restart_replica(replica: dict[str, Any], active: list[dict[str, Any]]) -> bool:
    """Retire une réplique du trafic, la redémarre puis la réinsère saine."""
    remaining = [item for item in active if item != replica]
    if not apply_upstreams(remaining):
        return False
    # Une action opérateur doit être immédiate. Nginx retire d'abord le C ;
    # les rares requêtes encore en vol peuvent être rejouées sur A/B.
    delete_replica(replica)
    changed = start_replica(replica, remaining)
    if changed:
        emit("restarted", replica=replica["label"], port=replica["port"])
    return changed


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil(fraction * len(ordered)) - 1)
    return ordered[index]


def split_upstream_field(value: Any) -> list[str]:
    return [part.strip() for part in str(value or "").split(",")]


def recent_attempts() -> list[dict[str, Any]]:
    if not METRICS_LOG.exists():
        return []
    size = METRICS_LOG.stat().st_size
    with METRICS_LOG.open("rb") as handle:
        if size > MAX_LOG_BYTES:
            handle.seek(size - MAX_LOG_BYTES)
            handle.readline()
        raw = handle.read()

    cutoff = time.time() - WINDOW_SECONDS
    attempts: list[dict[str, Any]] = []
    for raw_line in raw.splitlines():
        try:
            row = json.loads(raw_line)
            if float(row.get("ts", 0)) < cutoff:
                continue
            addresses = split_upstream_field(row.get("addr"))
            statuses = split_upstream_field(row.get("status"))
            response_times = split_upstream_field(row.get("rt"))
            for address, status, response_time in itertools.zip_longest(
                addresses, statuses, response_times, fillvalue="-"
            ):
                if address not in LOCAL_ADDRS and address != BASE_B_ADDR:
                    continue
                try:
                    status_code = int(status)
                except (TypeError, ValueError):
                    status_code = 0
                try:
                    latency = float(response_time)
                except (TypeError, ValueError):
                    latency = None
                attempts.append(
                    {
                        "side": "a" if address in LOCAL_ADDRS else "b",
                        "address": address,
                        "status": status_code,
                        "latency": latency,
                    }
                )
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return attempts


def stats(attempts: list[dict[str, Any]]) -> dict[str, Any]:
    latencies = [item["latency"] for item in attempts if item["latency"] is not None]
    errors = sum(1 for item in attempts if item["status"] == 0 or item["status"] >= 500)
    count = len(attempts)
    return {
        "requests": count,
        "rps": round(count / WINDOW_SECONDS, 2),
        "p95_seconds": round(percentile(latencies, 0.95), 4),
        "error_rate": round(errors / count, 4) if count else 0.0,
    }


def overloaded(summary: dict[str, Any], minimum: int) -> bool:
    return summary["requests"] >= minimum and (
        summary["p95_seconds"] >= HIGH_P95_SECONDS
        or summary["error_rate"] >= HIGH_ERROR_RATE
    )


def semi_overloaded(summary: dict[str, Any], minimum: int) -> bool:
    return summary["requests"] >= minimum and (
        summary["p95_seconds"] >= READ_BIAS_P95_SECONDS
        or summary["error_rate"] >= READ_BIAS_ERROR_RATE
    )


def b_can_absorb_reads(a: dict[str, Any], b: dict[str, Any], minimum: int) -> bool:
    """B est-il en meilleur etat que A, donc capable d'en prendre davantage ?

    Le garde-fou d'origine etait `not overloaded(b)` — un seuil ABSOLU, le meme
    que pour A. Sous une vraie surcharge, B franchit ce seuil en meme temps que
    A, tout simplement parce que ses dependances (Redis, recommandeur Rust)
    vivent sur A : quand A sature, B ralentit par ricochet. Le report de lecture
    etait donc neutralise exactement quand il servait a quelque chose.

    Releve du 2026-08-07 (1 000 VU) pendant lequel il ne s'est jamais declenche :

        A : p95 7,4-9,9 s, jusqu'a 4,8 % d'erreurs
        B : p95 3,6-5,3 s, 0 % d'erreurs

    B etait deux fois plus rapide que A et sans une seule erreur, et pourtant
    juge « surcharge ». La bonne question n'est pas « B va-t-il bien ? » mais
    « B va-t-il mieux que A ? » : deplacer des lectures d'un noeud vers un noeud
    moins bon serait absurde, les deplacer vers un noeud meilleur reste utile
    meme si aucun des deux n'est confortable.
    """
    if b["requests"] < minimum:
        # Trop peu d'echantillons pour comparer honnetement : on s'abstient.
        return False
    if b["error_rate"] > a["error_rate"] + READ_BIAS_B_ERROR_MARGIN:
        # B casse plus que A : lui envoyer plus de trafic aggraverait le total.
        return False
    return b["p95_seconds"] <= a["p95_seconds"] * READ_BIAS_B_P95_RATIO


def load_state() -> dict[str, Any]:
    defaults = {
        "high_streak": 0,
        "low_streak": 0,
        "last_action": 0.0,
        "disabled_replicas": [],
        "scale_out_suppressed_until": 0.0,
        "read_bias_high_streak": 0,
        "read_bias_low_streak": 0,
    }
    try:
        loaded = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        defaults.update(loaded)
    except (FileNotFoundError, json.JSONDecodeError, TypeError):
        pass
    defaults["disabled_replicas"] = sorted({
        str(label).lower()
        for label in defaults.get("disabled_replicas", [])
        if str(label).lower() in REPLICA_BY_LABEL
    })
    return defaults


def save_state(state: dict[str, Any]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(STATE_FILE, json.dumps(state, sort_keys=True) + "\n")


def snapshot(active: list[dict[str, Any]]) -> dict[str, Any]:
    attempts = recent_attempts()
    a_stats = stats([item for item in attempts if item["side"] == "a"])
    b_stats = stats([item for item in attempts if item["side"] == "b"])
    all_stats = stats(attempts)
    backend_addresses = {
        "A": BASE_A_ADDR,
        "B": BASE_B_ADDR,
        **{item["label"].upper(): f"127.0.0.1:{item['port']}" for item in REPLICAS},
    }
    backends = {
        label: stats([item for item in attempts if item["address"] == address])
        for label, address in backend_addresses.items()
    }
    available_mb = mem_available_mb()
    state = load_state()
    disabled_replicas = state.get("disabled_replicas", [])
    suppressed_until = float(state.get("scale_out_suppressed_until", 0.0))
    return {
        "active_replicas": [item["label"] for item in active],
        "disabled_replicas": disabled_replicas,
        "scale_out_pause_remaining_seconds": max(0, math.ceil(suppressed_until - time.time())),
        "max_replicas": MAX_REPLICAS,
        "additional_replica_capacity": additional_replica_capacity(len(active), available_mb),
        "memory_available_mb": available_mb,
        "memory_reserved_mb": MIN_AVAILABLE_AFTER_MB,
        "replica_memory_budget_mb": REPLICA_MEMORY_BUDGET_MB,
        "a": a_stats,
        "b": b_stats,
        "all": all_stats,
        "backends": backends,
        "read_bias_active": read_bias_enabled(),
    }


def status_once() -> int:
    # Le panel interroge toutes les deux secondes. Cette lecture ne prend jamais
    # le verrou du scaling et ne sonde pas /api/health (qui interroge la DB).
    # Elle ne peut donc ni retarder ni annuler un cycle automatique.
    active = configured_replicas(pm2_processes())
    emit("status", **snapshot(active))
    return 0


def autoscale(action: str, replica_label: str | None = None) -> int:
    if action == "pause":
        seconds = max(0, min(int(replica_label or 0), 3600))
        state = load_state()
        until = max(float(state.get("scale_out_suppressed_until", 0.0)), time.time() + seconds)
        state["scale_out_suppressed_until"] = until
        save_state(state)
        emit("scale_out_paused", seconds=seconds, until=until)
        return 0

    processes = pm2_processes()
    # Le fichier Nginx est la source de vérité des C désirés. Un probe
    # temporairement lent ne doit jamais vider le répartiteur sous charge.
    active = configured_replicas(processes)
    if not apply_upstreams(active):
        return 1
    delete_orphan_replicas(processes, active)

    state = load_state()
    now = time.time()

    if action in {"start", "restart", "delete"}:
        target = REPLICA_BY_LABEL.get(str(replica_label or "").lower())
        if target is None:
            emit("replica_action_rejected", action=action, replica=replica_label)
            return 1
        disabled = set(state.get("disabled_replicas", []))
        if action == "start":
            # "Démarrer" réactive explicitement ce numéro pour les futurs
            # cycles automatiques, même si sa création immédiate échoue.
            disabled.discard(str(target["label"]))
            state["disabled_replicas"] = sorted(disabled)
            if target in active:
                save_state(state)
                emit("start_skipped", reason="réplique déjà active", replica=target["label"])
                return 0
            changed = start_replica(target, active)
        elif action == "restart":
            if target not in active:
                emit("restart_skipped", reason="réplique inactive", replica=target["label"])
                return 1
            changed = restart_replica(target, active)
        else:
            # Un arrêt opérateur doit tenir : sans ce marqueur, les mesures
            # encore chaudes sur 30 s recréaient le même C cinq secondes après.
            disabled.add(str(target["label"]))
            state["disabled_replicas"] = sorted(disabled)
            state["scale_out_suppressed_until"] = max(
                float(state.get("scale_out_suppressed_until", 0.0)),
                now + MANUAL_SCALE_OUT_PAUSE_SECONDS,
            )
            if target not in active:
                save_state(state)
                emit("delete_skipped", reason="réplique déjà inactive et désactivée", replica=target["label"])
                return 0
            changed = stop_replica(
                target, [item for item in active if item != target], drain_seconds=0
            )
        if changed:
            state.update({"high_streak": 0, "low_streak": 0, "last_action": now})
        save_state(state)
        return 0 if changed else 1

    report = snapshot(active)

    if action == "force-up":
        disabled = set(state.get("disabled_replicas", []))
        target = next(
            (item for item in REPLICAS if item not in active and item["label"] not in disabled),
            None,
        )
        if target is None:
            emit("force_up_skipped", reason="maximum déjà actif", **report)
            return 0
        if additional_replica_capacity(len(active), report["memory_available_mb"]) <= 0:
            emit("force_up_skipped", reason="marge mémoire insuffisante", **report)
            return 0
        changed = start_replica(target, active)
        if changed:
            state.update({"high_streak": 0, "low_streak": 0, "last_action": now})
            save_state(state)
        return 0 if changed else 1

    if action == "force-down":
        if not active:
            emit("force_down_skipped", reason="aucune réplique active", **report)
            return 0
        target = max(active, key=lambda item: item["port"])
        remaining = [item for item in active if item != target]
        changed = stop_replica(target, remaining, drain_seconds=0)
        if changed:
            disabled = set(state.get("disabled_replicas", []))
            disabled.add(str(target["label"]))
            state.update({"high_streak": 0, "low_streak": 0, "last_action": now})
            state["disabled_replicas"] = sorted(disabled)
            state["scale_out_suppressed_until"] = max(
                float(state.get("scale_out_suppressed_until", 0.0)),
                now + MANUAL_SCALE_OUT_PAUSE_SECONDS,
            )
            save_state(state)
        return 0 if changed else 1

    a_high = overloaded(report["a"], MIN_REQUESTS_PER_SIDE)
    b_high = overloaded(report["b"], MIN_REQUESTS_PER_SIDE)
    overall_high = overloaded(report["all"], MIN_REQUESTS_PER_SIDE * 2)
    a_semi_high = semi_overloaded(report["a"], MIN_REQUESTS_PER_SIDE)
    wants_read_bias = a_semi_high and b_can_absorb_reads(
        report["a"], report["b"], MIN_REQUESTS_PER_SIDE
    )
    if wants_read_bias:
        state["read_bias_high_streak"] = int(state.get("read_bias_high_streak", 0)) + 1
        state["read_bias_low_streak"] = 0
    else:
        state["read_bias_high_streak"] = 0
        state["read_bias_low_streak"] = int(state.get("read_bias_low_streak", 0)) + 1
    bias_active = read_bias_enabled()
    if not bias_active and state["read_bias_high_streak"] >= READ_BIAS_HIGH_STREAK:
        if apply_read_bias(True):
            bias_active = True
            state["read_bias_high_streak"] = 0
    elif bias_active and state["read_bias_low_streak"] >= READ_BIAS_LOW_STREAK:
        if apply_read_bias(False):
            bias_active = False
            state["read_bias_low_streak"] = 0
    # Ajouter un C soulage le cluster dès que le trafic global est en détresse,
    # même si A ou B n'a pas atteint seul le minimum d'échantillons.
    wants_scale_out = overall_high

    if wants_scale_out:
        state["high_streak"] = int(state.get("high_streak", 0)) + 1
    else:
        state["high_streak"] = 0

    enough_traffic = report["all"]["requests"] >= MIN_REQUESTS_PER_SIDE * 2
    is_low = not enough_traffic or (
        report["all"]["p95_seconds"] <= LOW_P95_SECONDS
        and report["all"]["error_rate"] <= LOW_ERROR_RATE
    )
    state["low_streak"] = int(state.get("low_streak", 0)) + 1 if is_low else 0

    since_action = now - float(state.get("last_action", 0))
    changed = False
    if (
        state["high_streak"] >= HIGH_STREAK_REQUIRED
        and len(active) < MAX_REPLICAS
        and since_action >= SCALE_OUT_COOLDOWN
        and now >= float(state.get("scale_out_suppressed_until", 0.0))
    ):
        disabled = set(state.get("disabled_replicas", []))
        missing = [
            item for item in REPLICAS
            if item not in active and item["label"] not in disabled
        ]
        capacity = additional_replica_capacity(len(active), report["memory_available_mb"])
        catastrophic = (
            report["all"]["error_rate"] >= max(0.10, HIGH_ERROR_RATE * 2)
            or report["all"]["p95_seconds"] >= max(2.0, HIGH_P95_SECONDS * 2)
        )
        # Les C démarrent un par un. Plusieurs Node lourds lancés ensemble ont
        # déjà saturé A avant qu'aucun ne soit prêt. Les cycles suivants
        # continuent tant que la charge et la vraie marge RAM le justifient.
        requested = MAX_SCALE_OUT_BATCH if catastrophic else 1
        targets = missing[:min(requested, capacity)]
        emit(
            "scale_out_requested",
            replicas=[item["label"] for item in targets],
            catastrophic=catastrophic,
            memory_capacity=capacity,
        )
        changed = bool(start_replicas(targets, active))
    elif (
        active
        and state["low_streak"] >= LOW_STREAK_REQUIRED
        and since_action >= SCALE_IN_COOLDOWN
    ):
        target = max(active, key=lambda item: item["port"])
        changed = stop_replica(target, [item for item in active if item != target])

    if changed:
        state.update({"high_streak": 0, "low_streak": 0, "last_action": now})
    save_state(state)
    # `snapshot()` place deja `read_bias_active` dans le rapport, mais il l'a lu
    # AVANT que ce cycle ne decide de l'activer ou de le couper. C'est la valeur
    # d'apres la decision qui interesse le lecteur, donc elle ecrase celle du
    # rapport — en l'ecrivant dans le dictionnaire plutot qu'en la passant en
    # plus, sans quoi Python leve `got multiple values for keyword argument`.
    payload = dict(report)
    payload["read_bias_active"] = bias_active
    emit(
        "evaluated",
        a_overloaded=a_high,
        b_overloaded=b_high,
        overall_overloaded=overall_high,
        a_semi_overloaded=a_semi_high,
        high_streak=state["high_streak"],
        low_streak=state["low_streak"],
        changed=changed,
        **payload,
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--status", action="store_true")
    group.add_argument("--force-up", action="store_true")
    group.add_argument("--force-down", action="store_true")
    group.add_argument("--start", choices=sorted(REPLICA_BY_LABEL))
    group.add_argument("--restart", choices=sorted(REPLICA_BY_LABEL))
    group.add_argument("--delete", choices=sorted(REPLICA_BY_LABEL))
    group.add_argument("--pause", type=int, metavar="SECONDS")
    args = parser.parse_args()
    if args.status:
        action, replica_label = "status", None
    elif args.force_up:
        action, replica_label = "force-up", None
    elif args.force_down:
        action, replica_label = "force-down", None
    elif args.start:
        action, replica_label = "start", args.start
    elif args.restart:
        action, replica_label = "restart", args.restart
    elif args.delete:
        action, replica_label = "delete", args.delete
    elif args.pause is not None:
        action, replica_label = "pause", str(args.pause)
    else:
        action, replica_label = "once", None

    if action == "status":
        try:
            return status_once()
        except Exception as error:
            emit("fatal", error=str(error))
            return 1

    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_FILE.open("w", encoding="ascii") as lock:
        if action == "once":
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                emit("skipped", reason="une évaluation est déjà en cours")
                return 0
        else:
            # Les boutons admin ne doivent pas perdre leur commande quand un
            # cycle de 5 s possède déjà le verrou. Ils patientent dans leur
            # processus détaché puis l'exécutent, dans l'ordre.
            deadline = time.monotonic() + MANUAL_LOCK_WAIT_SECONDS
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        emit("manual_action_timeout", action=action, replica=replica_label)
                        return 1
                    time.sleep(0.25)
        try:
            return autoscale(action, replica_label)
        except Exception as error:
            emit("fatal", error=str(error))
            return 1


if __name__ == "__main__":
    sys.exit(main())
